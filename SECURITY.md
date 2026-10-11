# Security policy

## What ARIA touches

- **User-level CLI configuration.** Adapter setup adds ARIA hooks to files such as `~/.claude/settings.json`, `~/.codex/config.toml`, `~/.cursor/hooks.json`, `~/.gemini/settings.json`, `~/.copilot/hooks/` and the OpenCode plugin folder. Existing entries are preserved and a backup is written to `~/.aria/backup/` first.
- **Hook runtime.** Hooks run `node ~/.aria/adapters/record-event.mjs`, which appends `{time, file path, agent}` lines to `~/.aria/projects/<hash>.jsonl`. It never reads or sends file contents.
- **Local review cache.** Pending snapshots and Undo history are stored as plaintext in `~/.aria/sessions/`. Use `excludePatterns` for sensitive files or set `persistReview: false` (under `lsp.aria.settings`).
- **Network.** None. ARIA makes no network requests and collects no telemetry.

ARIA only runs in trusted workspaces and never bypasses a CLI's own hook trust prompt.

## Reporting a vulnerability

Please do not open a public issue for security problems. Use GitHub's **Report a vulnerability** (private security advisory) on this repository, with steps to reproduce and the affected version. You should receive a response within a few days.

## Supported versions

Security fixes are released for the latest published version.
