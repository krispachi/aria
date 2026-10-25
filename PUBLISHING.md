# Marketplace release

Extension ID is krispachi.aria-review (the name "aria" is taken on the Marketplace by another publisher). The publishing account must own publisher krispachi; ownership and initial Marketplace name availability are not verified by this workspace.

Run npm test and npm run package, then upload builds/krispachi-aria-review-0.17.7.vsix through publisher management. Building does not publish anything.

Verify insertion action placement, replacement/first-row Changes actions, compact toolbar, native shortcut editor, export/import, folding, Undo and restart recovery in a trusted VS Code window. Test Clean Extension Data only in an isolated profile/home. Persistence stores local plaintext code; README describes privacy controls and cleanup scope.

Author display name is Krispachi. Keep publisher ID krispachi and set the publisher account's Marketplace display Name to Krispachi through publisher management. Publisher display name is managed by the Marketplace account, not a supported manifest publisherDisplayName field. Local VSIX installation may continue to show the raw publisher ID. Do not inject VS Code-managed __metadata into the manifest.

Repository: https://github.com/krispachi/aria (repository, homepage and bugs are set in package.json).

Includes a 256x256 PNG icon, metadata, README, CHANGELOG and MIT license. Verified Publisher status depends on publisher verification, not on adding an icon or repository field.

Official guidance: https://code.visualstudio.com/api/working-with-extensions/publishing-extension
Manifest: https://code.visualstudio.com/api/references/extension-manifest

Screenshots: README images live in images/readme/ (see images/readme/README.md) and are bundled in the VSIX. vsce rewrites relative README links and images to https://github.com/krispachi/aria/raw/HEAD/..., so push images to the default branch before publishing and verify the published README renders.

Release rules learned the hard way:
- Every upload needs a new version in package.json; the Marketplace rejects a version that was already uploaded, even after removal.
- To take the extension down, use **Unpublish** (keeps the name reserved for this publisher). **Remove** deletes it and the name cannot be reused, which is why the ID moved from aria-inline-review to aria-review.
