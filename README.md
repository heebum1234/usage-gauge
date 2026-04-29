# Usage Gauge

A floating desktop widget that shows your Claude Code and Codex usage at a glance.

<!-- Badges placeholder: license, platform, release status -->

![demo](docs/demo.gif)
<!-- TODO: Replace with a GIF showing the gauge changing color as usage approaches the limit. -->

## Why

Getting cut off mid-session by Claude Code or Codex usage limits breaks flow at exactly the wrong time. Usage Gauge keeps the remaining quota visible in a small always-on-top widget, so you can pace long coding sessions before the CLI stops you.

**No API keys, no extra auth — if the CLI works in your terminal, it works here.**

Usage Gauge runs each CLI exactly as you would in your terminal, sends the built-in usage command, and reads the result locally.

## Features

- Real-time gauge for Claude Code `/usage` and Codex `/status`
- Always-on-top floating widget with a minimal footprint
- No API keys — uses your existing CLI session
- Cross-platform Electron app, with Windows as the primary target and macOS secondary

## Install

> ⚠️ **Alpha** — prebuilt binaries coming soon. For now, run from source.

### Prerequisites

- Node.js 18+
- [Claude Code](https://docs.claude.com/en/docs/claude-code) and/or [Codex CLI](https://github.com/openai/codex) installed and signed in

### Run From Source

```bash
git clone https://github.com/heebum1234/usage-gauge.git
cd usage-gauge
npm install
npm run dev
```

For a normal Electron start without dev mode:

```bash
npm start
```

### Build Windows Package

Install dependencies, then run:

```bash
npm run build
```

Artifacts are written under `dist\`.

## How It Works

Usage Gauge starts a local terminal session for each configured CLI, runs the same usage command you would type by hand (`/usage` for Claude Code, `/status` for Codex), and parses the command output into a remaining-usage gauge.

It does not require service API keys, tokens, or separate authentication. It relies on the CLI sessions already available on your machine.

No usage data leaves your machine.

## Roadmap

- Prebuilt binaries for Windows `.exe` and macOS `.dmg`
- `winget` and `brew` distribution
- Configurable warning thresholds
- Auto-start and tray/menu-bar controls

## Contributing

Issues and PRs are welcome. If you are hitting CLI usage limits and have a workflow this widget should support, open an issue with the platform, CLI, and usage output shape if possible.

## License

MIT (see [LICENSE](LICENSE)).
