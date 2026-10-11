const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const rpc = require("vscode-jsonrpc/node");
const { computeHunks } = require("./out/diff.js");
const { applyHunk, Session, DEFAULTS } = require("./out/session.js");
const { projectHash } = require("./out/store.js");

// Accepting every hunk yields the new text; rejecting every hunk yields the old one.
const cases = [
  ["a\nb\nc\n", "a\nX\nc\n"], ["a\nb\n", "a\nb"], ["a\nb", "a\nb\n"], ["", "x\ny\n"], ["x\ny\n", ""],
  ["a\r\nb\r\nc\r\n", "a\r\nB\r\nc\r\nd\r\n"], ["1\n2\n3\n4\n5\n", "0\n1\n3\n4\n5\n6\n"],
];
for (const [oldText, newText] of cases) {
  let baseline = oldText, current = newText;
  for (let hunks; (hunks = computeHunks(baseline, current)).length;) {
    const h = hunks[0];
    baseline = applyHunk(baseline, current, h.oldStart - 1, h.oldLines.length, h.newLines, h.newStart - 1);
  }
  assert.equal(baseline, newText, `accept all: ${JSON.stringify([oldText, newText])}`);
  current = newText;
  for (let hunks; (hunks = computeHunks(oldText, current)).length;) {
    const h = hunks.at(-1);
    current = applyHunk(current, oldText, h.newStart - 1, h.newLines.length, h.oldLines, h.oldStart - 1);
  }
  assert.equal(current, oldText, `reject all: ${JSON.stringify([oldText, newText])}`);
}

// A manual edit outside a pending block joins the baseline instead of the review.
const session = new Session("/r", DEFAULTS);
session.setBaseline("/r/f.txt", "a\nb\nc\nd\n");
session.touched.add(session.key("/r/f.txt"));
session.refresh("/r/f.txt", "a\nB\nc\nd\n");
session.observeManual("/r/f.txt", "a\nB\nc\nD\n");
assert.equal(session.baselineOf("/r/f.txt"), "a\nb\nc\nD\n");
assert.equal(session.hunks.get("/r/f.txt").length, 1);
console.log("SESSION UNIT TESTS PASSED");

// End to end over stdio, as Zed runs the server.
(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "aria-lsp-"));
  const root = path.join(temp, "project"), store = path.join(temp, "store");
  const file = path.join(root, "main.ts");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(file, "one\ntwo\nthree\n");
  // A fake Zed CLI records the diff the server asks Zed to open.
  const zedArgs = path.join(temp, "zed-args.json"), fakeZed = path.join(temp, "zed");
  fs.writeFileSync(fakeZed, `#!${process.execPath}\nrequire("fs").writeFileSync(${JSON.stringify(zedArgs)}, JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o755 });
  const child = spawn(process.execPath, [path.join(__dirname, "out/server.js"), "--stdio"], { env: { ...process.env, OIR_STORE_DIR: store, HOME: temp, USERPROFILE: temp, ZED_CLI: fakeZed } });
  const conn = rpc.createMessageConnection(new rpc.StreamMessageReader(child.stdout), new rpc.StreamMessageWriter(child.stdin));
  const diagnostics = [];
  let waiter;
  conn.onNotification("textDocument/publishDiagnostics", params => { diagnostics.push(params); waiter?.(); });
  // Zed delivers lsp.aria.settings only through workspace configuration.
  conn.onRequest("workspace/configuration", () => [{ adapterSetup: "off", openDiff: true }]);
  conn.onNotification("window/logMessage", () => {});
  conn.onNotification("window/showMessage", message => { if (message.type === 1) console.error("server error:", message.message); });
  conn.listen();
  const next = () => new Promise((resolve, reject) => { waiter = resolve; setTimeout(() => reject(new Error("timed out waiting for diagnostics")), 8000); });
  try {
    const rootUri = pathToFileURL(root).href, uri = pathToFileURL(file).href;
    await conn.sendRequest("initialize", { processId: process.pid, rootUri, workspaceFolders: [{ uri: rootUri, name: "project" }], capabilities: { workspace: { configuration: true } } });
    conn.sendNotification("initialized", {});
    await new Promise(resolve => setTimeout(resolve, 500)); // snapshot
    assert(!fs.existsSync(path.join(temp, ".claude")), "adapterSetup: off from workspace configuration must not install hooks");

    // The agent edits the file, then its hook records the event.
    fs.writeFileSync(file, "one\nTWO\nthree\nfour\n");
    const events = path.join(store, "projects", projectHash(root) + ".jsonl");
    fs.mkdirSync(path.dirname(events), { recursive: true });
    const published = next();
    fs.appendFileSync(events, JSON.stringify({ t: Date.now(), file, agent: "claude" }) + "\n");
    await published;
    const { diagnostics: pending } = diagnostics.at(-1);
    assert.equal(diagnostics.at(-1).uri, uri);
    assert.equal(pending.length, 2, "TWO and four are separate change groups");
    assert.match(pending[0].message, /claude/);
    assert.match(pending[0].message, /- two\n\+ TWO/);
    for (let i = 0; i < 50 && !fs.existsSync(zedArgs); i++) await new Promise(resolve => setTimeout(resolve, 100));
    const [existing, flag, baselineCopy, modified] = JSON.parse(fs.readFileSync(zedArgs, "utf8"));
    assert.deepEqual([existing, flag], ["--existing", "--diff"]);
    assert.equal(modified, file);
    assert.equal(fs.readFileSync(baselineCopy, "utf8"), "one\ntwo\nthree\n", "The diff's left side is the baseline");

    conn.sendNotification("textDocument/didOpen", { textDocument: { uri, languageId: "typescript", version: 1, text: fs.readFileSync(file, "utf8") } });
    const tokens = await conn.sendRequest("textDocument/semanticTokens/full", { textDocument: { uri } });
    // [deltaLine, start, length, type, modifiers]: line 1 "TWO" and line 3 "four", both aria-added.
    assert.deepEqual(tokens.data, [1, 0, 3, 0, 0, 2, 0, 4, 0, 0]);
    const hints = await conn.sendRequest("textDocument/inlayHint", { textDocument: { uri }, range: { start: { line: 0, character: 0 }, end: { line: 10, character: 0 } } });
    assert.deepEqual(hints.map(h => [h.position.line, h.label]), [[1, "was: two"]], "The replaced line shows its old text");
    // Adjacent chunks [0,1) and [1,10): the hint on line 1 is returned once.
    const chunked = [];
    for (const [from, to] of [[0, 1], [1, 10]]) chunked.push(...await conn.sendRequest("textDocument/inlayHint", { textDocument: { uri }, range: { start: { line: from, character: 0 }, end: { line: to, character: 0 } } }));
    assert.equal(chunked.length, 1, "No duplicate hints across chunk boundaries");
    assert.equal(hints[0].tooltip.value, "Removed by the agent:\n```ts\ntwo\n```", "The tooltip highlights the removed code");
    conn.sendNotification("textDocument/didClose", { textDocument: { uri } });

    const actions = await conn.sendRequest("textDocument/codeAction", { textDocument: { uri }, range: pending[0].range, context: { diagnostics: pending } });
    const titles = actions.map(a => a.title);
    assert(titles.some(t => t.startsWith("ARIA: Reject change")), titles.join(", "));
    assert(titles.some(t => t.startsWith("ARIA: Accept file")));

    const rejectAction = actions.find(a => a.title.startsWith("ARIA: Reject file"));
    const cleared = next();
    await conn.sendRequest("workspace/executeCommand", rejectAction.command);
    await cleared;
    assert.equal(fs.readFileSync(file, "utf8"), "one\ntwo\nthree\n", "Reject file restores the baseline on disk");
    assert.equal(diagnostics.at(-1).diagnostics.length, 0);

    const restored = next();
    await conn.sendRequest("workspace/executeCommand", { command: "aria.undo", arguments: [] });
    await restored;
    assert.equal(fs.readFileSync(file, "utf8"), "one\nTWO\nthree\nfour\n", "Undo restores the agent edit for review");
    assert.equal(diagnostics.at(-1).diagnostics.length, 2);

    const accepted = next();
    await conn.sendRequest("workspace/executeCommand", { command: "aria.acceptAll", arguments: [] });
    await accepted;
    assert.equal(diagnostics.at(-1).diagnostics.length, 0);
    assert.equal(fs.readFileSync(file, "utf8"), "one\nTWO\nthree\nfour\n");
    assert.equal(fs.readFileSync(baselineCopy, "utf8"), "one\nTWO\nthree\nfour\n", "Accepting updates the diff's left side");

    await conn.sendRequest("shutdown");
    console.log("LSP END-TO-END TEST PASSED");
  } finally {
    conn.dispose();
    child.kill();
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
