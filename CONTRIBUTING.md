# Contributing to ARIA

Thanks for helping improve ARIA (A Review Inline Agent). Bug reports, agent compatibility reports and pull requests are welcome.

## Setup

Requirements: Node.js 20+, Rust via `rustup` (with `wasm32-wasip2`) and Zed.

```bash
cd server && npm ci && npm test   # compile + diff, hook runtime and LSP end-to-end tests
cargo build --release --target wasm32-wasip2
```

To try your build in Zed: `cd server && npm link` (puts `aria-lsp` on PATH, which the extension prefers), then `zed: install dev extension` on the repository root. Server logs: `dev: open language server logs` → `aria`.

## Project layout

| Path | Purpose |
|---|---|
| `extension.toml`, `src/lib.rs` | Zed extension (Rust → WASM): installs `aria-review-lsp` from npm and starts it, passes `lsp.aria` settings |
| `server/src/server.ts` | Language server: diagnostics per change block, code actions, commands, adapter setup, persistence |
| `server/src/session.ts` | Review state: baseline snapshot, Accept/Reject, manual edits, Undo, event log tailing |
| `server/src/diff.ts` | Change blocks computed with VS Code's diff algorithm (`vscode-diff`) |
| `server/src/persistence.ts` | Local saved review and exclude globs |
| `server/src/adapters.ts` | Install, remove and check user-level agent hooks |
| `server/src/store.ts` | Global event store location and project hash |
| `server/src/uninstall.ts` | Cleanup behind `aria-lsp --uninstall` |
| `server/adapters/record-event.mjs` | Hook runtime called by CLI agents; appends `{t, file, agent}` events |
| `server/adapters/agent-review-watch.ts` | OpenCode plugin |
| `server/test-*.js` | Tests |

The project hash must stay byte-identical in `server/src/store.ts`, `server/adapters/record-event.mjs` and `server/adapters/agent-review-watch.ts`; tests check this.

## Adding or fixing an agent adapter

1. Add the agent ID to `SUPPORTED_AGENTS` in `server/src/session.ts`.
2. Add `install<Agent>`, removal and status checks in `server/src/adapters.ts`. Tag events with `--agent <id>`, keep unrelated user hooks, and call `backupIfExists` before writing.
3. Make sure `server/adapters/record-event.mjs` can read the file path from that CLI's hook payload.
4. Add tests and update the **Supported agents** table in `README.md`.

## Pull requests

- Keep changes focused and match the surrounding code style.
- Run `npm test` in `server/` and make sure all suites pass.
- Add or update tests for behaviour changes, and add an entry to `CHANGELOG.md`.
- Describe how you verified the change, including which CLI agent and version for adapter work.

## Reporting issues

Use the issue templates. For agent problems, include the hook status (`aria.adapterStatus`) and the relevant lines from Zed's language server log for `aria`. Remove private paths or code before posting.
