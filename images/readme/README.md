# README images

Images used by the project README. Paths are relative, so they render on GitHub as soon as the repository is pushed.

| File | Used for | Status |
|---|---|---|
| `inline-review.png` | Hero screenshot: agent in the terminal, ARIA inline review in VS Code | Present |
| `how-it-works.png` | "How it works" diagram, rendered from `how-it-works.html` (re-render command inside that file) | Present |
| `status-bar.png` | Status bar with position, Previous/Next and Accept/Reject File/All buttons | Add later |
| `changes-view.png` | ARIA Changes view in the Explorer | Add later |
| `settings.png` | ARIA settings grouped by category in the Settings editor | Add later |

To add a screenshot, save it here with the file name above and remove the matching `<!--` `-->` comment around its line in `../../README.md`.

Guidelines:

- PNG, about 1600 px wide, dark theme to match the hero image.
- Crop to the relevant area; avoid personal paths, account names or secrets.
- Keep each file under 1 MB.

The extension icon lives at `../icon.png` (256 x 256) because `package.json` references it.

For the VS Code Marketplace, `vsce` rewrites these relative paths to `https://github.com/krispachi/aria/raw/HEAD/...` when packaging, so an image must be pushed to the default branch before a release that uses it. See `../../PUBLISHING.md`.
