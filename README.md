# iTerm Tabs for Stream Deck

A macOS Stream Deck plugin that turns your buttons into a live iTerm2 tab switcher. Each button displays the current tab name, shows what program is running, and highlights when a tab needs your attention.

Built for the Stream Deck Mini (6 buttons) but works with any Stream Deck model.

## Features

- **Live tab names** with smart text wrapping and dynamic font sizing
- **Program detection** via process tree inspection (not just tab titles):
  - Claude Code, Codex, Python, Node.js, SSH, Vim/Neovim, shell
  - Each program gets a distinct icon badge
- **Attention highlighting** when a background tab needs input (amber background tint)
- **One-press tab switching** with immediate highlight clearing
- **Near-zero idle footprint** - polls every 3 seconds, ~1s per poll

## Installation

### Prerequisites

- macOS 13+
- [iTerm2](https://iterm2.com/)
- [Elgato Stream Deck](https://www.elgato.com/stream-deck) with Stream Deck software 6.5+
- Node.js 20+ (bundled by Stream Deck SDK)

### From source

```bash
# Clone the repo
git clone https://github.com/iammikec/streamdeck-iterm-tabs.git
cd streamdeck-iterm-tabs

# Install dependencies
npm install

# Install the Elgato CLI globally (if you don't have it)
npm install -g @elgato/cli

# Build and link the plugin
npm run build
streamdeck link com.iammikec.iterm-tabs.sdPlugin
```

Then open the Stream Deck app, find "iTerm Tabs" in the action list, and drag "iTerm Tab" onto your buttons. Each button auto-assigns to the next available tab index (1-6).

### Development

```bash
npm run watch
```

This rebuilds on file changes and restarts the plugin automatically. Note that UI changes (SVG rendering, colors) require a full quit and relaunch of the Stream Deck application to take effect.

## How it works

### Polling

Every 3 seconds, the plugin runs three operations in parallel:

1. **AppleScript** queries iTerm2 for tab names, session TTYs, shell prompt state, and processing state. The script is precompiled to `.scpt` at startup to avoid recompilation overhead.
2. **`ps`** fetches all running processes with their TTYs and foreground status.
3. **`lsappinfo`** checks whether iTerm2 is the frontmost application.

The results are combined to determine what program each tab is running (by matching TTYs to process command lines) and whether any tab needs attention.

### Attention detection

The plugin monitors the macOS unified log via `log stream` for notification deliveries from iTerm2. When a notification fires:

1. A detection window opens (4 polls / ~12 seconds).
2. Any background tab that transitions from "processing" to idle, or from "not at shell prompt" to "at shell prompt" during this window gets flagged.
3. The active tab is only excluded if iTerm2 is the frontmost app. When iTerm2 is backgrounded, all tabs are eligible.

This approach avoids false positives from silence-based heuristics while still catching real "needs input" events.

### Button rendering

Buttons are full SVG images rendered at 144x144px:

- **Badge** (top-right): circular icon indicating the detected program
- **Tab name** (center): dynamically sized across three font tiers (24px, 20px, 18px), picking the largest size that fits without truncation
- **Active indicator** (bottom): blue bar on the currently selected tab
- **Attention state**: amber background tint (`#6B3A10`) when the tab needs attention

### Program detection

The plugin inspects the foreground process tree for each tab's TTY rather than relying on tab titles. This correctly identifies programs like Claude Code (which runs under Python) by checking command-line paths. Detection order:

1. Claude Code (`.local/share/claude/` in command line)
2. Codex
3. SSH
4. Vim/Neovim
5. Falls back to tab title process name for Python, Node, shell, etc.

## Configuration

Currently there are no user-facing settings beyond dragging actions onto buttons. Each button auto-assigns to the next available tab index. Future versions may expose:

- Custom poll interval
- Attention highlight color
- Badge visibility toggle
- Tab index override in the Property Inspector

## Known limitations

- **macOS only** - relies on AppleScript, `lsappinfo`, and the macOS unified log.
- **iTerm2 only** - no support for Terminal.app, Alacritty, Kitty, etc.
- **Single window** - only monitors `window 1` of iTerm2. Multiple windows are not supported.
- **Polling latency** - button updates take ~1 second (AppleScript overhead) plus up to 3 seconds between polls. Notifications trigger an immediate poll, but `log stream` buffering adds 1-3 seconds of delay.
- **Notification-dependent attention** - attention highlighting only triggers when iTerm2 posts a macOS notification (typically via BEL character from CLI tools like Claude Code). Conversational prompts that don't send BEL won't trigger highlights. Adding iTerm2 Triggers for specific prompt patterns could help here.
- **Notification sounds** - iTerm2 notification sounds are controlled at the macOS level (System Settings > Notifications > iTerm2), not by this plugin. You can disable sounds while keeping notifications enabled, and the plugin will still detect them via the system log.

## Future work

- iTerm2 Trigger-based notifications for broader prompt detection
- Property Inspector UI for configuring tab index, colors, and poll interval
- Multi-window support
- Stream Deck Store distribution
- Custom badge icons or user-defined program detection rules

## Tech stack

- [Elgato Stream Deck SDK v2](https://docs.elgato.com/sdk/) (Node.js)
- TypeScript with ES2022 modules
- Rollup for bundling
- AppleScript for iTerm2 communication
- SVG for button rendering

## License

MIT
