# Contributing to ARIA

Thanks for helping improve ARIA (A Review Inline Agent). Bug reports, agent compatibility reports and pull requests are welcome.

## Setup

Requirements: Node.js 20+ and VS Code 1.90+.

```bash
npm ci
npm test          # compile + unit tests
npm run watch     # recompile on change
```

Press **F5** in VS Code ("Run Extension") to start an Extension Development Host with your build.

`npm run test:extension` runs a smoke test in a real, isolated VS Code instance (Windows, PowerShell). `npm run package` builds a VSIX into `../builds/`.

## Project layout

| Path | Purpose |
|---|---|
| `src/extension.ts` | Activation, commands, settings handling, status bar, adapter setup flow |
| `src/session.ts` | Review session: baseline snapshot, event ingestion, Accept/Reject, Undo |
| `src/inline-review.ts` | Native diff tabs, CodeLens buttons, status bar decision buttons, navigation |
| `src/diff.ts` | Change groups computed with VS Code's own diff algorithm (`vscode-diff`) |
| `src/review.ts` | Row/line helpers for change groups |
| `src/panel.ts` | ARIA Changes view and position indicator |
| `src/config.ts` | Settings access, button locations, settings export/import |
| `src/persistence.ts` | Local saved review and Undo history |
| `src/directories.ts` | Per-directory Enable/Disable/Init state |
| `src/adapters.ts` | Install, remove and check user-level agent hooks |
| `src/store.ts` | Global event store location and project hash |
| `src/uninstall.ts` | Cleanup run by VS Code after uninstall |
| `adapters/record-event.mjs` | Hook runtime called by CLI agents; appends `{t, file, agent}` events |
| `adapters/agent-review-watch.ts` | OpenCode plugin |
| `test-*.js` | Unit and integration tests with VS Code API mocks |
| `images/` | Extension icon; `images/readme/` holds README screenshots |

The project hash must stay byte-identical in `src/store.ts`, `adapters/record-event.mjs` and `adapters/agent-review-watch.ts`; tests check this.

## Adding or fixing an agent adapter

1. Add the agent ID to `SUPPORTED_AGENTS` and `AGENT_LABELS` in `src/config.ts`, and an `aria.agents.<id>.enabled` setting in `package.json`.
2. Add `install<Agent>`, removal and status checks in `src/adapters.ts`. Tag events with `--agent <id>`, keep unrelated user hooks, and call `backupIfExists` before writing.
3. Make sure `adapters/record-event.mjs` can read the file path from that CLI's hook payload.
4. Add tests next to the existing adapter tests and update the **Supported agents** table in `README.md`.

## Pull requests

- Keep changes focused and match the surrounding code style.
- Run `npm test` and make sure all suites pass.
- Add or update tests for behaviour changes, and add an entry to `CHANGELOG.md`.
- Describe how you verified the change, including which CLI agent and version for adapter work.

## Reporting issues

Use the issue templates. For agent problems, include the output of **ARIA Review: Agent Adapter Status** and the relevant lines from **Output → ARIA Review**. Remove private paths or code before posting.
