#!/usr/bin/env node
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CodeAction, CodeActionKind, createConnection, Diagnostic, DiagnosticSeverity, InlayHint, MessageType,
  ProposedFeatures, SemanticTokensBuilder, TextDocuments, TextDocumentSyncKind, TextEdit,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { adaptersStatus, removeAdapters, setupAdapters } from "./adapters";
import { Hunk } from "./diff";
import { ReviewCache } from "./persistence";
import { DEFAULTS, EventLog, ReviewFileState, Session, Settings, SUPPORTED_AGENTS } from "./session";
import { globalStoreBase, projectHash, resolveEventsFile } from "./store";
import { cleanupRuntime } from "./uninstall";

if (process.argv.includes("--uninstall")) {
  for (const failure of cleanupRuntime()) console.error("ARIA cleanup: " + failure);
  process.exit(0);
}
if (process.argv.includes("--remove-adapters")) {
  void removeAdapters().then(results => { for (const r of results) console.log(`${r.ok ? "ok" : "FAILED"} ${r.agent}: ${r.message}`); });
} else serve();

function serve(): void {
const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
const log = (message: string) => connection.console.log(message);
const notify = (type: MessageType, message: string) => void connection.sendNotification("window/showMessage", { type, message });

const COMMANDS = {
  accept: "aria.accept", reject: "aria.reject", acceptAll: "aria.acceptAll", rejectAll: "aria.rejectAll",
  undo: "aria.undo", installAdapters: "aria.installAdapters", adapterStatus: "aria.adapterStatus",
};

let initOptions: Partial<Settings> = {};
let settings: Settings = DEFAULTS;
let root = "";
let session: Session | undefined;
let events: EventLog | undefined;
let cache: ReviewCache | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
let watcher: import("node:fs").FSWatcher | undefined;
const published = new Set<string>();
const signatures = new Map<string, string>();
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
// Content ARIA itself is about to put in a buffer: the matching didChange is not a manual edit.
const expected = new Map<string, string>();
let queue: Promise<unknown> = Promise.resolve();
// Decisions, event ingestion and manual edits run one at a time.
const serial = <T>(operation: () => Promise<T>): Promise<T> => {
  const result = queue.then(operation);
  queue = result.catch(error => log(`ARIA: ${String(error)}`));
  return result;
};

function merge(...layers: Array<Partial<Settings> | undefined>): Settings {
  const out: Settings = { ...DEFAULTS, agents: { ...DEFAULTS.agents } };
  for (const layer of layers) {
    if (!layer || typeof layer !== "object") continue;
    for (const [key, value] of Object.entries(layer)) {
      if (key === "agents" && value && typeof value === "object") Object.assign(out.agents, value);
      else if (key in DEFAULTS && typeof value === typeof (DEFAULTS as any)[key] && Array.isArray(value) === Array.isArray((DEFAULTS as any)[key])) (out as any)[key] = value;
    }
  }
  return out;
}

const uriOf = (file: string) => pathToFileURL(file).href;
const fileOf = (uri: string) => path.normalize(fileURLToPath(uri));

async function readDisk(file: string): Promise<string | null> {
  try {
    if ((await fs.stat(file)).size > settings.maxFileSizeKb * 1024) return null;
    return await fs.readFile(file, "utf8");
  } catch { return null; }
}

async function current(file: string): Promise<string> {
  const uri = uriOf(file);
  return expected.get(uri) ?? documents.get(uri)?.getText() ?? await readDisk(file) ?? "";
}

function diagnostic(file: string, hunk: Hunk, text: string): Diagnostic {
  const lineCount = text ? text.split("\n").length : 1;
  const first = Math.min(hunk.newStart - 1, Math.max(0, lineCount - 1));
  const last = hunk.newLines.length ? first + hunk.newLines.length - 1 : first;
  const lastText = hunk.newLines.at(-1) ?? text.split("\n")[first] ?? "";
  const agent = session!.agentOf.get(session!.key(file));
  const clip = (prefix: string, lines: string[]) => [...lines.slice(0, 20).map(line => prefix + line), ...(lines.length > 20 ? [`${prefix}… ${lines.length - 20} more`] : [])];
  const summary = hunk.removedOnly ? `${hunk.oldLines.length} line(s) removed above this line` : `+${hunk.newLines.length} −${hunk.oldLines.length}`;
  return {
    range: { start: { line: first, character: 0 }, end: { line: last, character: lastText.replace(/\r$/, "").length } },
    severity: DiagnosticSeverity.Warning,
    source: "ARIA",
    code: hunk.id,
    message: [`Pending ${agent ? agent + " " : "agent "}change (${summary}). Code actions: Accept / Reject.`, ...clip("- ", hunk.oldLines), ...clip("+ ", hunk.newLines)].join("\n"),
    data: { id: hunk.id },
  };
}

async function publish(file: string): Promise<void> {
  if (!session) return;
  const uri = uriOf(file);
  const hunks = session.hunks.get(path.normalize(file)) ?? [];
  if (!hunks.length && !published.has(uri)) return;
  const text = await current(file);
  void connection.sendDiagnostics({ uri, diagnostics: hunks.map(hunk => diagnostic(file, hunk, text)) });
  // Refresh only on real changes and coalesced: a refresh racing Zed's own first
  // request makes it show the same hints twice.
  const signature = JSON.stringify(hunks);
  if (signatures.get(uri) !== signature) {
    signatures.set(uri, signature);
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      if (refreshTokens) void connection.languages.semanticTokens.refresh();
      if (refreshHints) void connection.languages.inlayHint.refresh();
    }, 250);
  }
  if (hunks.length) published.add(uri); else published.delete(uri);
  await syncBaseline(file);
  cache?.schedule();
}

// Red/green review: the extension API cannot color lines, but Zed's own diff
// view can. The left side is a baseline copy that follows every decision.
const baselineFile = (file: string) => path.join(globalStoreBase(), "sessions", projectHash(root), "baseline", path.relative(root, file));
const diffed = new Set<string>();

async function syncBaseline(file: string): Promise<void> {
  if (!diffed.has(file) || !session) return;
  const target = baselineFile(file), text = session.baselineOf(file);
  if (await fs.readFile(target, "utf8").catch(() => null) !== text) await fs.writeFile(target, text, "utf8");
}

async function openDiff(file: string): Promise<void> {
  if (!settings.openDiff || !session || !session.hunks.get(path.normalize(file))?.length) return;
  const target = baselineFile(file);
  await fs.mkdir(path.dirname(target), { recursive: true });
  diffed.add(file);
  await syncBaseline(file);
  // --existing overrides `cli_default_open_behavior: new_window`.
  // ponytail: Zed opens the diff in the last focused window; the CLI has no way to target a workspace.
  const candidates = [process.env.ZED_CLI, "zed", process.platform === "darwin" ? "/Applications/Zed.app/Contents/MacOS/cli" : "zeditor"].filter(Boolean) as string[];
  const run = (i: number): void => {
    if (i >= candidates.length) return log("ARIA: Zed CLI not found; set ZED_CLI or install the `zed` command to open diffs.");
    const child = spawn(candidates[i], ["--existing", "--diff", target, file], { stdio: "ignore", detached: true });
    child.on("error", () => run(i + 1));
    child.unref();
  };
  run(0);
}

async function clearDiagnostics(): Promise<void> {
  for (const uri of published) void connection.sendDiagnostics({ uri, diagnostics: [] });
  published.clear();
}

/** Open buffers with unsaved edits get an editor edit (undoable, saved by the
 * user); everything else is written to disk, which Zed reloads. */
async function write(file: string, text: string): Promise<void> {
  const uri = uriOf(file);
  const doc = documents.get(uri);
  if (doc && doc.getText() !== await readDisk(file)) {
    expected.delete(uri);
    const before = doc.getText();
    let start = 0, end = 0;
    while (start < before.length && start < text.length && before[start] === text[start]) start++;
    while (end < before.length - start && end < text.length - start && before[before.length - 1 - end] === text[text.length - 1 - end]) end++;
    const edit = TextEdit.replace({ start: doc.positionAt(start), end: doc.positionAt(before.length - end) }, text.slice(start, text.length - end));
    expected.set(uri, text);
    const result = await connection.workspace.applyEdit({ label: "ARIA", edit: { documentChanges: [{ textDocument: { uri, version: doc.version }, edits: [edit] }] } });
    if (!result.applied) { expected.delete(uri); throw new Error(`Zed refused the edit for ${path.relative(root, file)}${result.failureReason ? ": " + result.failureReason : ""}`); }
  } else {
    if (doc) expected.set(uri, text);
    await fs.writeFile(file, text, "utf8");
  }
}

/** Runs a decision and records it for Undo. */
async function decide(files: string[], operation: () => Promise<void>): Promise<void> {
  const s = session!;
  const capture = async (): Promise<ReviewFileState[]> => Promise.all([...new Set(files)].map(async file => ({ file, baseline: s.baselineOf(file), content: await current(file) })));
  const before = await capture();
  try { await operation(); } finally {
    const after = await capture();
    s.record(before, after, await Promise.all(after.map(async item => ({ file: item.file, content: await readDisk(item.file) }))));
    for (const file of files) await publish(file);
  }
}

async function accept(file: string, id?: string): Promise<void> {
  const s = session!;
  const text = await current(file);
  s.refresh(file, text);
  if (id === undefined) s.acceptFile(file, text);
  else { const hunk = s.hunk(file, id); if (!hunk) throw new Error("This change was already decided or has moved. Re-run the code action."); s.acceptHunk(file, hunk); }
}

async function reject(file: string, id?: string): Promise<void> {
  const s = session!;
  s.refresh(file, await current(file));
  let text: string;
  if (id === undefined) text = s.baselineOf(file);
  else { const hunk = s.hunk(file, id); if (!hunk) throw new Error("This change was already decided or has moved. Re-run the code action."); text = s.rejectedContent(file, hunk); }
  await write(file, text);
  s.refresh(file, text);
}

async function undo(): Promise<void> {
  const s = session!;
  const entry = s.history.at(-1);
  if (!entry) return notify(MessageType.Info, "ARIA: nothing to undo.");
  for (const item of entry.after) {
    if (await current(item.file) !== item.content || s.baselineOf(item.file) !== item.baseline) return notify(MessageType.Warning, "ARIA cannot undo this decision because the file changed afterward. Your later edits were preserved.");
  }
  for (const item of entry.before) {
    if (await current(item.file) !== item.content) await write(item.file, item.content);
    s.setBaseline(item.file, item.baseline);
    s.touched.add(s.key(item.file));
    s.refresh(item.file, item.content);
    await publish(item.file);
  }
  s.history.pop();
}

async function ingest(): Promise<void> {
  const s = session;
  if (!s || !events) return;
  const changed = new Set<string>(), ignored = new Set<string>();
  for (const ev of await events.read()) {
    if (!s.allowedFile(ev.file)) continue;
    if (!s.allowedAgent(ev.agent)) { ignored.add(ev.file); continue; }
    changed.add(ev.file); ignored.delete(ev.file);
    s.touched.add(s.key(ev.file));
    if (ev.agent) s.agentOf.set(s.key(ev.file), ev.agent);
  }
  for (const file of ignored) { const disk = await readDisk(file); if (disk !== null && !changed.has(file)) s.absorb(file, disk); }
  for (const file of changed) {
    // The agent wrote to disk; Zed may not have reloaded the buffer yet.
    const disk = await readDisk(file);
    if (disk === null) continue;
    const wasPending = !!s.hunks.get(path.normalize(file))?.length;
    s.refresh(file, disk);
    await publish(file);
    if (!wasPending || !diffed.has(file)) await openDiff(file);
  }
}

async function installAdapters(explicit: boolean): Promise<void> {
  const wanted = SUPPORTED_AGENTS.filter(agent => settings.agents[agent] !== false);
  const missing = adaptersStatus().filter(a => wanted.includes(a.agent as typeof wanted[number]) && !a.installed).map(a => a.agent);
  if (!explicit && (settings.adapterSetup === "off" || !missing.length)) return;
  if (!explicit && settings.adapterSetup === "ask") {
    const pick = await connection.window.showInformationMessage(`ARIA: install user-level hooks for ${missing.join(", ")}? They report which files a CLI agent edits.`, { title: "Install" }, { title: "Not now" });
    if (pick?.title !== "Install") return;
  }
  const results = await setupAdapters(explicit ? wanted : missing);
  for (const r of results) log(`ARIA adapter ${r.agent}: ${r.ok ? "ok" : "FAILED"} ${r.message}`);
  const failed = results.filter(r => !r.ok);
  notify(failed.length ? MessageType.Warning : MessageType.Info, failed.length
    ? `ARIA: hook setup failed for ${failed.map(r => `${r.agent} (${r.message})`).join("; ")}`
    : `ARIA: hooks installed for ${results.map(r => r.agent).join(", ")}. Restart your CLI agent (Codex: approve with /hooks).`);
}

async function start(): Promise<void> {
  await stop();
  // Baseline copies opened in a diff view must not start a review of their own.
  const insideStore = path.relative(globalStoreBase(), root);
  if (!settings.enabled || !root || insideStore === "" || (!insideStore.startsWith("..") && !path.isAbsolute(insideStore))) return;
  const s = new Session(root, settings, log);
  const since = Date.now();
  const eventsFile = resolveEventsFile(root, settings.eventsFile);
  events = new EventLog(eventsFile, !settings.eventsFile.trim(), since);
  // Offsets first: an agent edit made during the (slow) snapshot is still reviewed.
  events.captureOffsets();
  await s.snapshot();
  session = s;
  cache = new ReviewCache(path.join(globalStoreBase(), "sessions", projectHash(root)), () => s.exportReview(), () => settings.persistReview, () => settings.retentionDays, log);
  const saved = await cache.load();
  if (saved) {
    let conflicts = 0;
    for (const item of saved.files) {
      if (!s.reviewable(item.file)) continue;
      if (await current(item.file) !== item.content) { conflicts++; continue; }
      s.setBaseline(item.file, item.baseline);
      s.touched.add(s.key(item.file));
      s.refresh(item.file, item.content);
      await publish(item.file);
    }
    s.history = settings.undoLimit > 0 ? saved.undo.filter(entry => entry.before.every(item => s.allowedFile(item.file))).slice(-settings.undoLimit) : [];
    if (conflicts) notify(MessageType.Warning, `ARIA: ${conflicts} saved review file(s) changed since the last session and were not restored.`);
  }
  try {
    await fs.mkdir(path.dirname(eventsFile), { recursive: true });
    watcher = require("node:fs").watch(path.dirname(eventsFile), (_: unknown, name: unknown) => { if (String(name ?? "").endsWith(".jsonl")) void serial(ingest); });
    watcher?.on("error", () => {});
  } catch {}
  // fs.watch is unreliable on some filesystems.
  timer = setInterval(() => void serial(ingest), 3000);
  log(`ARIA review started for ${root}; events: ${eventsFile}`);
}

async function stop(): Promise<void> {
  watcher?.close(); watcher = undefined;
  if (timer) clearInterval(timer); timer = undefined;
  await cache?.save(); cache = undefined;
  session = undefined; events = undefined;
  await clearDiagnostics();
}

// Green/red in the normal editor: changed lines are semantic tokens that the
// user's `semantic_token_rules` paint with a background color.
const TOKEN_TYPES = ["aria-added", "aria-removed"];
let refreshTokens = false;
connection.languages.semanticTokens.on(params => {
  const builder = new SemanticTokensBuilder();
  const doc = documents.get(params.textDocument.uri);
  const hunks = session && doc ? session.hunks.get(fileOf(doc.uri)) ?? [] : [];
  const lines = doc?.getText().split("\n") ?? [];
  const mark = (line: number, type: number, max = Infinity) => { const length = Math.min(max, (lines[line] ?? "").replace(/\r$/, "").length); if (length) builder.push(line, 0, length, type, 0); };
  for (const hunk of hunks) {
    // Removed lines no longer exist in the buffer: a one-character red notch
    // marks where they were, without painting the surviving line as removed.
    if (hunk.removedOnly) mark(Math.min(hunk.newStart - 1, lines.length - 1), 1, 1);
    else for (let i = 0; i < hunk.newLines.length; i++) mark(hunk.newStart - 1 + i, 0);
  }
  return builder.build();
});

// Removed lines cannot be drawn as rows: their text is shown as an inlay hint
// where they were (needs Zed's `inlay_hints.enabled`).
let refreshHints = false;
connection.languages.inlayHint.on(params => {
  const doc = documents.get(params.textDocument.uri);
  const hunks = session && doc ? session.hunks.get(fileOf(doc.uri)) ?? [] : [];
  const lines = doc?.getText().split("\n") ?? [];
  const hints: InlayHint[] = [];
  for (const hunk of hunks) {
    if (!hunk.oldLines.length) continue;
    const first = hunk.oldLines.find(line => line.trim()) ?? hunk.oldLines[0];
    const more = hunk.oldLines.length > 1 ? ` (+${hunk.oldLines.length - 1} more)` : "";
    // Inlay text has one color; the tooltip's fenced block gets syntax highlighting.
    const tooltip = { kind: "markdown" as const, value: "Removed by the agent:\n```" + path.extname(doc!.uri).slice(1) + "\n" + hunk.oldLines.join("\n") + "\n```" };
    const line = Math.min(hunk.newStart - 1, Math.max(0, lines.length - 1));
    // Pure deletions: before the line that followed them. Replacements: after the new first line.
    const hint: InlayHint = hunk.removedOnly
      ? { position: { line, character: 0 }, label: `− ${first.trim()}${more}`, paddingRight: true, tooltip }
      : { position: { line, character: (lines[line] ?? "").replace(/\r$/, "").length }, label: `was: ${first.trim()}${more}`, paddingLeft: true, tooltip };
    // The range end is exclusive: Zed asks in adjacent chunks, a boundary hint must land in one.
    const { start, end } = params.range, at = hint.position;
    const before = (a: typeof at, b: typeof at) => a.line < b.line || (a.line === b.line && a.character < b.character);
    const lastLine = lines.length - 1, docEnd = end.line > lastLine || (end.line === lastLine && end.character >= (lines[lastLine] ?? "").length);
    if (before(at, start) || (!before(at, end) && !docEnd)) continue;
    hints.push(hint);
  }
  return hints;
});

connection.onInitialize(params => {
  refreshTokens = !!params.capabilities.workspace?.semanticTokens?.refreshSupport;
  refreshHints = !!params.capabilities.workspace?.inlayHint?.refreshSupport;
  const folder = params.workspaceFolders?.[0]?.uri ?? params.rootUri;
  root = folder ? fileOf(folder) : params.rootPath ?? "";
  initOptions = params.initializationOptions ?? {};
  settings = merge(initOptions);
  return {
    capabilities: {
      textDocumentSync: { openClose: true, change: TextDocumentSyncKind.Incremental, save: false },
      codeActionProvider: { codeActionKinds: [CodeActionKind.QuickFix] },
      inlayHintProvider: true,
      semanticTokensProvider: { legend: { tokenTypes: TOKEN_TYPES, tokenModifiers: [] }, full: true },
      executeCommandProvider: { commands: Object.values(COMMANDS) },
    },
    serverInfo: { name: "aria", version: require("../package.json").version },
  };
});

connection.onInitialized(() => void serial(async () => {
  // Zed sends `lsp.aria.settings` after `initialized`: pull them before installing hooks.
  try {
    const [pulled] = await connection.sendRequest<unknown[]>("workspace/configuration", { items: [{}] });
    settings = merge(initOptions, (pulled as any)?.aria ?? pulled);
  } catch {}
  await installAdapters(false);
  await start();
}));

connection.onDidChangeConfiguration(params => void serial(async () => {
  const next = merge(initOptions, params.settings?.aria ?? params.settings);
  const restart = next.enabled !== settings.enabled || next.eventsFile !== settings.eventsFile || JSON.stringify(next.excludePatterns) !== JSON.stringify(settings.excludePatterns);
  const agentsChanged = JSON.stringify(next.agents) !== JSON.stringify(settings.agents);
  settings = next;
  if (session) session.settings = next;
  if (agentsChanged) await installAdapters(false);
  if (restart) await start();
}));

documents.onDidChangeContent(({ document }) => void serial(async () => {
  const s = session;
  const file = fileOf(document.uri);
  if (!s || !s.allowedFile(file)) return;
  const text = document.getText();
  const ours = expected.get(document.uri) === text;
  expected.delete(document.uri);
  if (ours) s.refresh(file, text);
  else if (text === await readDisk(file) || text === s.contentOf(file)) s.refresh(file, text); // reload after an agent/external write
  else if (s.reviewable(file)) s.observeManual(file, text);
  await publish(file);
}));

connection.onCodeAction(params => {
  const s = session;
  if (!s || (params.context.only && !params.context.only.some(kind => CodeActionKind.QuickFix.startsWith(kind)))) return [];
  const file = fileOf(params.textDocument.uri), uri = params.textDocument.uri;
  const hunks = s.hunks.get(path.normalize(file)) ?? [];
  const action = (title: string, command: string, args: unknown[] = [], diagnostics?: Diagnostic[]): CodeAction =>
    ({ title, kind: CodeActionKind.QuickFix, diagnostics, command: { title, command, arguments: args } });
  const actions: CodeAction[] = [];
  const { start, end } = params.range;
  for (const hunk of hunks) {
    const first = hunk.newStart - 1, last = first + Math.max(hunk.newLines.length, 1) - 1;
    if (first > end.line || last < start.line) continue;
    const diagnostics = params.context.diagnostics.filter(d => d.source === "ARIA" && d.code === hunk.id);
    actions.push(action(`ARIA: Accept change (+${hunk.newLines.length} −${hunk.oldLines.length})`, COMMANDS.accept, [uri, hunk.id], diagnostics));
    actions.push(action(`ARIA: Reject change (+${hunk.newLines.length} −${hunk.oldLines.length})`, COMMANDS.reject, [uri, hunk.id], diagnostics));
  }
  if (hunks.length) {
    actions.push(action(`ARIA: Accept file (${hunks.length} change${hunks.length > 1 ? "s" : ""})`, COMMANDS.accept, [uri]));
    actions.push(action(`ARIA: Reject file (${hunks.length} change${hunks.length > 1 ? "s" : ""})`, COMMANDS.reject, [uri]));
  }
  if (s.hunks.size > 1 || (s.hunks.size === 1 && !hunks.length)) {
    actions.push(action(`ARIA: Accept all files (${s.hunks.size})`, COMMANDS.acceptAll));
    actions.push(action(`ARIA: Reject all files (${s.hunks.size})`, COMMANDS.rejectAll));
  }
  if (s.history.length) actions.push(action("ARIA: Undo last decision", COMMANDS.undo));
  return actions;
});

connection.onExecuteCommand(params => serial(async () => {
  const s = session;
  const [uri, id] = (params.arguments ?? []) as [string?, string?];
  try {
    if (params.command === COMMANDS.installAdapters) return await installAdapters(true);
    if (params.command === COMMANDS.adapterStatus) return notify(MessageType.Info, "ARIA hooks: " + adaptersStatus().map(a => `${a.agent} ${a.installed ? "✓" : "✗"}`).join(", "));
    if (!s) return notify(MessageType.Warning, "ARIA review is not running (disabled or no workspace).");
    if (params.command === COMMANDS.undo) return await undo();
    if (params.command === COMMANDS.accept || params.command === COMMANDS.reject) {
      if (typeof uri !== "string") return;
      const file = fileOf(uri);
      return await decide([file], () => params.command === COMMANDS.accept ? accept(file, id) : reject(file, id));
    }
    if (params.command === COMMANDS.acceptAll || params.command === COMMANDS.rejectAll) {
      const files = [...s.hunks.keys()];
      return await decide(files, async () => { for (const file of files) await (params.command === COMMANDS.acceptAll ? accept(file) : reject(file)); });
    }
  } catch (error) {
    notify(MessageType.Error, `ARIA: ${error instanceof Error ? error.message : String(error)}`);
  }
}));

connection.onShutdown(() => serial(stop));
documents.listen(connection);
connection.listen();
}
