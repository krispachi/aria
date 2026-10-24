const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const manifest = require("./package.json");
const { DirectoryRegistry } = require("./out/directories");

(async () => {
  const user = new Map(), workspace = new Map(), state = new Map(), files = new Map();
  const picks = [], updates = [], errors = [];
  const settingsUri = { scheme: "file", fsPath: "aria-settings.json" };
  const definitions = Object.assign({}, ...manifest.contributes.configuration.map(section => section.properties));
  assert(manifest.contributes.configuration.every(section => section.title.startsWith("ARIA: ") && Object.keys(section.properties).length), "Settings are grouped into titled ARIA categories");
  let confirm = "Import", failKey, dialogCancelled = false;
  const storage = { get: (key, fallback) => state.get(key) ?? fallback, update: async (key, value) => { if (value === undefined) state.delete(key); else state.set(key, JSON.parse(JSON.stringify(value))); } };
  const registry = new DirectoryRegistry(storage);
  const context = { extension: { packageJSON: manifest }, globalState: storage };
  const vscode = {
    __esModule: true, ConfigurationTarget: { Global: 1, Workspace: 2 },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: process.cwd() } }],
      getConfiguration: namespace => ({
        get: (key, fallback) => workspace.get(namespace + "." + key) ?? user.get(namespace + "." + key) ?? definitions[namespace + "." + key]?.default ?? fallback,
        inspect: key => ({ globalValue: user.get(namespace + "." + key), workspaceValue: workspace.get(namespace + "." + key) }),
        update: async (key, value, target) => {
          if (key === failKey) { failKey = undefined; throw new Error("Simulated settings write failure"); }
          const map = target === 1 ? user : workspace;
          updates.push({ key, value, target });
          if (value === undefined) map.delete(namespace + "." + key); else map.set(namespace + "." + key, value);
        },
      }),
      fs: {
        stat: async () => ({ size: files.get(settingsUri.fsPath).length }),
        readFile: async () => files.get(settingsUri.fsPath),
        writeFile: async (uri, value) => files.set(uri.fsPath, Buffer.from(value)),
      },
    },
    window: {
      showQuickPick: async items => { const choice = picks.shift(); return choice === undefined ? undefined : items[choice]; },
      showSaveDialog: async () => dialogCancelled ? undefined : settingsUri,
      showOpenDialog: async () => dialogCancelled ? undefined : [settingsUri],
      showWarningMessage: async () => confirm,
      showInformationMessage: async () => {},
      showErrorMessage: async text => errors.push(text),
    },
  };
  const configModule = { exports: {} };
  vm.runInNewContext(fs.readFileSync("out/config.js", "utf8"), {
    exports: configModule.exports, module: configModule, Buffer,
    require: name => name === "vscode" ? vscode : require(name),
  });
  const { exportSettings, importSettings, validateSettingsBundle } = configModule.exports;
  const bundle = settings => ({ format: "aria-settings", version: 1, settings });
  for (const invalid of [bundle({ "editor.fontSize": 99 }), bundle({ "aria.autoOpen": "yes" }), bundle({ "aria.enabled": "off" }), bundle({ "aria.agents.gemini.enabled": 0 }), bundle({ "aria.undoLimit": 101 }), bundle({ "aria.notifications": "random" }), bundle({ "aria.maxSnapshotSizeMb": -1 }), bundle({ "aria.excludePatterns": [5] }), { ...bundle({}), version: 2 }, { ...bundle({}), directories: { relative: { enabled: true } } }]) {
    assert.throws(() => validateSettingsBundle(invalid, definitions));
  }
  user.set("aria.autoOpen", false);
  user.set("aria.enabled", false);
  user.set("aria.agents.gemini.enabled", false);
  user.set("aria.adapterSetup", "auto");
  user.set("editor.fontSize", 20);
  await registry.set(process.cwd(), false);
  picks.push(0);
  assert(await exportSettings(context, registry));
  let exported = JSON.parse(files.get(settingsUri.fsPath).toString());
  assert.equal(exported.settings["aria.autoOpen"], false);
  assert.equal(exported.settings["aria.enabled"], false);
  assert.equal(exported.settings["aria.agents.gemini.enabled"], false);
  assert.equal(exported.settings["aria.adapterSetup"], "auto");
  assert.equal(configModule.exports.agentEnabled("gemini"), false);
  assert.equal(configModule.exports.agentEnabled("cursor"), true);
  assert.equal(configModule.exports.agentEnabled(undefined), false, "Ambiguous legacy events cannot bypass a disabled agent");
  assert.equal(exported.directories, undefined, "Portable export omits directory paths");
  assert(Object.keys(exported.settings).every(key => key.startsWith("aria.")));
  assert.equal(exported.settings["editor.fontSize"], undefined);
  picks.push(1);
  assert(await exportSettings(context, registry));
  exported = JSON.parse(files.get(settingsUri.fsPath).toString());
  assert.equal(Object.values(exported.directories)[0].enabled, false);
  user.set("aria.autoOpen", true); user.set("aria.enabled", true); user.set("aria.agents.gemini.enabled", true); await registry.set(process.cwd(), true);
  picks.push(0);
  assert(await importSettings(context, registry));
  assert.equal(user.get("aria.autoOpen"), false);
  assert.equal(user.get("aria.enabled"), false);
  assert.equal(user.get("aria.agents.gemini.enabled"), false);
  assert.equal(user.get("editor.fontSize"), 20);
  assert.equal(registry.isEnabled(process.cwd(), "all"), false, "Directory choices survive export/reinstall/import");
  const before = JSON.stringify([...user]);
  confirm = undefined; picks.push(0);
  assert.equal(await importSettings(context, registry), false);
  assert.equal(JSON.stringify([...user]), before, "Cancelled import writes nothing");
  confirm = "Import";
  files.set(settingsUri.fsPath, Buffer.from(JSON.stringify(bundle({ "aria.autoOpen": true, "aria.undoLimit": 15 }))));
  picks.push(0); failKey = "undoLimit";
  assert.equal(await importSettings(context, registry), false);
  assert.equal(JSON.stringify([...user]), before, "Failed import restores prior settings");
  files.set(settingsUri.fsPath, Buffer.from(JSON.stringify(bundle({ "aria.notifications": "minimal", "aria.autoOpen": true, "aria.enabled": true, "aria.agents.gemini.enabled": true }))));
  picks.push(1);
  assert(await importSettings(context, registry));
  assert.equal(user.get("aria.notifications"), "minimal", "Application settings always import at User scope");
  assert.equal(workspace.get("aria.autoOpen"), true);
  assert.equal(workspace.has("aria.notifications"), false);
  assert.equal(user.get("aria.enabled"), true);
  assert.equal(user.get("aria.agents.gemini.enabled"), true);
  assert.equal(workspace.has("aria.enabled"), false);
  assert.equal(workspace.has("aria.agents.gemini.enabled"), false);
  assert.equal(configModule.exports.agentEnabled(undefined), true, "Legacy events remain compatible when all agents are enabled");
  files.set(settingsUri.fsPath, Buffer.alloc(256 * 1024 + 1));
  const count = updates.length;
  assert.equal(await importSettings(context, registry), false);
  assert.equal(updates.length, count, "Oversized files cannot update configuration");
  assert(errors.some(error => error.includes("256 KB")));
  assert.equal(manifest.publisher, "krispachi"); assert.equal(manifest.author.name, "Krispachi");
  assert.equal(definitions["aria.showNavigationToolbar"].default, undefined, "Removed navigation toolbar is not exported");
  for (const key of ["aria.fileActionsLocation", "aria.allActionsLocation"]) assert.equal(definitions[key].default, "statusBar", "Decision buttons default to the status bar");
  const colors = manifest.contributes.configurationDefaults["workbench.colorCustomizations"];
  for (const kind of ["inserted", "removed"]) {
    const lineAlpha = parseInt(colors[`diffEditor.${kind}LineBackground`].slice(-2), 16) / 255;
    const textAlpha = parseInt(colors[`diffEditor.${kind}TextBackground`].slice(-2), 16) / 255;
    assert(lineAlpha <= .14 && textAlpha > lineAlpha && textAlpha <= .18, "Line colors remain subtle at 13%; native character highlights stay brighter and translucent");
  }
  assert(!manifest.contributes.keybindings?.length, "ARIA reserves no default shortcuts");
  assert(!manifest.contributes.menus["editor/title"].some(item => ["aria.acceptCurrentChange", "aria.rejectCurrentChange"].includes(item.command)));
  assert(!manifest.contributes.menus["editor/title"].some(item => item.command === "aria.nextChange"), "ARIA Previous/Next are not duplicated in the editor toolbar");
  const { computeHunks } = require("./out/diff.js");
  const crlf = computeHunks("a\r\nb\r\n", "a\r\nB\r\n");
  assert.equal(crlf.length, 1, "CRLF content diffs with the editor algorithm");
  assert.deepEqual(Array.from(crlf[0].oldLines), ["b"]);
  assert.deepEqual(Array.from(crlf[0].newLines), ["B"]);
  console.log("SETTINGS TRANSFER, VALIDATION, ROLLBACK AND TOOLBAR TESTS PASSED");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aria-cleanup-"));
  try {
    const home = path.join(root, "home"), store = path.join(home, ".aria");
    const write = (relative, text) => { const file = path.join(home, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; };
    const ownCommand = 'node "' + path.join(store, "adapters", "record-event.mjs") + '"';
    const hook = { type: "command", command: ownCommand }, other = { type: "command", command: "user-hook" };
    const runtime = write(".aria/adapters/record-event.mjs", "runtime");
    const event = write(".aria/projects/" + "a".repeat(24) + ".jsonl", "{}\n");
    const unrelated = write(".aria/projects/user-notes.txt", "keep");
    const backup = write(".aria/backup/settings.json.12345.bak", "backup");
    const plugin = write(".config/opencode/plugins/agent-review-watch.ts", "export const OpenCodeReviewWatch = {}; // projects jsonl");
    const foreignPlugin = write(".config/opencode/plugins/opencode-review-watch.ts", "unrelated user plugin");
    const claude = write(".claude/settings.json", JSON.stringify({ theme: "keep", hooks: { PostToolUse: [{ hooks: [hook, other] }] } }));
    const cursor = write(".cursor/hooks.json", JSON.stringify({ hooks: { postToolUse: [{ command: ownCommand }, other] } }));
    const gemini = write(".gemini/settings.json", "{broken");
    const copilot = write(".copilot/hooks/agent-inline-review.json", JSON.stringify({ version: 1, hooks: { postToolUse: [{ bash: ownCommand }, { bash: "user-hook" }] } }));
    const codex = write(".codex/config.toml", 'model = "keep"\n# aria inline review begin\nowned-hook\n# aria inline review end\n');
    const cleanupModule = { exports: {} };
    vm.runInNewContext(fs.readFileSync("out/uninstall.js", "utf8"), {
      exports: cleanupModule.exports, module: cleanupModule,
      process: { env: { OIR_STORE_DIR: store } }, console,
      require: name => name === "node:os" ? { homedir: () => home } : require(name),
    });
    assert(fs.existsSync(runtime), "Importing cleanup helpers never performs cleanup");
    const failures = cleanupModule.exports.cleanupRuntime();
    assert(failures.some(error => error.includes("Malformed config preserved")));
    assert.equal(fs.existsSync(runtime), false); assert.equal(fs.existsSync(event), false); assert.equal(fs.existsSync(plugin), false);
    assert(fs.existsSync(unrelated)); assert(fs.existsSync(foreignPlugin)); assert(fs.existsSync(backup), "Normal uninstall keeps recovery backups");
    assert.equal(JSON.parse(fs.readFileSync(claude)).hooks.PostToolUse[0].hooks[0].command, "user-hook");
    assert.equal(JSON.parse(fs.readFileSync(cursor)).hooks.postToolUse[0].command, "user-hook", "Cursor postToolUse is cleaned even without afterFileEdit");
    assert.equal(fs.readFileSync(gemini, "utf8"), "{broken");
    assert.equal(JSON.parse(fs.readFileSync(copilot)).hooks.postToolUse[0].bash, "user-hook");
    assert.equal(fs.readFileSync(codex, "utf8"), 'model = "keep"\n');
    cleanupModule.exports.cleanupRuntime(true);
    assert.equal(fs.existsSync(backup), false, "Explicit Clean removes adapter backups");
    assert(fs.existsSync(unrelated));
    cleanupModule.exports.cleanupRuntime(true);
    console.log("UNINSTALL OWNERSHIP, MIXED HOOKS, BACKUPS AND IDEMPOTENCY TESTS PASSED");
  } finally {
    const resolved = path.resolve(root);
    assert(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep + "aria-cleanup-"));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
