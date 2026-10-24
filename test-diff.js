const { computeHunks, normalize } = require("./out/diff.js");
const assert = require("assert");

function show(oldT, newT) {
  const hunks = computeHunks(oldT, newT);
  console.log(
    JSON.stringify(
      hunks.map((h) => ({
        id: h.id,
        newStart: h.newStart,
        oldStart: h.oldStart,
        oldLines: h.oldLines,
        newLines: h.newLines,
      })),
      null,
      1
    )
  );
  return hunks;
}

// 1) perubahan sederhana di tengah
let h = show("a\nb\nc\nd\ne\n", "a\nb\nX\nd\ne\n");
assert.strictEqual(h.length, 1);
assert.strictEqual(h[0].oldStart, 3);
assert.strictEqual(h[0].newStart, 3);
assert.deepStrictEqual(h[0].oldLines, ["c"]);
assert.deepStrictEqual(h[0].newLines, ["X"]);

// 2) penambahan murni
h = show("a\nb\n", "a\nNEW\nb\n");
assert.strictEqual(h.length, 1);
assert.strictEqual(h[0].oldStart, 2);
assert.strictEqual(h[0].newStart, 2);
assert.deepStrictEqual(h[0].oldLines, []);
assert.deepStrictEqual(h[0].newLines, ["NEW"]);

// 3) penghapusan murni
h = show("a\nGONE\nb\n", "a\nb\n");
assert.strictEqual(h.length, 1);
assert.deepStrictEqual(h[0].oldLines, ["GONE"]);
assert.deepStrictEqual(h[0].newLines, []);
assert.strictEqual(h[0].removedOnly, true);

// 4) banyak hunk
h = show("1\n2\n3\n4\n5\n6\n7\n8\n", "1\nX\n3\n4\n5\nY\n7\n8\n");
assert.strictEqual(h.length, 2);
assert.strictEqual(h[0].newStart, 2);
assert.strictEqual(h[1].newStart, 6);

// 5) file baru (old kosong)
h = show("", "a\nb\n");
assert.strictEqual(h.length, 1);
assert.deepStrictEqual(h[0].newLines, ["a", "b"]);

// 6) file CRLF -> seharusnya dianggap sama dengan LF
assert.strictEqual(computeHunks("a\r\nb\r\n", "a\nb\n").length, 0);

// 7) simulasikan reject: text baru, kembalikan oldLines pada range newStart..newStart+newLines
let oldT = "#include\nmain() {\n  return 1;\n}\nEOF\n";
let newT = "#include\nmain() {\n  return 2;\n  log('x');\n}\nEOF\n";
h = computeHunks(oldT, newT);
assert.strictEqual(h.length, 1);
const hh = h[0];
// reject: ganti range di newT
const lines = newT.split("\n");
const start = hh.newStart - 1;
const end = start + hh.newLines.length;
const eol = newT.includes("\r\n") ? "\r\n" : "\n";
const restored =
  lines.slice(0, start).join("\n") +
  (start > 0 ? "\n" : "") +
  hh.oldLines.join("\n") +
  "\n" +
  lines.slice(end).join("\n");
assert.strictEqual(computeHunks(oldT, restored).length, 0, "reject harus menghasilkan oldT");

async function testAdaptersAndSession() {
  const fs = require("node:fs");
  const path = require("node:path");
  const { spawnSync } = require("node:child_process");
  const vm = require("node:vm");
  const store = require("./out/store.js");
  const temp = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "aria-test-"));
  try {
    const root = path.join(temp, "Project With Spaces");
    const { DirectoryRegistry } = require("./out/directories.js");
    const registryState = new Map();
    const registryStorage = { get: (key, fallback) => registryState.get(key) ?? fallback, update: async (key, value) => registryState.set(key, JSON.parse(JSON.stringify(value))) };
    const registry = new DirectoryRegistry(registryStorage);
    const otherRoot = path.join(temp, "Other Project");
    assert(registry.isEnabled(root, "all"));
    assert(!registry.isEnabled(root, "init"));
    await registry.set(root, true);
    const initializedBefore = registry.initialized();
    assert(registry.isEnabled(root, "init"));
    assert(registry.isEnabled(otherRoot, "all"));
    assert(!registry.isEnabled(otherRoot, "init"));
    assert.deepEqual(registry.initialized(), initializedBefore, "Switching all/init must not change initialized directories");
    await registry.set(otherRoot, false);
    const reloadedRegistry = new DirectoryRegistry(registryStorage);
    assert(!reloadedRegistry.isEnabled(otherRoot, "all"));
    assert(reloadedRegistry.isEnabled(root, "init"), "Another directory stays enabled");
    await reloadedRegistry.set(root, false);
    assert.deepEqual(reloadedRegistry.initialized(), initializedBefore, "Disable retains the initialization history");
    const global = path.join(temp, "store");
    const runtime = path.resolve("adapters/record-event.mjs");
    const patch = "*** Begin Patch\r\n*** Update File: src/old name.ts\r\n*** Move to: src/new name.ts\r\n@@\r\n-old\r\n+new\r\n*** Add File: new file.ts\r\n+hello\r\n*** End Patch";
    const payloads = [
      { cwd: root, tool_name: "apply_patch", tool_input: { command: patch } },
      { cwd: root, tool_input: JSON.stringify({ patch }) },
      { cwd: root, data: { input: { apply_patch: patch } } },
      { cwd: root, input: patch },
      { cwd: root, tool_input: { file_path: "claude file.ts" } },
      { workspace_roots: [root], file_path: path.join(root, "cursor file.ts") },
      [{ root, file: "array one.ts" }, { root, file: "array two.ts" }],
    ];
    for (const payload of payloads) {
      const result = spawnSync(process.execPath, [runtime], {
        input: JSON.stringify(payload, null, 2), encoding: "utf8",
        env: { ...process.env, OIR_STORE_DIR: global }, timeout: 5000,
      });
      assert.strictEqual(result.status, 0, result.stderr);
      assert.strictEqual(result.stdout, "");
    }
    const eventsFile = path.join(global, "projects", store.projectHash(root) + ".jsonl");
    const events = fs.readFileSync(eventsFile, "utf8").trim().split("\n").map(JSON.parse);
    assert.strictEqual(events.length, 16);
    const geminiResult = spawnSync(process.execPath, [runtime, "--gemini"], {
      input: JSON.stringify({ cwd: root, hook_event_name: "AfterTool", tool_name: "replace", tool_input: { file_path: "gemini file.ts", old_string: "a", new_string: "b" } }),
      encoding: "utf8", env: { ...process.env, OIR_STORE_DIR: global }, timeout: 5000,
    });
    assert.equal(geminiResult.status, 0);
    assert.deepEqual(JSON.parse(geminiResult.stdout), {}, "Gemini receives valid neutral JSON, not a blocking decision");
    const geminiEvent = JSON.parse(fs.readFileSync(eventsFile, "utf8").trim().split("\n").at(-1));
    assert.equal(geminiEvent.file, path.join(root, "gemini file.ts"));
    assert.equal(geminiEvent.agent, "gemini");
    const tagged = spawnSync(process.execPath, [runtime, "--agent", "cursor"], {
      input: JSON.stringify({ root, file: "tagged cursor.ts", agent: "gemini", prompt: "private prompt" }),
      encoding: "utf8", env: { ...process.env, OIR_STORE_DIR: global }, timeout: 5000,
    });
    assert.equal(tagged.status, 0); assert.equal(tagged.stdout, "");
    const taggedEvent = JSON.parse(fs.readFileSync(eventsFile, "utf8").trim().split("\n").at(-1));
    assert.equal(taggedEvent.agent, "cursor", "The configured producer flag takes precedence over input payload");
    assert.deepEqual(Object.keys(taggedEvent).sort(), ["agent", "file", "t"], "Tagged events contain only producer ID, path and time");
    assert(events.some((ev) => ev.file === path.join(root, "cursor file.ts")));
    assert(events.some((ev) => ev.file === path.join(root, "src/new name.ts")));
    const hash = spawnSync(process.execPath, ["--input-type=module", "-e",
      'const m = await import(process.argv[1]); process.stdout.write(m.projectHash(process.argv[2]));',
      require("node:url").pathToFileURL(runtime).href, "C:\\Path With Spaces\\ROOT\\"], { input: "", encoding: "utf8" });
    assert.strictEqual(hash.status, 0, hash.stderr);
    assert.strictEqual(hash.stdout, store.projectHash("C:/Path With Spaces/ROOT/"));
    const bad = spawnSync(process.execPath, [runtime], { input: "not json\n{}\n", encoding: "utf8" });
    assert.strictEqual(bad.status, 0);
    fs.writeFileSync(path.join(temp, "blocked"), "file");
    const blocked = spawnSync(process.execPath, [runtime], {
      input: JSON.stringify({ root, file: "test.ts" }), encoding: "utf8",
      env: { ...process.env, OIR_STORE_DIR: path.join(temp, "blocked") },
    });
    assert.strictEqual(blocked.status, 0);

    let content = "a\r\nX\r\nc\r\nd\r\nY\r\nf\r\n";
    const uri = { fsPath: path.join(root, "session.ts"), scheme: "file" };
    const doc = {
      uri, eol: 2, isDirty: false, save: async () => { fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(uri.fsPath, content); doc.isDirty = false; return true; }, getText: () => content,
      positionAt: offset => { const parts = content.slice(0, offset).split("\r\n"); return { line: parts.length - 1, character: parts.at(-1).length }; },
      get lineCount() { return content.split("\r\n").length; },
      validatePosition: (position) => {
        const lines = content.split("\r\n");
        return position.line >= lines.length ? { line: lines.length - 1, character: lines.at(-1).length } : position;
      },
    };
    const vscode = {
      __esModule: true,
      EndOfLine: { CRLF: 2 },
      Position: class { constructor(line, character) { this.line = line; this.character = character; } },
      Range: class { constructor(start, end, endLine, endCharacter) { this.start = typeof start === "number" ? { line: start, character: end } : start; this.end = typeof start === "number" ? { line: endLine, character: endCharacter } : end; } },
      WorkspaceEdit: class { replace(uri, range, text, metadata) { this.range = range; this.text = text; this.metadata = metadata; } },
      workspace: {
        openTextDocument: async () => doc,
        applyEdit: async (edit) => {
          const lines = content.split("\r\n");
          const offset = (position) => lines.slice(0, position.line).reduce((n, s) => n + s.length + 2, 0) + position.character;
          content = content.slice(0, offset(edit.range.start)) + edit.text + content.slice(offset(edit.range.end));
          doc.isDirty = true;
          session.refreshFor(uri, content);
          return true;
        },
      },
      window: { visibleTextEditors: [], showErrorMessage: (msg) => { throw new Error(msg); } },
    };
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync("out/session.js", "utf8"), {
      exports: module.exports, module,
      require: (name) => name === "vscode" ? vscode : name === "./review" ? require("./out/review.js") : name === "./config" ? { reviewSetting: (_key, fallback) => fallback } : name === "./diff" ? require("./out/diff.js") : name === "./store" ? store : require(name),
      Buffer, setInterval, clearInterval,
    });
    const session = new module.exports.ReviewSession();
    // These pure diff cases model a disk already synchronized with the buffer;
    // real disk-version and save-race guards are covered in test-state.js.
    session.readDisk = async () => content;
    fs.mkdirSync(path.dirname(uri.fsPath), { recursive: true });
    fs.writeFileSync(uri.fsPath, content);
    session.active = true;
    const baseline = "a\r\nb\r\nc\r\nd\r\ne\r\nf\r\n";
    session.acceptFile(uri, baseline);
    session.markTouched(uri.fsPath);
    if (path.sep === "\\") {
      assert(session.shouldReview(uri.fsPath.toLowerCase()));
      assert.equal(session.baselineOf(uri.fsPath.toUpperCase()), baseline);
    }
    assert.strictEqual(session.refreshFor(uri, content).length, 2);
    assert.strictEqual(session.refreshFor(uri, content.replace("X", "manual edit")).length, 2);
    session.refreshFor(uri, content);
    await session.rejectAllInFile(uri);
    assert.strictEqual(content, baseline);
    content = "a\r\nX\r\nc\r\nd\r\nY\r\nf\r\n";
    session.refreshFor(uri, content);
    session.acceptHunk(uri, session.hunks.get(uri.fsPath)[0].id);
    assert.strictEqual(session.refreshFor(uri, content).length, 1);
    await session.rejectAllInFile(uri);
    assert.strictEqual(content, baseline.replace("b\r\n", "X\r\n"));
    session.acceptFile(uri, "a\r\nb");
    content = "a\r\nchanged";
    session.refreshFor(uri, content);
    await session.rejectAllInFile(uri);
    assert.strictEqual(content, "a\r\nb");
    session.acceptFile(uri, "proposal\r\n");
    assert.strictEqual(session.refreshFor(uri, "proposal\r\n").length, 0);
    assert.strictEqual(session.refreshFor(uri, "later edit\r\n").length, 1);
    assert.strictEqual(session.refreshFor({ fsPath: path.join(root, "new.ts") }, "hello\n").length, 1);
    for (const [before, after] of [["", "no newline"], ["a\n", ""], ["a", "a\nb"], ["", "new\r\n"]]) {
      session.acceptFile(uri, before);
      const pending = session.refreshFor(uri, after);
      session.acceptHunk(uri, pending[0].id);
      assert.equal(session.refreshFor(uri, after).length, 0, "Accept must preserve EOF and resolve the selected change");
    }
    session.eventsFile = path.join(temp, "events.jsonl");
    const event = JSON.stringify({ file: path.join(root, "partial.ts") });
    fs.writeFileSync(session.eventsFile, event.slice(0, 12));
    await session.ingestEvents();
    assert.strictEqual(session.readOffset, 0);
    fs.appendFileSync(session.eventsFile, event.slice(12) + "\n");
    await Promise.all([session.ingestEvents(), session.ingestEvents()]);
    assert(session.isTouched(path.join(root, "partial.ts")));
    fs.writeFileSync(session.eventsFile, JSON.stringify({ file: "x" }) + "\n");
    await session.ingestEvents();
    assert(session.isTouched("x"));

    const pluginModule = { exports: {} };
    const pluginCode = require("typescript").transpileModule(fs.readFileSync("adapters/agent-review-watch.ts", "utf8"), { compilerOptions: { module: require("typescript").ModuleKind.CommonJS } }).outputText;
    vm.runInNewContext(pluginCode, {
      exports: pluginModule.exports, module: pluginModule,
      require, process: { env: { OIR_STORE_DIR: global } },
    });
    const plugin = await pluginModule.exports.OpenCodeReviewWatch({ directory: root, worktree: path.parse(root).root });
    await plugin.event({ event: { type: "file.edited", properties: { file: "opencode file.ts" } } });
    const openCodeEvent = JSON.parse(fs.readFileSync(eventsFile, "utf8").trim().split("\n").at(-1));
    assert.strictEqual(openCodeEvent.file, path.join(root, "opencode file.ts"));
    assert.equal(openCodeEvent.agent, "opencode");
    let received;
    const routedSession = new module.exports.ReviewSession(async (files) => { received = files; });
    routedSession.active = true;
    routedSession.eventsFile = eventsFile;
    await routedSession.ingestEvents();
    assert(received.includes(openCodeEvent.file));
    assert(routedSession.shouldReview(openCodeEvent.file));

    const commands = new Map();
    for (const [oldText, newText, index] of [
      ["a\r\nb\r\nc\r\nd\r\n", "a\r\nB\r\nC\r\nd\r\n", 0],
      ["a\r\nb\r\nd\r\n", "a\r\nB\r\nC\r\nd\r\n", 1],
      ["a\r\nb\r\nc\r\nd\r\n", "a\r\nB\r\nd\r\n", 1],
      ["a\r\n", "a\r\nB\r\nC\r\n", 1],
      ["a\r\nb\r\nc\r\n", "a\r\n", 1],
    ]) {
      session.acceptFile(uri, oldText);
      content = newText;
      const hunk = session.refreshFor(uri, content)[0];
      const atomic = require("./out/review.js").lineHunk(hunk, index);
      const expectedLines = normalize(oldText).trimEnd().split("\n");
      expectedLines.splice(atomic.oldStart - 1, atomic.oldLines.length, ...atomic.newLines);
      session.acceptHunk(uri, hunk.id, index);
      session.refreshFor(uri, content);
      await session.rejectAllInFile(uri);
      assert.equal(content, expectedLines.join("\r\n") + "\r\n", "Accept one line then Reject All must preserve only the accepted line");
      session.acceptFile(uri, oldText);
      content = newText;
      session.refreshFor(uri, content);
      await session.rejectHunk(uri, hunk.id, index);
      const expectedNew = normalize(newText).trimEnd().split("\n");
      expectedNew.splice(atomic.newStart - 1, atomic.newLines.length, ...atomic.oldLines);
      assert.equal(content, expectedNew.join("\r\n") + "\r\n", "Reject one line must preserve its neighboring pending lines");
    }
    const decorations = new Map();
    const disposable = { dispose() {} };
    let lensProvider;
    const settings = { "aria.autoStart": false, "aria.adapterSetup": "off", "aria.autoOpen": true };
    vscode.workspace.workspaceFolders = [{ uri: { fsPath: root } }];
    let configurationChanged;
    vscode.ConfigurationTarget = { Global: 1, Workspace: 2 };
    let snapshotCalls = 0;
    vscode.workspace.getConfiguration = (namespace) => ({
      get: (key, fallback) => settings[namespace + "." + key] ?? fallback,
      inspect: (key) => ({ globalValue: settings[namespace + "." + key] }),
      update: async (key, value) => { settings[namespace + "." + key] = value; configurationChanged?.({ affectsConfiguration: prefix => prefix === namespace || prefix === namespace + "." + key }); },
    });
    vscode.workspace.findFiles = async () => { snapshotCalls++; return [uri]; };
    vscode.workspace.createFileSystemWatcher = () => ({ ...disposable, onDidChange: () => disposable, onDidCreate: () => disposable });
    vscode.workspace.registerFileSystemProvider = () => disposable;
    vscode.workspace.onDidChangeTextDocument = () => disposable;
    vscode.workspace.onDidChangeWorkspaceFolders = () => disposable;
    vscode.workspace.onDidChangeConfiguration = handler => { configurationChanged = handler; return disposable; };
    vscode.Uri = {
      file: (fsPath) => ({ fsPath, path: fsPath.replace(/\\/g, "/"), scheme: "file", toString: () => fsPath }),
      from: (parts) => ({ ...parts, toString: () => parts.scheme + ":" + parts.path + "?" + parts.query }),
    };
    vscode.EventEmitter = class { listeners = []; event = listener => { this.listeners.push(listener); return disposable; }; fire(value) { for (const listener of this.listeners) listener(value); } dispose() {} };
    vscode.Disposable = class { dispose() {} };
    vscode.MarkdownString = class { appendCodeblock() {} };
    vscode.ThemeColor = class { constructor(id) { this.id = id; } };
    const badgeProviders = [];
    vscode.window.registerFileDecorationProvider = provider => { badgeProviders.push(provider); return disposable; };
    vscode.CodeLens = class { constructor(range, command) { this.range = range; this.command = command; } };
    vscode.OverviewRulerLane = { Full: 1 };
    vscode.StatusBarAlignment = { Left: 1 };
    vscode.FileType = { File: 1 };
    vscode.FileChangeType = { Changed: 1 };
    vscode.ProgressLocation = { Notification: 1 };
    let decorationId = 0;
    const decorationOptions = [];
    vscode.window.createTextEditorDecorationType = (options) => { decorationOptions.push(options); return { id: decorationId++, ...disposable }; };
    const status = { ...disposable, show() { this.visible = true; }, hide() { this.visible = false; } };
    const statusItems = [];
    // Creation order: 4 ARIA decision buttons, 3 position/navigation items, then the main ARIA status item.
    vscode.window.createStatusBarItem = () => { const item = statusItems.length === 7 ? status : { ...disposable, show() { this.visible = true; }, hide() { this.visible = false; } }; statusItems.push(item); return item; };
    vscode.window.withProgress = async (_options, task) => task();
      const installMessages = [];
      vscode.window.showWarningMessage = (message) => { installMessages.push(message); };
      const adapterLog = [];
      let installerCalls = 0;
      const installerSelections = [];
      vscode.window.createOutputChannel = () => ({ ...disposable, clear() { adapterLog.length = 0; }, appendLine(line) { adapterLog.push(line); }, show() {} });
      vscode.window.showInformationMessage = (message) => { installMessages.push(message); };
    let panelProvider;
    vscode.window.registerTreeDataProvider = (_id, provider) => { panelProvider = provider; return disposable; };
    vscode.TreeItemCollapsibleState = { None: 0, Expanded: 2 };
    vscode.TreeItem = class { constructor(label, collapsibleState) { this.label = label; this.collapsibleState = collapsibleState; } };
    vscode.ThemeIcon = class { constructor(id) { this.id = id; } };
    vscode.window.onDidChangeTextEditorSelection = () => disposable;
    let activeEditorChanged;
    vscode.window.onDidChangeActiveTextEditor = handler => { activeEditorChanged = handler; return disposable; };
    let focusedOptions;
    let revealed;
    vscode.TextEditorRevealType = { InCenter: 1 };
    vscode.window.showTextDocument = async (document, options) => {
      focusedOptions = options;
      const editor = { document, selection: { active: options?.selection?.start ?? new vscode.Position(0, 0) }, setDecorations: (type, values) => decorations.set(type.id, values), revealRange: (range) => { revealed = range; } };
      vscode.window.visibleTextEditors = [editor];
      if (!options?.preserveFocus) vscode.window.activeTextEditor = editor;
      return editor;
    };
    vscode.commands = {
      registerCommand: (name, handler) => { commands.set(name, handler); return disposable; },
      executeCommand: async (name, ...args) => commands.get(name)?.(...args),
    };
    let lastDiff;
    const commandsSeen = [];
    vscode.ViewColumn = { One: 1 };
    vscode.TabInputText = class { constructor(uri) { this.uri = uri; } };
    vscode.TabInputTextDiff = class { constructor(original, modified) { this.original = original; this.modified = modified; } };
    vscode.window.tabGroups = { onDidChangeTabs: () => disposable, all: [{ viewColumn: 1, tabs: [] }], close: async tabs => { const list = Array.isArray(tabs) ? tabs : [tabs]; vscode.window.tabGroups.all[0].tabs = vscode.window.tabGroups.all[0].tabs.filter(tab => !list.includes(tab)); return true; } };
    Object.defineProperty(vscode.window.tabGroups, "activeTabGroup", { get: () => ({ activeTab: vscode.window.tabGroups.all[0].tabs.at(-1) }) });
    const execute = vscode.commands.executeCommand;
    vscode.commands.executeCommand = async (name, ...args) => {
      commandsSeen.push({ name, args });
      if (name === "workbench.action.files.revert") { content = fs.readFileSync(doc.uri.fsPath, "utf8"); doc.isDirty = false; return; }
      if (name !== "vscode.diff") return execute(name, ...args);
      lastDiff = { original: args[0], modified: args[1] };
      const tabs = vscode.window.tabGroups.all[0].tabs;
      if (!tabs.some(tab => tab.input instanceof vscode.TabInputTextDiff)) tabs.push({ input: new vscode.TabInputTextDiff(args[0], args[1]) });
      if (args[3]?.background) { focusedOptions = args[3]; return; }
      return vscode.window.showTextDocument(doc, args[3]);
    };
    let reviewProvider;
    let contentProvider;
    vscode.workspace.registerTextDocumentContentProvider = (_scheme, provider) => { contentProvider = provider; return disposable; };
    vscode.workspace.openTextDocument = async (target) => target.scheme === "aria-baseline" ? { uri: target, languageId: "typescript", getText: () => contentProvider.provideTextDocumentContent(target) } : doc;
    vscode.languages = { registerCodeLensProvider: (selector, provider) => { reviewProvider = provider; lensProvider = provider; return disposable; }, setTextDocumentLanguage: async () => {} };
    doc.uri = vscode.Uri.file(uri.fsPath);
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(uri.fsPath, baseline);
    content = baseline;
    const configModule = { exports: {} };
    vm.runInNewContext(fs.readFileSync("out/config.js", "utf8"), {
      exports: configModule.exports, module: configModule, require: () => vscode,
    });
    assert.equal(configModule.exports.reviewSetting("autoStart", true), false);
    delete settings["aria.autoStart"];
    settings["agentInlineReview.autoStart"] = false;
    assert.equal(configModule.exports.reviewSetting("autoStart", true), false);
    delete settings["agentInlineReview.autoStart"];
    assert.equal(configModule.exports.reviewSetting("autoStart", true), true);
    settings["aria.autoStart"] = false;
    const filteredEvents = path.join(temp, "filtered-events.jsonl");
    const cursorPath = path.join(root, "cursor-only.ts"), geminiPath = path.join(root, "gemini-only.ts"), legacyPath = path.join(root, "legacy-only.ts");
    fs.writeFileSync(filteredEvents, [{ file: geminiPath, agent: "gemini" }, { file: cursorPath, agent: "cursor" }, { file: legacyPath }, { file: geminiPath, agent: 123 }].map(JSON.stringify).join("\n") + "\n");
    let receivedFiltered;
    const filteredSession = new module.exports.ReviewSession(async files => { receivedFiltered = [...files]; }, () => true, () => {}, configModule.exports.agentEnabled);
    filteredSession.active = true; filteredSession.eventsFile = filteredEvents;
    settings["aria.agents.gemini.enabled"] = false;
    await filteredSession.ingestEvents();
    assert.deepEqual(receivedFiltered, [cursorPath]);
    assert.equal(filteredSession.isTouched(geminiPath), false, "Disabled agent events never mark files touched");
    assert.equal(filteredSession.isTouched(legacyPath), false, "Legacy events do not bypass per-agent disable");
    const consumed = filteredSession.readOffset;
    assert.equal(consumed, fs.statSync(filteredEvents).size);
    settings["aria.agents.gemini.enabled"] = true;
    await filteredSession.ingestEvents();
    assert.equal(filteredSession.readOffset, consumed, "Re-enabling does not replay discarded agent events");
    fs.appendFileSync(filteredEvents, JSON.stringify({ file: geminiPath, agent: "gemini" }) + "\n");
    await filteredSession.ingestEvents();
    assert.equal(filteredSession.isTouched(geminiPath), true, "New edits from a re-enabled agent are reviewed");
    const sharedPath = path.join(root, "shared-by-agents.ts");
    fs.writeFileSync(sharedPath, "one\nTWO-from-disabled-agent\nthree\n");
    filteredSession.baseline.set(filteredSession.fileKey(sharedPath), "one\ntwo\nthree\n");
    settings["aria.agents.gemini.enabled"] = false;
    fs.appendFileSync(filteredEvents, JSON.stringify({ file: sharedPath, agent: "gemini" }) + "\n");
    await filteredSession.ingestEvents();
    assert.equal(filteredSession.isTouched(sharedPath), false);
    assert.equal(filteredSession.baselineOf(sharedPath), "one\nTWO-from-disabled-agent\nthree\n", "Disabled-agent edits move the baseline so a later enabled agent does not inherit them");
    settings["aria.agents.gemini.enabled"] = true;
    fs.unlinkSync(sharedPath);
    filteredSession.stop();

    const extensionModule = { exports: {} };
    const persisted = new Map();
    const context = { subscriptions: [], extension: { packageJSON: { version: "0.13.0" } }, globalState: { get: (key, fallback) => persisted.has(key) ? persisted.get(key) : fallback, update: async (key, value) => { persisted.set(key, value); } } };
    const { NotificationPolicy } = require("./out/notifications.js");
    const once = new NotificationPolicy(context.globalState);
    assert(await once.claim("once"));
    assert.equal(await once.claim("once"), false);
    assert.equal(await new NotificationPolicy(context.globalState).claim("once"), false, "Welcome stays hidden after restart or upgrade");
    const minimal = new NotificationPolicy(context.globalState);
    assert(await minimal.claim("minimal"));
    assert.equal(await minimal.claim("minimal"), false);
    assert(await new NotificationPolicy(context.globalState).claim("minimal"), "New window gets one minimal notification");
    assert(await minimal.claim("full"));
    assert(await minimal.claim("full"));
    persisted.delete("ariaWelcomeShown");
    const scheduled = [];
    const panelModule = { exports: {} };
    vm.runInNewContext(fs.readFileSync("out/panel.js", "utf8"), { exports: panelModule.exports, module: panelModule, require: name => name === "vscode" ? vscode : name === "./session" ? module.exports : require(name) });
    const inlineModule = { exports: {} };
    vm.runInNewContext(fs.readFileSync("out/inline-review.js", "utf8"), {
      exports: inlineModule.exports, module: inlineModule,
      require: (name) => name === "vscode" ? vscode : name === "./review" ? require("./out/review.js") : name === "./config" ? configModule.exports : name === "./session" ? module.exports : require(name),
    });
    const previousStore = process.env.OIR_STORE_DIR;
    process.env.OIR_STORE_DIR = global;
    try {
      vm.runInNewContext(fs.readFileSync("out/extension.js", "utf8"), {
        exports: extensionModule.exports, module: extensionModule,
        require: (name) => name === "vscode" ? vscode : name === "./uninstall" ? require("./out/uninstall.js") : name === "./panel" ? panelModule.exports : name === "./persistence" ? require("./out/persistence.js") : name === "./notifications" ? require("./out/notifications.js") : name === "./directories" ? require("./out/directories.js") : name === "./diff" ? require("./out/diff.js") : name === "./inline-review" ? inlineModule.exports : name === "./session" ? module.exports : name === "./config" ? configModule.exports : name === "./adapters" ? { adaptersStatus: () => [{ agent: "codex", installed: true }], setupAdapters: async (_context, selected) => { installerSelections.push([...selected]); installerCalls++; return [{ agent: "codex", ok: true, message: "Installed" }]; } } : require(name),
        Buffer, process, setTimeout: (callback) => { scheduled.push(callback); return 0; },
      });
      extensionModule.exports.activate(context);
      vscode.workspace.isTrusted = false;
      await commands.get("opencodeInlineReview.setupAdapters")();
      assert.equal(installerCalls, 0, "Untrusted workspaces must not install adapters");
      vscode.workspace.isTrusted = true;
      await commands.get("opencodeInlineReview.setupAdapters")();
      assert.equal(installerCalls, 1, "Manual install must run without a second confirmation");
      assert(adapterLog.some((line) => line.includes("codex")), "Installation results must remain in Output");
      assert(!installMessages.some((message) => message.includes("install CLI agent adapters at user level?")));
      await commands.get("opencodeInlineReview.start")();
      const manualEditor = { document: { uri: vscode.Uri.file(path.join(root, "manual-work.ts")) }, selection: { active: new vscode.Position(12, 3) } };
      vscode.window.activeTextEditor = manualEditor;
      vscode.window.tabGroups.all[0].tabs.push({ input: new vscode.TabInputText(doc.uri) });
      content = baseline.replace("b\r\n", "X\r\n").replace("e\r\n", "Y\r\n");
      fs.writeFileSync(uri.fsPath, content);
      await plugin.event({ event: { type: "file.edited", properties: { file: uri.fsPath } } });
      for (let i = 0; i < 50 && !vscode.window.tabGroups.all[0].tabs.some(tab => tab.input instanceof vscode.TabInputTextDiff); i++) await new Promise((resolve) => setTimeout(resolve, 100));
      assert(vscode.window.tabGroups.all[0].tabs.some(tab => tab.input instanceof vscode.TabInputTextDiff), "Agent review tab must open automatically in the background");
      assert.equal(vscode.window.visibleTextEditors.length, 0, "Background tab does not replace the visible editor");
      assert.equal(vscode.window.activeTextEditor, manualEditor, "AI edits preserve focus in a different file being edited manually");
      assert.equal(focusedOptions.preserveFocus, true);
      assert.equal(revealed, undefined, "Automatic review does not reveal or scroll changed lines");
      await commands.get("aria.openChange")(doc.uri, 1);
      assert.equal(panelProvider.getChildren().length, 1, "Changes view lists the pending file");
      const fileNode = panelProvider.getChildren()[0];
      assert.equal(panelProvider.getChildren(fileNode).length, 2, "Changes view lists each pending group");
      assert.equal(panelProvider.getTreeItem(fileNode).contextValue, "aria.file");
      assert(statusItems.some(item => item.text === "$(diff) 1/2"), "Position shows the focused group and total");
      const uiLenses = lensProvider.provideCodeLenses(doc);
      assert.equal(uiLenses.filter((lens) => lens.command.command === "aria.reviewBlock" && lens.command.arguments.at(-1) === true).length, 2);
      const manifest = JSON.parse(fs.readFileSync("package.json", "utf8"));
      assert.equal(manifest.contributes.configurationDefaults["diffEditor.experimental.useTrueInlineView"], false, "Character replacements should retain separate full old/new rows");
      const lastContext = key => commandsSeen.filter(item => item.name === "setContext" && item.args[0] === key).at(-1)?.args[1];
      const button = text => statusItems.find(item => item.text === text);
      assert.equal(lastContext("aria.fileActionsInToolbar"), false, "File decisions default to the status bar");
      assert.equal(lastContext("aria.allActionsInToolbar"), false, "All-file decisions default to the status bar");
      for (const text of ["$(check) Accept File", "$(discard) Reject File", "$(check-all) Accept All", "$(close-all) Reject All"]) assert.equal(button(text)?.visible, true, text + " is shown in the status bar while changes are pending");
      settings["aria.fileActionsLocation"] = "editorToolbar"; settings["aria.allActionsLocation"] = "hidden";
      await commands.get("opencodeInlineReview.recompute")();
      await new Promise(resolve => setTimeout(resolve, 0));
      assert.equal(lastContext("aria.fileActionsInToolbar"), true);
      assert.equal(button("$(check) Accept File").visible, false, "Toolbar-only file actions leave the status bar");
      assert.equal(lastContext("aria.allActionsInToolbar"), false);
      assert.equal(button("$(check-all) Accept All").visible, false, "Hidden all-file actions appear nowhere");
      settings["aria.fileActionsLocation"] = "both";
      await commands.get("opencodeInlineReview.recompute")();
      await new Promise(resolve => setTimeout(resolve, 0));
      assert.equal(lastContext("aria.fileActionsInToolbar"), true);
      assert.equal(button("$(check) Accept File").visible, true, "Both shows file actions in toolbar and status bar");
      delete settings["aria.fileActionsLocation"]; delete settings["aria.allActionsLocation"];
      await commands.get("opencodeInlineReview.recompute")();
      await new Promise(resolve => setTimeout(resolve, 0));
      assert(!manifest.contributes.menus["editor/title"].some(item => ["aria.previousChange", "aria.nextChange"].includes(item.command)), "Previous/Next live in the status bar, not the editor toolbar");
      const toolbarCommands = manifest.contributes.menus["editor/title"].map(item => item.command);
      for (const command of ["aria.acceptFile", "aria.rejectFile", "aria.acceptAllFiles", "aria.rejectAllFiles"]) assert(toolbarCommands.includes(command), "File/workspace controls must be in the fixed editor toolbar");
      assert.equal(decorationOptions.length, 0, "Native diff colors must not be overlaid by source decorations");
      assert(!decorationOptions.some(options => options.before), "Side-by-side text preview is removed");
      assert.equal(vscode.window.visibleTextEditors[0].document.uri.scheme, "file");
      assert.equal(vscode.window.tabGroups.all[0].tabs.length, 1, "Existing source tab is replaced by one diff tab");
      assert(doc.isDirty, "Agent edit creates a native dirty source buffer");
      assert.equal(focusedOptions.preserveFocus, false, "Explicit review navigation takes focus");
      const reviewDoc = vscode.window.visibleTextEditors[0].document;
      assert(!reviewDoc.getText().includes("b\r\n"), "Editable source contains only proposed code");
      assert(contentProvider.provideTextDocumentContent(lastDiff.original).includes("b\r\n"), "Readonly baseline supplies old code to native diff");
      assert.equal(revealed.start.line, 1, "Initial review focuses the first changed row");
      assert(commandsSeen.some(item => item.name === "editor.unfold" && item.args[0].selectionLines[0] === 1), "Navigation unfolds the focused changed code");
      settings["aria.showPosition"] = false; panelProvider.refresh();
      assert.equal(statusItems.find(item => item.text.startsWith("$(diff)")).visible, false, "Position can be hidden");
      settings["aria.showPosition"] = true; panelProvider.refresh();
      settings["aria.autoUnfold"] = false;
      const unfoldsBefore = commandsSeen.filter(item => item.name === "editor.unfold").length;
      await commands.get("aria.nextChange")();
      assert.equal(commandsSeen.filter(item => item.name === "editor.unfold").length, unfoldsBefore, "Auto unfold can be disabled");
      await commands.get("aria.previousChange")();
      settings["aria.autoUnfold"] = true;
      const beforeNavigation = content;
      await commands.get("aria.nextChange")();
      assert.equal(revealed.start.line, 4, "Next focuses the following group");
      await commands.get("aria.previousChange")();
      assert.equal(revealed.start.line, 1, "Previous focuses the preceding group");
      await commands.get("aria.previousChange")();
      assert.equal(revealed.start.line, 4, "Previous wraps to the last group");
      await commands.get("aria.nextChange")();
      assert.equal(revealed.start.line, 1, "Next wraps to the first group");
      assert.equal(content, beforeNavigation, "Navigation does not change code");
      assert.equal(lensProvider.provideCodeLenses(doc).length, 4, "Navigation leaves decisions pending");
      content = content.replace("Y\r\n", "Z\r\n");
      fs.writeFileSync(uri.fsPath, content);
      await plugin.event({ event: { type: "file.edited", properties: { file: uri.fsPath } } });
      for (let i = 0; i < 20; i++) await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(revealed.start.line, 1, "A later edit leaves the user's current scroll position intact");
      assert.equal(badgeProviders[0].provideFileDecoration(doc.uri).badge, "M", "Pending review gets an Explorer marker");
      await doc.save();
      vscode.window.tabGroups.all[0].tabs = [{ input: new vscode.TabInputText(doc.uri) }];
      const reopened = await vscode.window.showTextDocument(doc, { selection: new vscode.Range(0, 0, 0, 0) });
      activeEditorChanged(reopened);
      for (let i = 0; i < 20 && !(vscode.window.tabGroups.all[0].tabs[0]?.input instanceof vscode.TabInputTextDiff); i++) await new Promise(resolve => setTimeout(resolve, 10));
      assert(vscode.window.tabGroups.all[0].tabs[0].input instanceof vscode.TabInputTextDiff, "Saved pending source reopens in its snapshot diff");
      assert(contentProvider.provideTextDocumentContent(lastDiff.original).includes("b\r\n"));
      assert.equal(badgeProviders[0].provideFileDecoration(doc.uri).badge, "M", "Save and reopen retain pending marker");
      const reviewLenses = reviewProvider.provideCodeLenses(reviewDoc);
      assert(!manifest.contributes.keybindings?.some(binding => binding.key === "ctrl+s"), "Native Save shortcut must remain owned by VS Code");
      await doc.save();
      assert(status.text.includes("2 change(s)"), "Save must not accept changes");
      const lineControls = reviewLenses.filter(lens => lens.command.command === "aria.reviewBlock");
      assert.equal(lineControls.length, 4, "Two replacements have one Accept/Reject pair each");
      settings["aria.showBlockActions"] = false;
      assert.equal(reviewProvider.provideCodeLenses(reviewDoc).length, 0, "Inline actions can be hidden");
      settings["aria.showBlockActions"] = true;
      settings["aria.showPendingBadge"] = false;
      assert.equal(badgeProviders[0].provideFileDecoration(doc.uri), undefined, "Pending badge can be hidden");
      settings["aria.showPendingBadge"] = true;
      assert.deepEqual([...new Set(lineControls.map(lens => lens.range.start.line))], [0, 3], "By default controls precede replacement groups (above the preceding unchanged row)");
      settings["aria.blockActionsAnchor"] = "firstChangedRow";
      assert.deepEqual([...new Set(reviewProvider.provideCodeLenses(reviewDoc).filter(lens => lens.command.command === "aria.reviewBlock").map(lens => lens.range.start.line))], [1, 4], "firstChangedRow puts controls directly above the first new row");
      delete settings["aria.blockActionsAnchor"];
      assert(status.text.includes("1 file(s) · 2 change(s)"));
      const acceptLine = reviewLenses.find(lens => lens.command.command === "aria.reviewBlock" && lens.command.arguments.at(-1) === true).command;
      await commands.get("aria.reviewBlock")(...acceptLine.arguments);
      assert.equal(revealed.start.line, 4, "Accept automatically focuses the next pending block");
      await commands.get("aria.undoDecision")();
      assert(status.text.includes("2 change(s)"), "Undo Accept restores both pending blocks");
      await commands.get("aria.reviewBlock")(...acceptLine.arguments);
      assert(status.text.includes("1 file(s) · 1 change(s)"), "One line action leaves the other change pending");
      await commands.get("aria.reviewBlock")(...acceptLine.arguments);
      assert(installMessages.some(message => message.includes("The file changed")), "Stale row actions must not apply to a different baseline");
      await commands.get("aria.acceptAllFiles")();
      assert.equal(badgeProviders[0].provideFileDecoration(doc.uri), undefined, "Resolved review removes the pending marker");
      assert(status.text.includes("0 file(s) · 0 change(s)"));
      content = content.replace("a\r\n", "ALPHA\r\n");
      fs.writeFileSync(uri.fsPath, content);
      await plugin.event({ event: { type: "file.edited", properties: { file: uri.fsPath } } });
      for (let i = 0; i < 50 && !status.text.includes("1 file(s)"); i++) await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(reviewProvider.provideCodeLenses(doc).length, 2, "First-row replacements keep inline Accept/Reject");
      assert.equal(panelProvider.getChildren(panelProvider.getChildren()[0]).length, 1);
      await commands.get("aria.acceptCurrentChange")();
      assert(status.text.includes("0 file(s)"), "Current Change toolbar resolves first-row replacements");
      settings["aria.autoOpen"] = false;
      vscode.window.visibleTextEditors = [];
      content = content.replace("X\r\n", "subfolder edit\r\n");
      const subPlugin = await pluginModule.exports.OpenCodeReviewWatch({ directory: path.join(root, "subfolder"), worktree: path.parse(root).root });
      fs.writeFileSync(uri.fsPath, content);
      await subPlugin.event({ event: { type: "file.edited", properties: { file: uri.fsPath } } });
      for (let i = 0; i < 50 && !status.text.includes("1 file(s)"); i++) await new Promise((resolve) => setTimeout(resolve, 100));
      assert(status.text.includes("1 file(s) · 1 change(s)"), "Agent in subfolder must track unopened files");
      assert.equal(vscode.window.visibleTextEditors.length, 0, "Auto-open can be disabled");
      await commands.get("opencodeInlineReview.acceptAll")();
      assert(status.text.includes("0 file(s) · 0 change(s)"));
      await commands.get("aria.disable")();
      const directoryKey = process.platform === "win32" ? path.resolve(root).toLowerCase() : path.resolve(root);
      assert.equal(persisted.get("ariaDirectories")[directoryKey].enabled, false, "Disable is persisted per directory");
      const beforeAutomatic = installerCalls;
      settings["aria.adapterSetup"] = "auto";
      for (const callback of scheduled) callback();
      await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(installerCalls, beforeAutomatic, "Disabled ARIA must not install adapters automatically");
      assert.equal(status.text, "$(eye) ARIA Review");
      persisted.delete("adapterSetupVersion");
      await commands.get("aria.enable")();
      assert.equal(persisted.get("ariaDirectories")[directoryKey].enabled, true);
      assert.equal(installerCalls, beforeAutomatic + 1, "Enable must install adapters without an Install dialog");
      assert.equal(persisted.get("adapterSetupVersion"), "0.13.0");
      await commands.get("aria.enable")();
      assert.equal(installerCalls, beforeAutomatic + 1, "Do not rewrite healthy adapters repeatedly");
      const beforeAgentSnapshot = snapshotCalls;
      vscode.window.showQuickPick = async (items, options) => options?.canPickMany ? items.filter(item => item.agent !== "gemini") : undefined;
      await commands.get("aria.configureAgents")();
      assert.equal(settings["aria.agents.gemini.enabled"], false);
      assert.equal(snapshotCalls, beforeAgentSnapshot, "Per-agent choices do not rescan an active workspace");
      assert(!installerSelections.at(-1).includes("gemini"), "Automatic setup installs only enabled agents");
      assert(installerSelections.at(-1).includes("cursor"));
      const snapshotBeforeTrackAll = snapshotCalls;
      await commands.get("opencodeInlineReview.toggleTrackAll")();
      assert.equal(settings["aria.track"], undefined, "Track All cannot bypass source filtering");
      await commands.get("aria.init")();
      const savedDirectories = JSON.stringify(persisted.get("ariaDirectories"));
      const savedAgentPreferences = settings["aria.agents.gemini.enabled"];
      const beforeDisableInstalls = installerCalls;
      await commands.get("aria.disableAll")();
      assert.equal(settings["aria.enabled"], false);
      assert.equal(status.text, "$(eye-closed) ARIA Off");
      assert.equal(status.command, "aria.enableAll");
      const disabledSnapshots = snapshotCalls;
      await commands.get("opencodeInlineReview.start")();
      for (const callback of scheduled) callback();
      await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(snapshotCalls, disabledSnapshots, "Global disable blocks manual/automatic snapshot start");
      assert.equal(installerCalls, beforeDisableInstalls, "Global disable blocks adapter installation");
      assert.equal(JSON.stringify(persisted.get("ariaDirectories")), savedDirectories, "Global off preserves Init and per-directory choices");
      await commands.get("aria.enableAll")();
      assert.equal(settings["aria.enabled"], true);
      assert.equal(JSON.stringify(persisted.get("ariaDirectories")), savedDirectories);
      assert.equal(settings["aria.agents.gemini.enabled"], savedAgentPreferences);
      await commands.get("opencodeInlineReview.start")();
      assert(snapshotCalls > disabledSnapshots, "Global enable permits a new review session");
      const beforeAllAgentOffInstalls = installerCalls;
      vscode.window.showQuickPick = async (_items, options) => options?.canPickMany ? [] : undefined;
      await commands.get("aria.configureAgents")();
      assert.equal(configModule.exports.enabledAgents().length, 0);
      assert.equal(settings["aria.enabled"], true, "Choosing no agents does not overwrite the global switch");
      assert.equal(status.command, "aria.configureAgents");
      const allAgentOffSnapshots = snapshotCalls;
      await commands.get("opencodeInlineReview.start")();
      await commands.get("opencodeInlineReview.setupAdapters")();
      assert.equal(snapshotCalls, allAgentOffSnapshots);
      assert.equal(installerCalls, beforeAllAgentOffInstalls, "All agents off skips snapshots and hook setup");
      vscode.window.showQuickPick = async (items, options) => options?.canPickMany ? items : undefined;
      await commands.get("aria.configureAgents")();
      assert.equal(configModule.exports.enabledAgents().length, 6);
      assert.equal(JSON.stringify(persisted.get("ariaDirectories")), savedDirectories);
      settings["aria.agents.gemini.enabled"] = true;
      console.log("OPENCode EVENT -> WATCHER -> UI CONTROLS TEST PASSED (VS Code API mock)");
    } finally {
      await extensionModule.exports.deactivate?.();
      if (previousStore === undefined) delete process.env.OIR_STORE_DIR;
      else process.env.OIR_STORE_DIR = previousStore;
    }

    session.acceptFile(doc.uri, baseline);
    content = baseline.replace("b\r\nc\r\n", "B\r\nC\r\n");
    session.refreshFor(doc.uri, content);
    session.markTouched(doc.uri.fsPath);
    const groupedReview = new inlineModule.exports.InlineReview(session, () => {}, () => false);
    const groupedModel = groupedReview.update(doc);
    const groupedDoc = doc;
    const groupedControls = reviewProvider.provideCodeLenses(groupedDoc).filter(lens => lens.command.command === "aria.reviewBlock");
    assert.equal(groupedControls.length, 2, "Two adjacent changed lines must share one Accept/Reject pair");
    assert(groupedControls.every(lens => !lens.command.title.includes("Block")), "Actions are labelled Accept/Reject");
    fs.writeFileSync(doc.uri.fsPath, content);
    const rejectBlock = groupedControls.find(lens => lens.command.arguments.at(-1) === false).command;
    const previousFocus = revealed;
    await commands.get("aria.reviewBlock")(...rejectBlock.arguments);
    assert.equal(revealed, previousFocus, "Disabled auto-advance retains editor position");
    assert.equal(content, baseline, "Reject Block restores all adjacent old lines together");
    content = baseline.replace("b\r\nc\r\n", "B\r\nC\r\n");
    session.refreshFor(doc.uri, content);
    groupedReview.update(doc);
    session.markTouched(doc.uri.fsPath);
    const acceptBlock = reviewProvider.provideCodeLenses(groupedDoc).find(lens => lens.command.command === "aria.reviewBlock" && lens.command.arguments.at(-1) === true).command;
    await commands.get("aria.reviewBlock")(...acceptBlock.arguments);
    assert.equal(content, baseline.replace("b\r\nc\r\n", "B\r\nC\r\n"));
    assert.equal(session.hunks.has(doc.uri.fsPath), false, "Accept Block resolves this file without touching other pending files");
    assert.equal(session.shouldReview(doc.uri.fsPath), false, "Resolved files stop tracking subsequent untagged or disabled-agent edits");
    const acceptedContent = content;
    content += "ignored agent edit\r\n";
    groupedReview.render({ document: doc });
    assert.equal(contentProvider.provideTextDocumentContent(groupedModel.uri), content, "Resolved native diff follows ignored edits without stale red/green lines");
    assert.equal(session.baselineOf(doc.uri.fsPath), acceptedContent, "Display refresh preserves comparison baseline for the next enabled hook");
    assert.equal(reviewProvider.provideCodeLenses(doc).length, 0, "Ignored edits do not resurrect decision controls");
    session.markTouched(doc.uri.fsPath);
    assert(session.refreshFor(doc.uri, content).length > 0, "A new enabled hook can review subsequent edits");
    content = acceptedContent;
    session.acceptFile(doc.uri, baseline);
    content = baseline.replace("b\r\n", "b\r\nINSERTED\r\n");
    session.markTouched(doc.uri.fsPath);
    const insertion = session.refreshFor(doc.uri, content)[0];
    groupedReview.update(doc);
    assert(reviewProvider.provideCodeLenses(doc).every(lens => lens.range.start.line === insertion.newStart - 1), "Insertion actions anchor to the first green row without an unchanged-row gap");
    await commands.get("aria.configureShortcuts")();
    assert(commandsSeen.some(item => item.name === "workbench.action.openGlobalKeybindings" && item.args[0] === "ARIA Review"), "Shortcut configuration opens native keybinding editor filtered to ARIA");
    // Simulate Explorer's cache surviving a saved file being closed.
    const closedBadgeProvider = badgeProviders.at(-1);
    let cachedBadge = closedBadgeProvider.provideFileDecoration(doc.uri);
    assert.equal(cachedBadge.badge, "M");
    const badgeSubscription = closedBadgeProvider.onDidChangeFileDecorations(uris => {
      if (uris === undefined || uris.some(uri => uri.toString() === doc.uri.toString()))
        cachedBadge = closedBadgeProvider.provideFileDecoration(doc.uri);
    });
    await doc.save();
    vscode.window.tabGroups.all[0].tabs = [];
    vscode.window.visibleTextEditors = [];
    groupedReview.releaseClosed();
    assert.equal(groupedReview.models.size, 0, "Closed editor models are released");
    const diskBeforeAccept = fs.readFileSync(doc.uri.fsPath, "utf8");
    const sourceBeforeAccept = content;
    session.acceptFile(doc.uri, content);
    await groupedReview.refreshAll();
    assert.equal(cachedBadge, undefined, "Accept clears cached Explorer badge even after its editor model was released");
    assert.equal(content, sourceBeforeAccept, "Clearing badges leaves document content untouched");
    assert.equal(fs.readFileSync(doc.uri.fsPath, "utf8"), diskBeforeAccept, "Clearing badges does not write files");
    const missingPath = path.join(root, "removed-review-temp.txt");
    fs.writeFileSync(missingPath, "temporary\n");
    const missingDoc = { uri: vscode.Uri.file(missingPath), getText: () => "temporary\n" };
    session.markTouched(missingPath); session.refreshFor(missingDoc.uri, missingDoc.getText());
    const missingModel = groupedReview.update(missingDoc);
    fs.unlinkSync(missingPath);
    vscode.window.tabGroups.all[0].tabs = [{ isActive: true, input: new vscode.TabInputTextDiff(missingModel.uri, missingDoc.uri) }];
    const opensBeforeMissing = commandsSeen.filter(item => item.name === "vscode.diff").length;
    await groupedReview.refreshAll();
    assert(!session.hunks.has(missingPath), "Deleted temporary review is pruned during editor refresh");
    assert(!groupedReview.models.has(missingModel.uri.toString()), "Deleted files release their review model");
    assert.equal(commandsSeen.filter(item => item.name === "vscode.diff").length, opensBeforeMissing, "Deleted files are never reopened");
    vscode.window.tabGroups.all[0].tabs = [];
    session.acceptFile(doc.uri, baseline);
    session.refreshFor(doc.uri, content);
    cachedBadge = closedBadgeProvider.provideFileDecoration(doc.uri);
    assert.equal(cachedBadge.badge, "M", "Undo-like pending review still has a badge");
    await groupedReview.refreshAll();
    assert.equal(cachedBadge.badge, "M", "Refreshing retains genuinely pending badges");
    session.acceptFile(doc.uri, content);
    groupedReview.clear();
    assert.equal(cachedBadge, undefined, "Clear invalidates decorations for closed files too");
    badgeSubscription.dispose();
    groupedReview.dispose();

    let allowDirectory = true;
    const scopedSession = new module.exports.ReviewSession(undefined, () => allowDirectory);
    scopedSession.active = true;
    scopedSession.mode = "all";
    scopedSession.acceptFile(doc.uri, baseline);
    assert.equal(scopedSession.refreshFor(doc.uri, baseline.replace("b", "B")).length, 1);
    allowDirectory = false;
    assert.equal(scopedSession.shouldReview(doc.uri.fsPath), false, "Track all cannot bypass directory Disable");
    assert.equal(scopedSession.refreshFor(doc.uri, "changed").length, 0);
    await scopedSession.syncDirectories();
    assert.equal(scopedSession.baselineOf(doc.uri.fsPath), "", "Disabled directories discard their active baseline");
    allowDirectory = true;
    await scopedSession.syncDirectories();
    const diskSnapshot = fs.readFileSync(doc.uri.fsPath, "utf8");
    assert.equal(scopedSession.baselineOf(doc.uri.fsPath), diskSnapshot, "Re-enabled directory starts from its current disk snapshot");
    scopedSession.refreshFor(doc.uri, diskSnapshot + "agent addition\r\n");
    await scopedSession.syncDirectories();
    assert.equal(scopedSession.baselineOf(doc.uri.fsPath), diskSnapshot, "Synchronizing directory policy retains pending baselines in enabled directories");

    const manualSession = new module.exports.ReviewSession();
    manualSession.active = true;
    manualSession.acceptFile(doc.uri, baseline);
    manualSession.observeManual(doc.uri, baseline.replace("b", "manual"));
    assert.equal(manualSession.pendingCount, 0, "Manual edits without an agent event never create review");
    assert.equal(manualSession.baselineOf(doc.uri.fsPath), baseline.replace("b", "manual"));
    manualSession.acceptFile(doc.uri, baseline);
    manualSession.markTouched(doc.uri.fsPath);
    manualSession.refreshFor(doc.uri, baseline.replace("b", "AI"));
    manualSession.observeManual(doc.uri, baseline.replace("b", "AI").replace("e", "manual"));
    assert.equal(manualSession.pendingCount, 1, "Manual edits outside an AI block do not create additional review");
    assert.equal(manualSession.baselineOf(doc.uri.fsPath), baseline.replace("e", "manual"));
    manualSession.observeManual(doc.uri, baseline.replace("b", "corrected AI").replace("e", "manual"));
    assert.equal(manualSession.pendingCount, 1, "Direct editing of an AI proposal preserves its pending decision");
    manualSession.acceptFile(doc.uri, baseline);
    manualSession.observeManual(doc.uri, baseline.replace("f", "manual again"));
    assert.equal(manualSession.shouldReview(doc.uri.fsPath), false, "Previously reviewed files do not permanently classify manual edits as AI");

    const userHome = path.join(temp, "User With Spaces");
    const adapterStore = { ...store, adapterInstallDir: () => path.join(userHome, ".aria", "adapters"), backupDir: () => path.join(userHome, ".aria", "backup") };
    const adapterModule = { exports: {} };
    const adapterVscode = {
      Uri: { joinPath: (_base, ...parts) => path.resolve(...parts) },
      workspace: { fs: { readFile: async (file) => fs.readFileSync(file) } },
    };
    vm.runInNewContext(fs.readFileSync("out/adapters.js", "utf8"), {
      exports: adapterModule.exports, module: adapterModule,
      require: (name) => name === "vscode" ? adapterVscode : name === "node:os" ? { homedir: () => userHome } : name === "./store" ? adapterStore : require(name),
      Buffer, process: { ...process, env: { ...process.env, OPENCODE_CONFIG_DIR: path.join(userHome, ".config", "opencode") } }, console,
    });
    const config = path.join(userHome, ".codex", "config.toml");
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(config, 'model = "example"\n');
    const selectedInstall = await adapterModule.exports.setupAdapters({ extensionUri: {} }, ["cursor"]);
    assert.deepEqual(Array.from(selectedInstall, result => result.agent), ["cursor"]);
    assert.equal(fs.readFileSync(config, "utf8"), 'model = "example"\n', "Targeted setup preserves other agent configs");
    assert.equal(fs.existsSync(path.join(userHome, ".gemini", "settings.json")), false);
    assert.equal(fs.existsSync(path.join(userHome, ".config", "opencode", "plugins", "agent-review-watch.ts")), false);
    assert.equal((await adapterModule.exports.setupAdapters({ extensionUri: {} }, [])).length, 0);
    await assert.rejects(adapterModule.exports.setupAdapters({ extensionUri: {} }, ["unknown-agent"]), /Unknown agent/);
    const results = await adapterModule.exports.setupAdapters({ extensionUri: {} });
    assert(results.every((result) => result.ok), JSON.stringify(results));
    const geminiSettings = path.join(userHome, ".gemini", "settings.json");
    const geminiHook = JSON.parse(fs.readFileSync(geminiSettings, "utf8")).hooks.AfterTool[0];
    assert.equal(geminiHook.hooks[0].timeout, 5000);
    assert(geminiHook.hooks[0].command.endsWith("--gemini"));
    assert.equal(adapterModule.exports.adaptersStatus().find(item => item.agent === "gemini").installed, true);
    const copilotHooksPath = path.join(userHome, ".copilot", "hooks", "agent-inline-review.json");
    const copilotConfig = JSON.parse(fs.readFileSync(copilotHooksPath, "utf8"));
    copilotConfig.userPreference = "keep";
    copilotConfig.hooks.postToolUse.push({ type: "command", powershell: "user-hook" });
    fs.writeFileSync(copilotHooksPath, JSON.stringify(copilotConfig));
    const preservedGemini = JSON.parse(fs.readFileSync(geminiSettings, "utf8"));
    preservedGemini.theme = "user-theme";
    preservedGemini.hooks.AfterTool[0].hooks.push({ type: "command", command: "mixed-user-hook" });
    preservedGemini.hooks.AfterTool.push({ matcher: "read_file", hooks: [{ type: "command", command: "user-hook" }] });
    fs.writeFileSync(geminiSettings, JSON.stringify(preservedGemini));
    assert(fs.existsSync(path.join(userHome, ".config", "opencode", "plugins", "agent-review-watch.ts")));
    const installed = fs.readFileSync(config, "utf8");
    assert(installed.includes('[[hooks.PostToolUse.hooks]]'));
    assert(installed.includes('timeout = 5'));
    assert(!installed.includes('timeout_seconds'));
    assert(adapterModule.exports.adaptersStatus().find((status) => status.agent === "codex").installed);
    await adapterModule.exports.setupAdapters({ extensionUri: {} });
    assert.strictEqual(fs.readFileSync(config, "utf8"), installed);
    const unrelated = '\n[unrelated]\nvalue = "keep"\n';
    fs.appendFileSync(config, unrelated);
    await adapterModule.exports.removeAdapters();
    const removedCopilot = JSON.parse(fs.readFileSync(copilotHooksPath, "utf8"));
    assert.equal(removedCopilot.userPreference, "keep");
    assert.equal(removedCopilot.hooks.postToolUse[0].powershell, "user-hook");
    assert.equal(adapterModule.exports.adaptersStatus().find(item => item.agent === "copilot").installed, false, "Other hooks in the file do not count as an installed ARIA adapter");
    const removedGemini = JSON.parse(fs.readFileSync(geminiSettings, "utf8"));
    assert.equal(removedGemini.theme, "user-theme");
    assert.equal(removedGemini.hooks.AfterTool.length, 2, "Setup and removal preserve separate and mixed unrelated Gemini hooks");
    assert(removedGemini.hooks.AfterTool.flatMap(entry => entry.hooks).some(hook => hook.command === "user-hook"));
    assert(removedGemini.hooks.AfterTool.flatMap(entry => entry.hooks).some(hook => hook.command === "mixed-user-hook"));
    assert.strictEqual(fs.readFileSync(config, "utf8"), 'model = "example"\n\n' + unrelated);
    const invalidGemini = '{"hooks":{"AfterTool":"invalid-user-value"},"theme":"preserve"}';
    fs.writeFileSync(geminiSettings, invalidGemini);
    const invalidInstall = await adapterModule.exports.setupAdapters({ extensionUri: {} });
    assert.equal(invalidInstall.find(result => result.agent === "gemini").ok, false);
    assert.equal(fs.readFileSync(geminiSettings, "utf8"), invalidGemini, "Malformed user hook configuration must not be rewritten");
    console.log("ADAPTER, HASH, SESSION TESTS PASSED");
  } finally {
    assert(path.dirname(temp) === path.resolve(require("node:os").tmpdir()));
    assert(path.basename(temp).startsWith("aria-test-"));
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

testAdaptersAndSession().then(() => console.log("ALL TESTS PASSED")).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
