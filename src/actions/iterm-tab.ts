import streamDeck, {
	action,
	KeyDownEvent,
	SingletonAction,
	WillAppearEvent,
	WillDisappearEvent,
} from "@elgato/streamdeck";
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const exec = promisify(execFile);

const POLL_INTERVAL_MS = 3000;

// After a macOS notification from iTerm2, how many polls to watch for
// tabs transitioning from processing to idle.
// 4 polls * 3s = 12 seconds.
const NOTIFICATION_WINDOW_POLLS = 4;

type TabSettings = {
	tabIndex?: number;
};

type TrackedAction = {
	action: WillAppearEvent["action"];
	tabIndex: number;
};

type TabInfo = {
	names: string[];
	activeIndex: number;
	prompts: boolean[];
	processing: boolean[];
	frontmost: boolean;
	ttys: string[];
};

const visibleActions = new Map<string, TrackedAction>();
let pollTimer: NodeJS.Timeout | null = null;

// Attention state
const attentionTabs = new Set<number>();
let pollCount = 0;

// Shell prompt tracking (for regular shell tabs)
const prevPromptState = new Map<number, boolean>();

// Processing tracking (for notification correlation)
const lastProcessingPoll = new Map<number, number>();
const prevProcessingState = new Map<number, boolean>();

// Notification monitoring via macOS unified log
let logStreamProcess: ChildProcess | null = null;
let notificationPending = false;
let notificationProject: string | null = null;
let notificationWindowEnd = -1;

// HeyAgent notification event file for project correlation
const NOTIFICATION_EVENT_FILE = join(homedir(), ".heyagent", "last-notification.json");

// Polling state
let pollInProgress = false;

// Performance tracking
let pollDurations: number[] = [];

// -- macOS notification monitoring --
//
// Instead of guessing when a tab needs attention via silence heuristics,
// we watch the macOS unified log for real notification deliveries from
// iTerm2. When one fires, we correlate it with tab state to figure out
// which tab likely triggered it.

const DEFAULT_NOTIFICATION_MATCHERS = [
	"com.googlecode.iterm2",
	"heyagent",
	"HeyAgent",
];

const NOTIFICATION_MATCHERS = (process.env.ITERM_TABS_NOTIFICATION_MATCHERS ||
	DEFAULT_NOTIFICATION_MATCHERS.join(","))
	.split(",")
	.map((s) => s.trim())
	.filter((s) => s.length > 0);

function readNotificationEvent(): { project: string; timestamp: number } | null {
	try {
		const raw = readFileSync(NOTIFICATION_EVENT_FILE, "utf-8");
		const data = JSON.parse(raw);
		if (data.project && data.timestamp && Date.now() - data.timestamp < 5000) {
			return data;
		}
	} catch {
		// File missing or corrupted
	}
	return null;
}

function matchesProject(tabFullName: string, project: string): boolean {
	const { displayName } = parseTabName(tabFullName);
	return displayName.toLowerCase().includes(project.toLowerCase());
}

function buildLogPredicate(): string {
	if (NOTIFICATION_MATCHERS.length === 0) {
		streamDeck.logger.warn(
			"No notification matchers configured - notification monitoring disabled"
		);
		// Return a predicate that never matches
		return `process == "usernoted" AND eventMessage CONTAINS "___ITERM_TABS_DISABLED___"`;
	}
	const clauses = NOTIFICATION_MATCHERS.map(
		(m) => `eventMessage CONTAINS "${m.replace(/"/g, '\\"')}"`
	);
	return `process == "usernoted" AND (${clauses.join(" OR ")})`;
}

function startLogStream(): void {
	if (logStreamProcess) return;

	try {
		logStreamProcess = spawn("log", [
			"stream",
			"--predicate",
			buildLogPredicate(),
			"--level",
			"info",
		]);

		let buffer = "";
		logStreamProcess.stdout?.on("data", (chunk: Buffer) => {
			buffer += chunk.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";

			for (const line of lines) {
				if (
					line.startsWith("Filtering") ||
					line.startsWith("Timestamp") ||
					line.trim() === ""
				)
					continue;
				if (NOTIFICATION_MATCHERS.length === 0) continue;
				if (!NOTIFICATION_MATCHERS.some((m) => line.includes(m)))
					continue;
				if (!notificationPending) {
					const event = readNotificationEvent();
					notificationProject = event?.project ?? null;
					notificationPending = true;
					streamDeck.logger.info(
						`Notification detected${notificationProject ? ` (project: ${notificationProject})` : ""} - triggering immediate poll`
					);
					// Don't wait for the next 3s cycle
					pollTabs();
				}
			}
		});

		logStreamProcess.stderr?.on("data", (chunk: Buffer) => {
			streamDeck.logger.warn(
				`log stream stderr: ${chunk.toString().trim()}`
			);
		});

		logStreamProcess.on("error", (err) => {
			streamDeck.logger.warn(`log stream error: ${err.message}`);
			logStreamProcess = null;
		});

		logStreamProcess.on("exit", (code) => {
			streamDeck.logger.info(`log stream exited with code ${code}`);
			logStreamProcess = null;
		});

		streamDeck.logger.info("Started macOS log stream for iTerm2 notifications");
	} catch (err) {
		streamDeck.logger.warn(`Failed to start log stream: ${err}`);
	}
}

function stopLogStream(): void {
	if (logStreamProcess) {
		logStreamProcess.kill();
		logStreamProcess = null;
		streamDeck.logger.info("Stopped macOS log stream");
	}
}

// -- Tab name parsing --

function parseTabName(fullName: string): { displayName: string; process: string } {
	const match = fullName.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
	if (match) {
		return { displayName: match[1].trim(), process: match[2].trim() };
	}
	return { displayName: fullName, process: "" };
}

// -- Program detection --

// Fallback: detect program from the process name shown in the tab title.
function detectProgramFromName(process: string): string {
	const p = process.toLowerCase().replace(/^-/, "");
	if (p.includes("codex")) return "codex";
	if (p.includes("claude")) return "claude";
	if (p.includes("python")) return "python";
	if (p.includes("node") || p.includes("npm") || p.includes("npx")) return "node";
	if (p.includes("ssh")) return "ssh";
	if (p.includes("vim") || p.includes("nvim")) return "vim";
	if (p.includes("zsh") || p.includes("bash") || p.includes("fish")) return "shell";
	return "other";
}

// Fetch raw `ps` output for all processes (run in parallel with AppleScript).
async function getRawProcessData(): Promise<string> {
	try {
		const { stdout } = await exec("ps", [
			"-e",
			"-o",
			"tty=,stat=,command=",
		]);
		return stdout;
	} catch {
		return "";
	}
}

// Match tty list against pre-fetched ps output to detect actual programs.
function matchTtyPrograms(
	ttys: string[],
	psOutput: string
): Map<number, string> {
	const result = new Map<number, string>();
	if (ttys.length === 0 || !psOutput) return result;

	// Group foreground process command lines by tty
	const fgByTty = new Map<string, string[]>();
	for (const line of psOutput.split("\n")) {
		const match = line.match(/^\s*(\S+)\s+(\S+)\s+(.+)$/);
		if (!match) continue;
		const [, tty, stat, cmd] = match;
		if (!stat.includes("+")) continue;
		if (!fgByTty.has(tty)) fgByTty.set(tty, []);
		fgByTty.get(tty)!.push(cmd);
	}

	for (let i = 0; i < ttys.length; i++) {
		const tty = ttys[i].replace("/dev/", "");
		const cmds = fgByTty.get(tty);
		if (!cmds) continue;

		const combined = cmds.join(" ").toLowerCase();

		// Order matters: check specific tools before generic runtimes
		if (
			combined.includes("claude") ||
			combined.includes(".local/share/claude/")
		) {
			result.set(i + 1, "claude");
		} else if (combined.includes("codex")) {
			result.set(i + 1, "codex");
		} else if (combined.includes("ssh ")) {
			result.set(i + 1, "ssh");
		} else if (combined.includes("vim") || combined.includes("nvim")) {
			result.set(i + 1, "vim");
		}
	}

	return result;
}

// -- Badge colors and icons --

function getBadgeColor(program: string): string {
	switch (program) {
		case "claude":
			return "#D4A574";
		case "codex":
			return "#E86E2C";
		case "python":
			return "#306998";
		case "node":
			return "#339933";
		case "ssh":
			return "#DC2626";
		case "vim":
			return "#019833";
		case "shell":
			return "#6B7280";
		default:
			return "#6B7280";
	}
}

// Returns SVG elements for the badge icon area, centered at (72, 25).
function renderBadge(program: string): string {
	const color = getBadgeColor(program);
	const bg = `<circle cx="72" cy="25" r="16" fill="${color}"/>`;

	switch (program) {
		case "claude":
			// Sparkle / 4-pointed star
			return (
				bg +
				`<path d="M72,15C73.5,21 75.5,23 81,25 75.5,27 73.5,29 72,35 70.5,29 68.5,27 63,25 68.5,23 70.5,21 72,15Z" fill="white"/>`
			);
		case "codex":
			// Diamond outline with center dot
			return (
				bg +
				`<path d="M72,15L82,25 72,35 62,25Z" fill="none" stroke="white" stroke-width="2"/>` +
				`<circle cx="72" cy="25" r="2.5" fill="white"/>`
			);
		case "python":
			// Two offset interlocking circles (simplified Python logo)
			return (
				bg +
				`<circle cx="69.5" cy="22.5" r="5" fill="none" stroke="white" stroke-width="2"/>` +
				`<circle cx="74.5" cy="27.5" r="5" fill="none" stroke="white" stroke-width="2"/>`
			);
		case "node":
			// Hexagon
			return (
				bg +
				`<path d="M72,15L81,20 81,30 72,35 63,30 63,20Z" fill="none" stroke="white" stroke-width="2"/>`
			);
		case "ssh":
			// Padlock
			return (
				bg +
				`<rect x="66" y="26" width="12" height="8" rx="1.5" fill="white"/>` +
				`<path d="M68.5,26V22.5A3.5,3.5 0 0 1 75.5,22.5V26" fill="none" stroke="white" stroke-width="2"/>`
			);
		case "vim":
			// V chevron
			return (
				bg +
				`<path d="M63,17L72,33 81,17" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`
			);
		case "shell":
			// >_ terminal prompt
			return (
				bg +
				`<text x="72" y="30.5" text-anchor="middle" fill="white" font-family="Menlo,monospace" font-size="16" font-weight="bold">&gt;_</text>`
			);
		default:
			return (
				bg +
				`<text x="72" y="30.5" text-anchor="middle" fill="white" font-family="-apple-system,SF Pro,Helvetica,sans-serif" font-size="16" font-weight="bold">?</text>`
			);
	}
}

// -- Text wrapping --

function wrapText(text: string, maxChars: number, maxLines: number): string[] {
	if (text.length <= maxChars) return [text];

	const words = text.split(/\s+/);
	const lines: string[] = [];
	let current = "";

	for (const word of words) {
		if (current === "") {
			current = word;
		} else if ((current + " " + word).length <= maxChars) {
			current += " " + word;
		} else {
			if (current.length > maxChars) {
				lines.push(current.slice(0, maxChars - 1) + "\u2026");
			} else {
				lines.push(current);
			}
			current = word;
			if (lines.length >= maxLines - 1) break;
		}
	}

	if (lines.length < maxLines && current) {
		if (current.length > maxChars) {
			lines.push(current.slice(0, maxChars - 1) + "\u2026");
		} else {
			lines.push(current);
		}
	} else if (lines.length >= maxLines && current) {
		const last = lines[lines.length - 1];
		const combined = last + " " + current;
		if (combined.length > maxChars) {
			lines[lines.length - 1] = combined.slice(0, maxChars - 1) + "\u2026";
		} else {
			lines[lines.length - 1] = combined;
		}
	}

	return lines;
}

// -- SVG rendering --

function escapeXml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function renderButton(opts: {
	tabName: string;
	program: string;
	isActive: boolean;
	hasAttention: boolean;
}): string {
	const { tabName, program, isActive, hasAttention } = opts;

	const bgColor = hasAttention ? "#6B3A10" : "#000000";
	const textColor = isActive || hasAttention ? "#FFFFFF" : "#D1D5DB";
	const badge = renderBadge(program);

	// Pick the largest font where the text wraps without truncation.
	const fontTiers = [
		{ fontSize: 24, maxChars: 9, lineHeight: 28 },
		{ fontSize: 20, maxChars: 11, lineHeight: 25 },
		{ fontSize: 18, maxChars: 12, lineHeight: 23 },
	];

	let tier = fontTiers[fontTiers.length - 1];
	for (const t of fontTiers) {
		const attempt = wrapText(tabName, t.maxChars, 3);
		if (!attempt.some((l) => l.endsWith("\u2026"))) {
			tier = t;
			break;
		}
	}

	const lines = wrapText(tabName, tier.maxChars, 3);
	const textBlockH = lines.length * tier.lineHeight;
	const textAreaTop = 48;
	const textAreaBottom = isActive ? 128 : 138;
	const textAreaH = textAreaBottom - textAreaTop;
	const textStartY =
		textAreaTop + (textAreaH - textBlockH) / 2 + tier.fontSize * 0.8;

	const textElements = lines
		.map((line, i) => {
			const y = textStartY + i * tier.lineHeight;
			return `<text x="72" y="${y}" text-anchor="middle" fill="${textColor}" font-family="-apple-system,SF Pro,Helvetica,sans-serif" font-size="${tier.fontSize}">${escapeXml(line)}</text>`;
		})
		.join("");

	const activeBar = isActive
		? `<rect x="20" y="132" width="104" height="5" fill="#3B82F6" rx="2.5"/>`
		: "";

	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144">
<rect width="144" height="144" fill="${bgColor}" rx="16"/>
${badge}
${textElements}
${activeBar}
</svg>`;

	return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function renderEmptyButton(): string {
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144">
<rect width="144" height="144" fill="#000000" rx="16"/>
<text x="72" y="78" text-anchor="middle" fill="#374151" font-family="-apple-system,SF Pro,Helvetica,sans-serif" font-size="28">-</text>
</svg>`;
	return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

// -- Precompiled AppleScript --

const APPLESCRIPT_SRC = `tell application "iTerm"
	if (count of windows) is 0 then return (ASCII character 9) & "0" & (ASCII character 9) & (ASCII character 9) & (ASCII character 9) & (ASCII character 9)
	set w to window 1
	set tabNames to {}
	set tabPrompts to {}
	set tabProcessing to {}
	set tabTtys to {}
	set activeIdx to 0
	repeat with i from 1 to count of tabs of w
		set t to tab i of w
		set s to current session of t
		set end of tabNames to name of s
		set end of tabTtys to tty of s
		try
			if is at shell prompt of s then
				set end of tabPrompts to "1"
			else
				set end of tabPrompts to "0"
			end if
		on error
			set end of tabPrompts to "0"
		end try
		try
			if is processing of s then
				set end of tabProcessing to "1"
			else
				set end of tabProcessing to "0"
			end if
		on error
			set end of tabProcessing to "0"
		end try
		if t is equal to current tab of w then set activeIdx to i
	end repeat
	set AppleScript's text item delimiters to "||"
	return (tabNames as text) & (ASCII character 9) & activeIdx & (ASCII character 9) & (tabPrompts as text) & (ASCII character 9) & (tabProcessing as text) & (ASCII character 9) & (tabTtys as text)
end tell`;

const COMPILED_SCRIPT_PATH = join(tmpdir(), "iterm-tabs-poll.scpt");
let scriptCompiled = false;

function ensureCompiledScript(): void {
	if (scriptCompiled) return;
	try {
		const srcPath = join(tmpdir(), "iterm-tabs-poll.applescript");
		writeFileSync(srcPath, APPLESCRIPT_SRC);
		execFileSync("osacompile", ["-o", COMPILED_SCRIPT_PATH, srcPath]);
		scriptCompiled = true;
		streamDeck.logger.info("Precompiled AppleScript for polling");
	} catch (err) {
		streamDeck.logger.warn(`Failed to precompile AppleScript: ${err}`);
	}
}

// -- AppleScript helpers --

async function checkFrontmost(): Promise<boolean> {
	try {
		const { stdout } = await exec("bash", [
			"-c",
			'lsappinfo info -only name "$(lsappinfo front)"',
		]);
		return stdout.includes("iTerm2");
	} catch {
		return false;
	}
}

async function getTabInfo(): Promise<TabInfo> {
	ensureCompiledScript();
	try {
		const args = scriptCompiled
			? [COMPILED_SCRIPT_PATH]
			: ["-e", APPLESCRIPT_SRC];
		const { stdout } = await exec("osascript", args);
		const sections = stdout.trim().split("\t");
		const names = (sections[0] || "").split("||").filter((n: string) => n.length > 0);
		const activeIndex = parseInt(sections[1] || "0", 10);
		const prompts = (sections[2] || "").split("||").map((p: string) => p === "1");
		const processing = (sections[3] || "").split("||").map((p: string) => p === "1");
		const ttys = (sections[4] || "").split("||").filter((t: string) => t.length > 0);
		return { names, activeIndex, prompts, processing, frontmost: false, ttys };
	} catch {
		return { names: [], activeIndex: 0, prompts: [], processing: [], frontmost: false, ttys: [] };
	}
}

async function switchToTab(tabIndex: number): Promise<void> {
	try {
		await exec("osascript", [
			"-e",
			`tell application "iTerm"
	activate
	select tab ${tabIndex} of window 1
end tell`,
		]);
	} catch {
		streamDeck.logger.warn(`Failed to switch to tab ${tabIndex}`);
	}
}

// -- Attention tracking --
//
// Two detection strategies:
//
// 1. Shell prompt transition: background tab goes to "at shell prompt"
//    (command finished in a regular shell session).
//
// 2. macOS notification: when iTerm2 posts a system notification (e.g.
//    "Claude needs your permission"), we detect it via `log stream` on
//    the unified log and flag recently-active background tabs.

// Apply the timing-based heuristic: open a notification window and flag
// tabs that recently stopped processing.
function applyTimingHeuristic(tabInfo: TabInfo, visibleTab: number): void {
	notificationWindowEnd = pollCount + NOTIFICATION_WINDOW_POLLS;
	streamDeck.logger.info(
		`Notification window opened (polls ${pollCount}-${notificationWindowEnd})`
	);

	const { prompts, processing } = tabInfo;
	for (let i = 0; i < tabInfo.names.length; i++) {
		const tabIdx = i + 1;
		if (tabIdx === visibleTab) continue;
		const atPrompt = prompts[i] ?? false;
		const isProc = processing[i] ?? false;
		if (atPrompt || isProc) continue;

		const lastActive = lastProcessingPoll.get(tabIdx);
		if (lastActive !== undefined && pollCount - lastActive <= 3) {
			attentionTabs.add(tabIdx);
			streamDeck.logger.info(
				`Tab ${tabIdx} flagged: notification + stopped ${pollCount - lastActive} polls ago`
			);
		}
	}
}

function updateAttention(tabInfo: TabInfo): void {
	const { activeIndex, prompts, processing, frontmost } = tabInfo;

	// Only treat the active tab as "visible" if iTerm2 is the
	// frontmost app. When it's backgrounded, every tab is equally
	// hidden from the user.
	const visibleTab = frontmost ? activeIndex : -1;

	// If a new notification arrived, try project-based matching first,
	// then fall back to the timing heuristic.
	if (notificationPending) {
		notificationPending = false;

		if (notificationProject) {
			let matched = false;
			for (let i = 0; i < tabInfo.names.length; i++) {
				const tabIdx = i + 1;
				if (tabIdx === visibleTab) continue;
				if (matchesProject(tabInfo.names[i], notificationProject)) {
					attentionTabs.add(tabIdx);
					matched = true;
					streamDeck.logger.info(
						`Tab ${tabIdx} flagged: project match "${notificationProject}"`
					);
				}
			}
			if (matched) {
				streamDeck.logger.info(
					`Project match found for "${notificationProject}" - skipping timing heuristic`
				);
			} else {
				streamDeck.logger.info(
					`No tab matched project "${notificationProject}" - falling back to timing heuristic`
				);
				applyTimingHeuristic(tabInfo, visibleTab);
			}
			notificationProject = null;
		} else {
			applyTimingHeuristic(tabInfo, visibleTab);
		}
	}

	const inNotificationWindow = pollCount <= notificationWindowEnd;

	for (let i = 0; i < tabInfo.names.length; i++) {
		const tabIdx = i + 1;
		const atPrompt = prompts[i] ?? false;
		const wasAtPrompt = prevPromptState.get(tabIdx) ?? false;
		const isProcessing = processing[i] ?? false;
		const wasProcessing = prevProcessingState.get(tabIdx) ?? false;

		// Log all state transitions for debugging
		if (pollCount > 0) {
			if (atPrompt !== wasAtPrompt) {
				streamDeck.logger.info(
					`Tab ${tabIdx} prompt transition: ${wasAtPrompt} -> ${atPrompt}`
				);
			}
			if (isProcessing !== wasProcessing) {
				streamDeck.logger.info(
					`Tab ${tabIdx} processing transition: ${wasProcessing} -> ${isProcessing}`
				);
			}
		}

		if (tabIdx === visibleTab) {
			// Tab is active AND iTerm2 is frontmost: user can see it
			attentionTabs.delete(tabIdx);
		} else if (pollCount > 0) {
			// Strategy 1: shell prompt transition during notification window
			if (inNotificationWindow && atPrompt && !wasAtPrompt) {
				attentionTabs.add(tabIdx);
				streamDeck.logger.info(
					`Tab ${tabIdx} flagged: prompt transition during notification window`
				);
			}

			// Strategy 2: tab stopped processing during notification window
			if (inNotificationWindow && wasProcessing && !isProcessing) {
				attentionTabs.add(tabIdx);
				streamDeck.logger.info(
					`Tab ${tabIdx} flagged: stopped processing during notification window`
				);
			}
		}

		if (isProcessing) {
			lastProcessingPoll.set(tabIdx, pollCount);
		}
		prevPromptState.set(tabIdx, atPrompt);
		prevProcessingState.set(tabIdx, isProcessing);
	}

	// Restart log stream if it died
	if (!logStreamProcess && visibleActions.size > 0) {
		startLogStream();
	}

	pollCount++;
}

// -- Polling --

async function pollTabs(): Promise<void> {
	if (pollInProgress) return;
	pollInProgress = true;

	const pollStart = Date.now();

	try {
		// Run AppleScript, ps, and frontmost check in parallel
		const [tabInfo, psOutput, frontmost] = await Promise.all([
			getTabInfo(),
			getRawProcessData(),
			checkFrontmost(),
		]);
		tabInfo.frontmost = frontmost;

		const { names, activeIndex, ttys } = tabInfo;

		updateAttention(tabInfo);

		const ttyPrograms = matchTtyPrograms(ttys, psOutput);

		for (const [, entry] of visibleActions) {
			const idx = entry.tabIndex;
			if (idx <= names.length) {
				const { displayName, process } = parseTabName(names[idx - 1]);
				const program =
					ttyPrograms.get(idx) ?? detectProgramFromName(process);
				const svg = renderButton({
					tabName: displayName,
					program,
					isActive: idx === activeIndex,
					hasAttention: attentionTabs.has(idx),
				});
				entry.action.setImage(svg);
				entry.action.setTitle("");
			} else {
				entry.action.setImage(renderEmptyButton());
				entry.action.setTitle("");
			}
		}
	} finally {
		pollInProgress = false;
	}

	// Performance tracking: log stats every 20 polls (~1 minute)
	const elapsed = Date.now() - pollStart;
	pollDurations.push(elapsed);
	if (pollDurations.length >= 20) {
		const avg = Math.round(
			pollDurations.reduce((a, b) => a + b, 0) / pollDurations.length
		);
		const max = Math.max(...pollDurations);
		streamDeck.logger.info(
			`Poll stats (last ${pollDurations.length}): avg=${avg}ms, max=${max}ms`
		);
		pollDurations = [];
	}
}

function startPolling(): void {
	if (pollTimer) return;
	startLogStream();
	pollTabs();
	pollTimer = setInterval(pollTabs, POLL_INTERVAL_MS);
}

function stopPolling(): void {
	if (pollTimer) {
		clearInterval(pollTimer);
		pollTimer = null;
	}
	stopLogStream();
}

// -- Action --

@action({ UUID: "com.iammikec.iterm-tabs.tab" })
export class ITermTabAction extends SingletonAction<TabSettings> {
	override async onWillAppear(ev: WillAppearEvent<TabSettings>): Promise<void> {
		let tabIndex = ev.payload.settings.tabIndex;

		if (!tabIndex) {
			const usedIndices = new Set(
				[...visibleActions.values()].map((v) => v.tabIndex)
			);
			for (let i = 1; i <= 6; i++) {
				if (!usedIndices.has(i)) {
					tabIndex = i;
					break;
				}
			}
			tabIndex = tabIndex || 1;
			await ev.action.setSettings({ tabIndex });
		}

		visibleActions.set(ev.action.id, { action: ev.action, tabIndex });
		startPolling();
	}

	override async onWillDisappear(
		ev: WillDisappearEvent<TabSettings>
	): Promise<void> {
		visibleActions.delete(ev.action.id);
		if (visibleActions.size === 0) {
			stopPolling();
		}
	}

	override async onKeyDown(ev: KeyDownEvent<TabSettings>): Promise<void> {
		const entry = visibleActions.get(ev.action.id);
		if (!entry) return;
		attentionTabs.delete(entry.tabIndex);

		// Immediately re-render so the highlight clears without
		// waiting for the next 3-second poll.
		pollTabs();

		await switchToTab(entry.tabIndex);
	}
}
