const vscode = require("vscode");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check) {
  for (let i = 0; i < 60; i++) {
    if (await check()) return;
    await delay(200);
  }
  throw new Error("Timed out waiting for review UI");
}
async function lenses(uri) {
  return (await vscode.commands.executeCommand("vscode.executeCodeLensProvider", uri)) || [];
}
async function pending(uri) {
  return (await lenses(uri)).filter((lens) => lens.command?.command === "aria.reviewBlock" && lens.command.arguments.at(-1) === true);
}

exports.run = async () => {
  const report = path.resolve(__dirname, "../builds/aria-smoke-result.json");
  const steps = [];
  const pass = (step) => {
    steps.push(step);
    fs.writeFileSync(report, JSON.stringify({ status: "running", steps }, null, 2));
  };
  try {
    const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const uri = vscode.Uri.file(path.join(root, "existing file.txt"));
    const newUri = vscode.Uri.file(path.join(root, "new file.txt"));
    if (fs.existsSync(newUri.fsPath)) fs.rmSync(newUri.fsPath);
    const oldText = "a\nb\nc\nd\ne\nf\n";
    fs.writeFileSync(uri.fsPath, oldText);
    const extension = vscode.extensions.getExtension("krispachi.aria-review");
    assert(extension, "ARIA extension must be loaded");
    await extension.activate();
    await vscode.commands.executeCommand("opencodeInlineReview.start");

    const pluginModule = { exports: {} };
    const ts = require("typescript");
    const pluginCode = ts.transpileModule(fs.readFileSync(path.join(__dirname, "adapters/agent-review-watch.ts"), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
    vm.runInNewContext(pluginCode, { exports: pluginModule.exports, module: pluginModule, require, process });
    const plugin = await pluginModule.exports.OpenCodeReviewWatch({ directory: root, worktree: path.parse(root).root });
    await vscode.window.showTextDocument(uri);
    fs.writeFileSync(uri.fsPath, oldText.replace("b\n", "X\n").replace("e\n", "Y\n"));
    await plugin.event({ event: { type: "file.edited", properties: { file: uri.fsPath } } });
    await until(async () => (await pending(uri)).length === 2);
    await until(() => vscode.window.activeTextEditor?.document.uri.toString() === uri.toString());
    const reviewEditor = vscode.window.activeTextEditor;
    assert.equal(reviewEditor.document.uri.path, uri.path);
    assert.equal(reviewEditor.document.getText(), oldText.replace("b\n", "X\n").replace("e\n", "Y\n"));
    await until(() => reviewEditor.document.isDirty);
    assert.equal(vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === uri.toString()).length, 0, "Source is not duplicated in a plain tab");
    assert.equal(reviewEditor.selection.start.line, 1);
    assert.equal((await lenses(reviewEditor.document.uri)).filter(lens => lens.command?.command === "aria.reviewBlock").length, 4);
    pass("OpenCode event: editable native diff, dirty source, no duplicate source tab and automatic focus");
    const allCommands = await vscode.commands.getCommands();
    for (const command of ["aria.acceptFile", "aria.rejectFile", "aria.acceptAllFiles", "aria.rejectAllFiles"]) assert(allCommands.includes(command));
    await (await vscode.workspace.openTextDocument(uri)).save();
    assert.equal((await pending(uri)).length, 2);
    pass("File/workspace toolbar commands and Save without accepting review");
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    await vscode.window.showTextDocument(uri);
    await until(() => {
      const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      return input instanceof vscode.TabInputTextDiff && input.modified.toString() === uri.toString();
    });
    assert.equal((await pending(uri)).length, 2);
    pass("Saved pending source restores its review when reopened");

    const doc = await vscode.workspace.openTextDocument(uri);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, new vscode.Range(1, 0, 1, 1), "Manual");
    assert(await vscode.workspace.applyEdit(edit));
    await doc.save();
    assert.equal((await pending(uri)).length, 2);
    pass("Manual edit remains pending before Accept/Reject");
    const first = (await pending(uri))[0].command;
    await vscode.commands.executeCommand(first.command, ...first.arguments);
    assert.equal((await pending(uri)).length, 1);
    await vscode.commands.executeCommand("opencodeInlineReview.rejectAllInFile", uri);
    assert.equal(doc.getText(), oldText.replace("b\n", "Manual\n"));
    assert.equal((await pending(uri)).length, 0);
    pass("Accept one hunk then reject the other without losing the accepted edit");
    const manualOnly = new vscode.WorkspaceEdit();
    manualOnly.replace(uri, new vscode.Range(5, 0, 5, 1), "manual only");
    assert(await vscode.workspace.applyEdit(manualOnly));
    await delay(200);
    assert.equal((await pending(uri)).length, 0, "Manual changes after review do not spawn AI controls");
    await doc.save();
    pass("Manual edit after completed review produces no Accept/Reject");

    // Keep the first agent proposal dirty, then let the CLI write a newer
    // proposal before accepting one group and rejecting its last group.
    const beforeExternal = doc.getText();
    const firstExternal = beforeExternal.replace("Manual\n", "AI first\n").replace("e\n", "AI last\n");
    fs.writeFileSync(uri.fsPath, firstExternal);
    await plugin.event({ event: { type: "file.edited", properties: { file: uri.fsPath } } });
    await until(async () => doc.getText() === firstExternal && doc.isDirty && (await pending(uri)).length === 2);
    const newerExternal = firstExternal.replace("AI last\n", "AI last updated\n");
    fs.writeFileSync(uri.fsPath, newerExternal);
    await plugin.event({ event: { type: "file.edited", properties: { file: uri.fsPath } } });
    await until(async () => doc.getText() === newerExternal && (await pending(uri)).length === 2);
    const acceptExternal = (await pending(uri))[0].command;
    await vscode.commands.executeCommand(acceptExternal.command, ...acceptExternal.arguments);
    await until(async () => (await pending(uri)).length === 1);
    const rejectExternal = (await lenses(uri)).find(lens => lens.command?.command === "aria.reviewBlock" && lens.command.arguments.at(-1) === false).command;
    await vscode.commands.executeCommand(rejectExternal.command, ...rejectExternal.arguments);
    const expectedExternal = beforeExternal.replace("Manual\n", "AI first\n");
    await until(() => doc.getText() === expectedExternal && !doc.isDirty);
    assert.equal(fs.readFileSync(uri.fsPath, "utf8"), expectedExternal);
    assert.equal((await pending(uri)).length, 0);
    pass("Newer external CLI write: Accept one group then Reject last saves without stale disk-version conflict");

    fs.writeFileSync(newUri.fsPath, "new content\n");
    await plugin.event({ event: { type: "file.edited", properties: { file: newUri.fsPath } } });
    await until(async () => (await pending(newUri)).length === 1);
    pass("New file created after snapshot is detected");
    await vscode.commands.executeCommand("opencodeInlineReview.openEditableProposal", newUri);
    const proposal = vscode.window.activeTextEditor.document;
    assert.equal(proposal.uri.scheme, "oir-proposal");
    const proposalEdit = new vscode.WorkspaceEdit();
    proposalEdit.replace(proposal.uri, new vscode.Range(0, 0, 0, 11), "edited proposal");
    assert(await vscode.workspace.applyEdit(proposalEdit));
    await proposal.save();
    await vscode.commands.executeCommand("opencodeInlineReview.applyProposal", proposal.uri);
    assert.equal(fs.readFileSync(newUri.fsPath, "utf8"), "edited proposal\n");
    await until(async () => (await pending(newUri)).length === 0);
    pass("Writable proposal and Apply resolve the file");

    const outside = path.resolve(root, "../outside.txt");
    fs.writeFileSync(outside, "outside workspace\n");
    const store = require("./out/store.js");
    fs.appendFileSync(store.storeFileFor(root), JSON.stringify({ t: Date.now(), file: outside }) + "\n");
    await delay(3500);
    assert(!vscode.workspace.textDocuments.some((doc) => doc.uri.fsPath === outside));
    pass("Events outside workspace are ignored");
    fs.writeFileSync(report, JSON.stringify({ status: "passed", steps }, null, 2));
  } catch (error) {
    fs.writeFileSync(report, JSON.stringify({ status: "failed", steps, error: error.stack }, null, 2));
    throw error;
  } finally {
    await vscode.commands.executeCommand("opencodeInlineReview.stop");
  }
};
