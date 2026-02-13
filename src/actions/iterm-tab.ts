import streamDeck, {
	action,
	KeyDownEvent,
	SingletonAction,
	WillAppearEvent,
	WillDisappearEvent,
} from "@elgato/streamdeck";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

const POLL_INTERVAL_MS = 3000;

type TabSettings = {
	tabIndex?: number;
};

type TrackedAction = {
	action: WillAppearEvent["action"];
	tabIndex: number;
};

const visibleActions = new Map<string, TrackedAction>();
let pollTimer: NodeJS.Timeout | null = null;

// -- AppleScript helpers --

async function getTabInfo(): Promise<{ names: string[]; activeIndex: number }> {
	try {
		const { stdout } = await exec("osascript", [
			"-e",
			`tell application "iTerm"
	if (count of windows) is 0 then return "||0"
	set w to window 1
	set tabNames to {}
	set activeIdx to 0
	repeat with i from 1 to count of tabs of w
		set t to tab i of w
		set end of tabNames to name of current session of t
		if t is equal to current tab of w then set activeIdx to i
	end repeat
	set AppleScript's text item delimiters to "||"
	return (tabNames as text) & "||" & activeIdx
end tell`,
		]);
		// Format: "name1||name2||name3||activeIdx"
		const parts = stdout.trim().split("||");
		const activeIndex = parseInt(parts.pop() || "0", 10);
		const names = parts.filter((n: string) => n.length > 0);
		return { names, activeIndex };
	} catch {
		return { names: [], activeIndex: 0 };
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

// -- Polling --

async function pollTabs(): Promise<void> {
	const { names, activeIndex } = await getTabInfo();

	for (const [, entry] of visibleActions) {
		const idx = entry.tabIndex;
		if (idx <= names.length) {
			const prefix = idx === activeIndex ? "\u25b8 " : "";
			const title = prefix + truncate(names[idx - 1], 10);
			entry.action.setTitle(title);
		} else {
			entry.action.setTitle("");
		}
	}
}

function truncate(str: string, maxLen: number): string {
	if (str.length <= maxLen) return str;
	return str.slice(0, maxLen - 1) + "\u2026";
}

function startPolling(): void {
	if (pollTimer) return;
	pollTabs();
	pollTimer = setInterval(pollTabs, POLL_INTERVAL_MS);
}

function stopPolling(): void {
	if (pollTimer) {
		clearInterval(pollTimer);
		pollTimer = null;
	}
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
		await switchToTab(entry.tabIndex);
	}
}
