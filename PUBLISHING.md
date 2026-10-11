# Release (Zed)

A release has two parts, published in this order:

1. **npm package `aria-review-lsp`** (`server/`). The Zed extension installs the latest version of it at runtime.
   ```bash
   cd server && npm ci && npm test && npm publish
   ```
   Every publish needs a new `version` in `server/package.json`. Check the name is still free (`npm view aria-review-lsp`) before the first publish; if it is taken, rename it in `server/package.json`, `extension.toml` (`[[capabilities]]`) and `src/lib.rs` (`PACKAGE`, `SERVER_PATH`).

2. **Zed extension** (`aria-review`). Bump `version` in `extension.toml` and `Cargo.toml`, then open a pull request to https://github.com/zed-industries/extensions that adds this repository as a submodule under `extensions/aria-review` and an entry in `extensions.toml`:
   ```toml
   [aria-review]
   submodule = "extensions/aria-review"
   version = "0.18.0"
   ```
   Zed builds the WASM from `src/lib.rs`; a `LICENSE` file at the repository root is required (MIT is present).

Before releasing, verify in Zed with `zed: install dev extension`: snapshot on start, diagnostics after a real agent edit, Accept/Reject change, file and all files, Undo, the dirty-buffer path (Reject while a buffer has unsaved edits) and restoring a pending review after restarting Zed.

Guides: https://zed.dev/docs/extensions/developing-extensions and https://zed.dev/docs/extensions/languages#language-servers
