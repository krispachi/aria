const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const { ReviewCache, excluded } = require("./out/persistence");

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aria-state-"));
  const source = path.join(root, "source.txt");
  const outside = path.join(root, "outside", "source.txt");
  const docs = new Map();
  const settings = new Map();
  const warnings = [];
  const reloads = [];
  const rejectionErrors = [];
  let enforceDiskVersion = false;
  let raceAtSave = false;
  let refuseFocus = false;
  let refuseReload = false;
  const old = "alpha\nbeta\ngamma\ndelta\n";
  const proposed = "alpha\nBETA\ngamma\nDELTA\n";
  const uri = file => ({ scheme: "file", fsPath: file, path: file, toString: () => file });
  const offset = (text, pos) => text.split("\n").slice(0, pos.line).reduce((sum, line) => sum + line.length + 1, 0) + pos.character;
  const docFor = file => {
    if (!docs.has(file)) docs.set(file, {
      uri: uri(file), eol: 1, isDirty: false, diskVersion: fs.readFileSync(file, "utf8"), content: fs.readFileSync(file, "utf8"),
      getText() { return this.content; },
      get lineCount() { return this.content.split("\n").length; },
      positionAt(n) { const lines = this.content.slice(0, n).split("\n"); return { line: lines.length - 1, character: lines.at(-1).length }; },
      validatePosition(pos) { return pos.line < this.lineCount ? pos : this.positionAt(this.content.length); },
      async save() {
        if (raceAtSave) { raceAtSave = false; fs.writeFileSync(file, "new external edit during save\n"); return false; }
        if (enforceDiskVersion && this.diskVersion !== fs.readFileSync(file, "utf8")) throw new Error("FILE_MODIFIED_SINCE");
        fs.writeFileSync(file, this.content); this.diskVersion = this.content; this.isDirty = false; return true;
      },
    });
    return docs.get(file);
  };
  const vscode = {
    __esModule: true,
    Uri: { file: uri }, EndOfLine: { CRLF: 2 },
    TabInputText: class { constructor(uri) { this.uri = uri; } },
    TabInputTextDiff: class {},
    Position: class { constructor(line, character) { Object.assign(this, { line, character }); } },
    Range: class { constructor(start, end) { Object.assign(this, { start, end }); } },
    WorkspaceEdit: class { edits = []; replace(uri, range, text) { this.edits.push({ uri, range, text }); } },
    workspace: {
      workspaceFolders: [{ uri: uri(root) }], findFiles: async () => [uri(source)],
      openTextDocument: async target => docFor(target.fsPath),
      applyEdit: async edit => { for (const item of edit.edits) { const doc = docFor(item.uri.fsPath); doc.content = doc.content.slice(0, offset(doc.content, item.range.start)) + item.text + doc.content.slice(offset(doc.content, item.range.end)); doc.isDirty = true; } return true; },
    },
    commands: { executeCommand: async name => {
      if (name === "workbench.action.files.revert" && !refuseReload) {
        const doc = vscode.window.activeTextEditor.document;
        reloads.push(doc.uri.fsPath);
        doc.content = fs.readFileSync(doc.uri.fsPath, "utf8"); doc.diskVersion = doc.content; doc.isDirty = false;
      }
    } },
    window: { tabGroups: { all: [] }, showTextDocument: async doc => { if (!refuseFocus) vscode.window.activeTextEditor = { document: doc }; }, visibleTextEditors: [], showWarningMessage: async text => warnings.push(text), showErrorMessage: async text => { rejectionErrors.push(text); } },
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync("out/session.js", "utf8"), {
    exports: module.exports, module, Buffer, setInterval, clearInterval,
    require: name => name === "vscode" ? vscode : name === "./config" ? { reviewSetting: (key, fallback) => settings.get(key) ?? fallback } : name === "./store" ? { resolveEventsFile: () => path.join(root, "events", "events.jsonl") } : name === "./diff" ? require("./out/diff") : name === "./review" ? require("./out/review") : require(name),
  });
  const { ReviewSession } = module.exports;
  const sessions = [];
  const newSession = () => { const session = new ReviewSession(undefined, file => file === source); sessions.push(session); return session; };
  try {
    fs.writeFileSync(source, proposed);
    const doc = docFor(source);
    const session = newSession(); session.active = true; session.acceptFile(doc.uri, old); session.markTouched(source); session.refreshFor(doc.uri, proposed);
    const first = session.hunks.get(source)[0];
    await session.decide([source], () => session.acceptHunk(doc.uri, first.id));
    session.refreshFor(doc.uri, doc.getText());
    assert.equal(session.pendingCount, 1);
    assert(session.canUndo);
    assert(await session.undoDecision());
    assert.equal(session.pendingCount, 2);
    assert.equal(doc.getText(), proposed, "Undo Accept changes baseline, not proposed code");

    await session.decide([source], async () => { await session.rejectAllInFile(doc.uri); session.refreshFor(doc.uri, doc.getText()); });
    assert.equal(doc.getText(), old);
    assert.equal(fs.readFileSync(source, "utf8"), old);
    assert(await session.undoDecision());
    assert.equal(doc.getText(), proposed);
    assert(doc.isDirty, "Undo Reject restores an unsaved buffer for explicit Save");
    assert.equal(fs.readFileSync(source, "utf8"), old, "Undo does not silently save restored code");
    await doc.save();
    const serialized = newSession(); serialized.active = true; serialized.acceptFile(doc.uri, old); serialized.markTouched(source); serialized.refreshFor(doc.uri, proposed);
    const acceptOne = async () => { const h = serialized.hunks.get(source)[0]; serialized.acceptHunk(doc.uri, h.id); serialized.refreshFor(doc.uri, doc.getText()); };
    await Promise.all([
      serialized.decide([source], async () => { await new Promise(resolve => setTimeout(resolve, 15)); await acceptOne(); }),
      serialized.decide([source], acceptOne),
    ]);
    assert.equal(serialized.pendingCount, 0, "Rapid decisions serialize without losing groups");
    assert(await serialized.undoDecision()); assert.equal(serialized.pendingCount, 1);
    assert(await serialized.undoDecision()); assert.equal(serialized.pendingCount, 2);
    await assert.rejects(serialized.decide([source], () => { serialized.acceptFile(doc.uri, proposed); throw new Error("partial operation failure"); }), /partial operation/);
    assert(serialized.canUndo, "Partial operations still record recoverable decisions");
    assert(await serialized.undoDecision()); assert.equal(serialized.pendingCount, 2);
    await doc.save();

    await session.decide([source], () => session.acceptFile(doc.uri, doc.getText()));
    doc.content += "manual after decision\n";
    const manual = doc.getText();
    assert.equal(await session.undoDecision(), false);
    assert.equal(doc.getText(), manual, "Undo never overwrites later manual edits");
    assert(warnings.some(text => text.includes("file changed")));
    doc.content = proposed; await doc.save(); session.clearHistory(); session.acceptFile(doc.uri, old); session.markTouched(source); session.refreshFor(doc.uri, proposed);

    const errors = [];
    let state = session.exportReview();
    let persist = true;
    const store = path.join(root, "workspace storage");
    const cache = new ReviewCache(store, () => state, () => persist, () => 7, text => errors.push(text));
    await cache.save();
    const saved = await cache.load();
    assert.equal(saved.files.length, 1, "Only pending files are persisted");
    const restored = newSession(); await restored.start("agent");
    assert.equal((await restored.restoreReview(saved)).length, 0);
    assert.equal(restored.pendingCount, 2);
    assert.equal(restored.baselineOf(source), old);
    assert.equal(fs.readFileSync(source, "utf8"), proposed, "Restoring snapshots never writes sources");

    await restored.decide([source], () => restored.acceptFile(doc.uri, doc.getText()));
    state = restored.exportReview(); await cache.save();
    const reloadUndo = newSession(); await reloadUndo.start("agent"); await reloadUndo.restoreReview(await cache.load());
    assert(reloadUndo.canUndo, "Decision history survives reload");
    assert(await reloadUndo.undoDecision());
    assert.equal(reloadUndo.pendingCount, 2);
    settings.set("undoLimit", 0);
    const noUndo = newSession(); noUndo.active = true;
    await noUndo.restoreReview(await cache.load());
    assert.equal(noUndo.canUndo, false, "Zero history limit disables restored Undo too");
    settings.delete("undoLimit");

    state = session.exportReview(); await cache.save();
    doc.content += "changed while closed\n"; await doc.save();
    const conflict = newSession(); await conflict.start("agent");
    assert.equal((await conflict.restoreReview(await cache.load())).length, 1);
    assert.equal(conflict.pendingCount, 0, "Changed disk files are not silently restored or attributed to AI");
    assert(doc.getText().endsWith("changed while closed\n"));

    await cache.clear(); await cache.save();
    assert.equal(fs.existsSync(path.join(store, "review-session.json")), false, "Clear does not resurrect identical snapshots on shutdown");
    state = { ...state, files: state.files.map(item => ({ ...item, content: item.content + "new review\n" })) };
    await cache.save(); assert(fs.existsSync(path.join(store, "review-session.json")));
    persist = false; await cache.save(); assert.equal(fs.existsSync(path.join(store, "review-session.json")), false);
    persist = true; cache.resume(); await cache.save();
    fs.writeFileSync(path.join(store, "review-session.json"), JSON.stringify({ ...state, savedAt: Date.now() - 8 * 86400000 }));
    assert.equal(await cache.load(), undefined, "Old cache expires");
    fs.writeFileSync(path.join(store, "review-session.json"), JSON.stringify({ version: 1, savedAt: Date.now(), files: [{ file: "relative", baseline: "", content: "" }], undo: [] }));
    assert.equal(await cache.load(), undefined, "Malformed paths are rejected");
    assert(errors.length > 0);
    const unsafe = newSession(); unsafe.active = true;
    assert.equal((await unsafe.restoreReview({ version: 1, savedAt: Date.now(), files: [{ file: outside, baseline: old, content: proposed }], undo: [] })).length, 0);
    assert.equal(unsafe.pendingCount, 0, "Restoration cannot escape the eligible workspace");
    const secondFile = path.join(root, "second.txt");
    fs.writeFileSync(secondFile, proposed);
    doc.content = proposed; await doc.save();
    const secondDoc = docFor(secondFile);
    const bulk = new ReviewSession(undefined, file => file === source || file === secondFile); sessions.push(bulk); bulk.active = true;
    for (const file of [source, secondFile]) { bulk.acceptFile(uri(file), old); bulk.markTouched(file); bulk.refreshFor(uri(file), proposed); }
    await bulk.decide([source, secondFile], async () => { await bulk.rejectAll(); for (const file of [source, secondFile]) bulk.refreshFor(uri(file), docFor(file).getText()); });
    assert.equal(bulk.pendingCount, 0);
    assert(await bulk.undoDecision());
    assert.equal(bulk.pendingCount, 4, "Undo workspace Reject restores both files as one decision");
    assert.equal(doc.getText(), proposed); assert.equal(secondDoc.getText(), proposed);
    assert.equal(bulk.canUndo, false, "One Undo resolves one multi-file decision");
    doc.content = proposed; await doc.save();
    const diskGuard = newSession(); diskGuard.active = true; diskGuard.acceptFile(doc.uri, old); diskGuard.markTouched(source); diskGuard.refreshFor(doc.uri, proposed);
    await diskGuard.decide([source], () => diskGuard.acceptFile(doc.uri, proposed));
    fs.writeFileSync(source, proposed + "external disk change\n");
    assert.equal(await diskGuard.undoDecision(), false, "Disk divergence also blocks Undo");
    assert(fs.readFileSync(source, "utf8").endsWith("external disk change\n"));
    assert.equal(doc.getText(), proposed);

    assert(excluded(".env", ["**/.env"])); assert(excluded("folder/.env.local", ["**/.env.*"])); assert(excluded("keys/private.pem", ["**/*.pem"]));
    assert.equal(excluded("demo/jam.html", ["**/.env", "**/*.key"]), false);
    assert.equal(excluded("foo[bar].txt", ["foo[bar].txt"]), true, "Glob metacharacters outside documented syntax are literal");
    doc.content = proposed; await doc.save();
    const resolved = newSession(); resolved.active = true; resolved.acceptFile(doc.uri, old); resolved.markTouched(source); resolved.refreshFor(doc.uri, proposed);
    resolved.noteAgentBuffer(doc); doc.isDirty = true;
    vscode.window.tabGroups.all = [{ tabs: [{ input: new vscode.TabInputText(doc.uri) }] }];
    await resolved.decide([source], () => resolved.acceptHunk(doc.uri, resolved.hunks.get(source)[0].id));
    assert(doc.isDirty, "Partial acceptance retains unsaved marker");
    resolved.refreshFor(doc.uri, doc.getText());
    await resolved.decide([source], () => resolved.acceptHunk(doc.uri, resolved.hunks.get(source)[0].id));
    assert.equal(doc.isDirty, false, "Final acceptance saves the agent-owned buffer");
    doc.content += "manual afterward\n"; doc.isDirty = true; resolved.observeManual(doc.uri, doc.getText());
    await resolved.decide([source], () => resolved.acceptFile(doc.uri, doc.getText()));
    assert(doc.isDirty, "Later manual edits remain unsaved");
    assert.equal(fs.readFileSync(source, "utf8"), proposed);
    doc.content = proposed; await doc.save(); resolved.acceptFile(doc.uri, old); resolved.markTouched(source); resolved.refreshFor(doc.uri, proposed);
    resolved.noteAgentBuffer(doc); doc.isDirty = true;
    doc.content += "manual during review\n"; resolved.observeManual(doc.uri, doc.getText());
    await resolved.decide([source], () => resolved.acceptFile(doc.uri, doc.getText()));
    assert(doc.isDirty, "Manual edits during review prevent automatic Save");
    resolved.acceptFile(doc.uri, old); resolved.refreshFor(doc.uri, doc.getText());
    await resolved.decide([source], () => resolved.rejectAllInFile(doc.uri));
    assert(doc.isDirty, "Reject preserves a manually dirty buffer without saving it");
    assert.equal(fs.readFileSync(source, "utf8"), proposed, "Reject does not save unrelated unsaved manual work");
    doc.content = proposed; await doc.save(); resolved.acceptFile(doc.uri, old); resolved.refreshFor(doc.uri, proposed); resolved.noteAgentBuffer(doc); doc.isDirty = true;
    settings.set("autoSaveResolved", false);
    await resolved.decide([source], () => resolved.acceptFile(doc.uri, proposed));
    assert(doc.isDirty, "Automatic acceptance Save can be disabled");
    settings.delete("autoSaveResolved"); settings.set("undoLimit", 0);
    resolved.acceptFile(doc.uri, old); resolved.refreshFor(doc.uri, proposed);
    await resolved.decide([source], () => resolved.acceptFile(doc.uri, proposed));
    assert.equal(doc.isDirty, false, "Automatic Save works with history disabled");
    {
      settings.delete("undoLimit");
      // Reproduce stale disk-version metadata after an external CLI write is
      // imported into the editor, then Accept one group and Reject the last.
      doc.content = old; await doc.save();
      const conflict = newSession(); conflict.active = true; conflict.acceptFile(doc.uri, old); conflict.markTouched(source);
      fs.writeFileSync(source, proposed); doc.content = proposed; doc.isDirty = true;
      conflict.refreshFor(doc.uri, proposed); conflict.noteAgentBuffer(doc, true);
      enforceDiskVersion = true;
      await conflict.decide([source], () => conflict.acceptHunk(doc.uri, conflict.hunks.get(source)[0].id));
      conflict.refreshFor(doc.uri, doc.getText());
      const reloadCount = reloads.length;
      await conflict.decide([source], async () => { await conflict.rejectHunk(doc.uri, conflict.hunks.get(source)[0].id); conflict.refreshFor(doc.uri, doc.getText()); });
      assert.equal(doc.getText(), "alpha\nBETA\ngamma\ndelta\n", "Final Reject preserves previously accepted group");
      assert.equal(fs.readFileSync(source, "utf8"), doc.getText(), "Reject saves against the refreshed native disk version");
      assert.equal(doc.isDirty, false);
      assert.equal(conflict.pendingCount, 0);
      assert.equal(reloads.length, reloadCount + 1);
      assert.equal(reloads.at(-1), source, "Reload targets only the decision file");
      assert(await conflict.undoDecision(), "Reject remains undoable after native reload");
      assert.equal(doc.getText(), proposed);
      assert.equal(conflict.pendingCount, 1);
      enforceDiskVersion = false;
      doc.content = old; await doc.save();
      const accepted = newSession(); accepted.active = true; accepted.acceptFile(doc.uri, old); accepted.markTouched(source);
      fs.writeFileSync(source, proposed); doc.content = proposed; doc.isDirty = true;
      accepted.refreshFor(doc.uri, proposed); accepted.noteAgentBuffer(doc, true);
      enforceDiskVersion = true;
      vscode.window.tabGroups.all = [{ tabs: [{ input: new vscode.TabInputText(doc.uri) }] }];
      await accepted.decide([source], () => accepted.acceptFile(doc.uri, proposed));
      assert.equal(doc.isDirty, false, "Final Accept clears a stale-version artificial dirty buffer by reloading, without saving");
      assert.equal(fs.readFileSync(source, "utf8"), proposed);
      vscode.window.tabGroups.all = [];
      const closed = newSession(); closed.active = true; closed.acceptFile(doc.uri, old); closed.markTouched(source);
      closed.refreshFor(doc.uri, proposed); doc.isDirty = true; closed.noteAgentBuffer(doc, true);
      const closedReloads = reloads.length;
      await closed.decide([source], () => closed.acceptFile(doc.uri, proposed));
      assert.equal(reloads.length, closedReloads, "Accepting a closed file never reopens it for native reload");
      assert.equal(closed.pendingCount, 0, "Closed-file acceptance resolves review normally");
      const temporary = path.join(root, "removed-temporary.txt");
      fs.writeFileSync(temporary, "temporary\n");
      closed.markTouched(temporary); closed.refreshFor(uri(temporary), "temporary\n");
      fs.unlinkSync(temporary);
      await closed.decide([temporary], () => assert(!closed.hunks.has(temporary), "Missing files are pruned before bulk decision capture"));
      assert(!fs.existsSync(temporary), "Pruning a temporary file never recreates it");
      enforceDiskVersion = false;
      await doc.save();
      const divergent = newSession(); divergent.active = true; divergent.acceptFile(doc.uri, old); divergent.markTouched(source); divergent.refreshFor(doc.uri, proposed); divergent.noteAgentBuffer(doc);
      doc.isDirty = true; fs.writeFileSync(source, "later external change\n");
      const beforeConflict = doc.getText();
      const beforeReloads = reloads.length;
      await divergent.rejectHunk(doc.uri, divergent.hunks.get(source)[0].id);
      assert(rejectionErrors.at(-1).includes("changed on disk"));
      assert.equal(divergent.pendingCount, 2, "Blocked rejection remains pending");
      assert.equal(doc.getText(), beforeConflict, "Disk divergence blocks Reject before mutating the buffer");
      assert.equal(fs.readFileSync(source, "utf8"), "later external change\n");
      assert.equal(reloads.length, beforeReloads, "Divergent disk never triggers destructive reload");
      doc.content = proposed; await doc.save();
      const scopeGuard = newSession(); scopeGuard.active = true; scopeGuard.acceptFile(doc.uri, old); scopeGuard.markTouched(source); scopeGuard.refreshFor(doc.uri, proposed); scopeGuard.noteAgentBuffer(doc);
      doc.isDirty = true;
      refuseFocus = true;
      vscode.window.activeTextEditor = { document: { uri: uri(outside) } };
      const reloadsBeforeWrongFocus = reloads.length;
      await scopeGuard.rejectHunk(doc.uri, scopeGuard.hunks.get(source)[0].id);
      assert.equal(reloads.length, reloadsBeforeWrongFocus, "Reject never reverts a different active editor");
      assert.equal(doc.getText(), proposed);
      assert.equal(scopeGuard.pendingCount, 2);
      refuseFocus = false; refuseReload = true;
      await scopeGuard.rejectHunk(doc.uri, scopeGuard.hunks.get(source)[0].id);
      assert.equal(doc.getText(), proposed, "An unsuccessful native reload blocks rejection before mutation");
      assert.equal(scopeGuard.pendingCount, 2);
      refuseReload = false;
      doc.content = proposed; await doc.save();
      const raced = newSession(); raced.active = true; raced.acceptFile(doc.uri, old); raced.markTouched(source); raced.refreshFor(doc.uri, proposed); raced.noteAgentBuffer(doc);
      raceAtSave = true;
      await raced.decide([source], async () => { await raced.rejectHunk(doc.uri, raced.hunks.get(source)[0].id); raced.refreshFor(doc.uri, doc.getText()); });
      assert.equal(doc.getText(), "alpha\nbeta\ngamma\nDELTA\n");
      assert.equal(doc.isDirty, true, "Failed native Save leaves rejection available in the editor");
      assert.equal(fs.readFileSync(source, "utf8"), "new external edit during save\n", "Save race preserves the external writer");
      assert(warnings.some(text => text.includes("Reject was applied in the editor but could not be saved")));
      assert(raced.canUndo, "Unsaved rejection is still captured in decision history");
      doc.content = proposed; await doc.save();
    }
    const pending = newSession(); pending.active = true; pending.acceptFile(doc.uri, old); pending.markTouched(source);
    const initial = pending.refreshFor(doc.uri, proposed);
    assert.equal(pending.refreshFor(doc.uri, proposed), initial, "Repeated render reuses the same diff computation");
    pending.acceptHunk(doc.uri, initial[0].id);
    assert.equal(pending.refreshFor(doc.uri, proposed).length, 1, "Baseline decisions invalidate cached diff results");
    const budgetFiles = Array.from({ length: 12 }, (_, index) => { const file = path.join(root, `budget-${index}.txt`); fs.writeFileSync(file, "x".repeat(1024)); return uri(file); });
    const findFiles = vscode.workspace.findFiles;
    vscode.workspace.findFiles = async () => budgetFiles;
    settings.set("maxSnapshotSizeMb", 5 / 1024);
    const budgetSession = new ReviewSession(undefined, file => file.startsWith(root)); sessions.push(budgetSession);
    budgetSession.active = true; budgetSession.mode = "all";
    const snapshot = await budgetSession.snapshotWorkspace();
    assert.equal(snapshot.size, 5, "Initial baselines stay within the configured source-byte budget");
    const skipped = budgetFiles.find(item => !snapshot.has(budgetSession.fileKey(item.fsPath)));
    assert.equal(budgetSession.shouldReview(skipped.fsPath), false, "Skipped existing files cannot be mistaken for new files");
    assert.equal(budgetSession.refreshFor(skipped, "changed").length, 0);
    budgetSession.baseline = snapshot; budgetSession.snapshotIncomplete = true;
    const unknown = uri(path.join(root, "unknown-existing.txt"));
    assert.equal(budgetSession.shouldReview(unknown.fsPath), false, "A truncated scan cannot treat unknown existing files as newly created files");
    assert.equal(budgetSession.refreshFor(unknown, "changed").length, 0);
    assert(budgetSession.shouldReview(budgetFiles.find(item => snapshot.has(budgetSession.fileKey(item.fsPath))).fsPath));
    settings.delete("maxSnapshotSizeMb");
    const binaryFile = path.join(root, "icon.png"), largeFile = path.join(root, "large.txt");
    fs.writeFileSync(binaryFile, Buffer.from([0, 1, 2, 3]));
    fs.writeFileSync(largeFile, Buffer.alloc(1024 * 1024 + 1, 120));
    const showWarning = vscode.window.showWarningMessage;
    let snapshotWarnings = 0;
    const diagnostics = [];
    vscode.window.showWarningMessage = () => { snapshotWarnings++; return new Promise(() => {}); };
    const quiet = new ReviewSession(undefined, file => file.startsWith(root), text => diagnostics.push(text)); sessions.push(quiet);
    vscode.workspace.findFiles = async () => [uri(source), uri(binaryFile), uri(largeFile)];
    await quiet.snapshotWorkspace();
    assert.equal(snapshotWarnings, 0, "Binary and oversized files are normal skips, not startup warnings");
    assert(diagnostics.some(text => text.includes("binary=1") && text.includes("size=1")));
    assert(diagnostics.some(text => text.includes("icon.png")));
    vscode.workspace.findFiles = async () => [uri(path.join(root, "missing.txt"))];
    let timeout;
    try {
      await Promise.race([quiet.start("all"), new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("Snapshot waited for warning dismissal")), 500); })]);
    } finally { clearTimeout(timeout); }
    assert.equal(snapshotWarnings, 1, "Read failures still notify without waiting for dismissal");
    assert(quiet.isActive, "Session becomes ready while the warning remains open");
    assert(diagnostics.some(text => text.includes("Snapshot skipped (read)") && text.includes("missing.txt")));
    quiet.stop();
    vscode.window.showWarningMessage = showWarning;
    vscode.workspace.findFiles = findFiles;
    console.log("UNDO, RESTART RESTORE, CONFLICT, RETENTION, PRIVACY, RESOLVED SAVE AND SNAPSHOT BUDGET TESTS PASSED");
  } finally {
    sessions.forEach(session => session.stop());
    // Remove only the test-created temporary directory, never workspace/user storage.
    const resolved = path.resolve(root);
    assert(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep + "aria-state-"));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
