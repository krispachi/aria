import * as vscode from "vscode";
import { reviewSetting, exportSettings, importSettings, SUPPORTED_AGENTS, AGENT_LABELS, enabledAgents, agentEnabled, actionLocation, ActionLocation, settingSchemas } from "./config";
import { InlineReview } from "./inline-review";
import { NotificationPolicy, NotificationMode } from "./notifications";
import { computeHunks } from "./diff";
import { DirectoryRegistry, ActivationMode } from "./directories";
import { ReviewCache, excluded } from "./persistence";
import { ReviewPanel, ReviewNode } from "./panel";
import { cleanupRuntime } from "./uninstall";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import {
  ReviewSession,
  proposalUriFor,
  proposalFilePath,
  displayPath,
  TrackMode,
  ReviewFileState,
} from "./session";
import {
  adaptersStatus,
  detectAgents,
  removeAdapters,
  setupAdapters,
  storeInfo,
} from "./adapters";

let session: ReviewSession;
let clEmitter: vscode.EventEmitter<void>;
let statusBar: vscode.StatusBarItem;
let adapterOutput: vscode.OutputChannel;
let inlineReview: InlineReview;
let extensionContext: vscode.ExtensionContext;
let directories: DirectoryRegistry;
let notifications: NotificationPolicy;
let reviewPanel: ReviewPanel;
let cache: ReviewCache | undefined;
let restoringCache = false;
let savedConflicts: ReviewFileState[] = [];
let starting: Promise<void> | undefined;
let setupRunning: Promise<void> | undefined;
let lastStorageWarning = "";
const openedAgentFiles = new Map<string, string>();
let userStopped = false;
let cleaning = false;
let changingSettings = false;

export function activate(context: vscode.ExtensionContext): void {
  extensionContext = context;
  notifications = new NotificationPolicy(context.globalState);
  directories = new DirectoryRegistry(context.globalState);
  adapterOutput = vscode.window.createOutputChannel("ARIA Review");
  context.subscriptions.push(adapterOutput);
  session = new ReviewSession(reviewAgentFiles, isFileEnabled, message => adapterOutput.appendLine(message), agentEnabled);
  clEmitter = new vscode.EventEmitter<void>();

  inlineReview = new InlineReview(session, refreshActive, () => reviewSetting("autoAdvance", true), reviewSetting, reviewChanged);
  context.subscriptions.push(inlineReview);
  reviewPanel = new ReviewPanel(session, reviewSetting);
  context.subscriptions.push(reviewPanel);
  cache = context.storageUri?.scheme === "file" ? new ReviewCache(context.storageUri.fsPath, () => {
    const state = session.exportReview();
    const active = new Set(state.files.map(item => item.file));
    return { ...state, files: [...state.files, ...savedConflicts.filter(item => !active.has(item.file) && isFileEnabled(item.file))] };
  },
    () => reviewSetting("persistReview", true), () => reviewSetting("retentionDays", 7), message => {
      adapterOutput.appendLine(message);
      if (lastStorageWarning !== message) { lastStorageWarning = message; void vscode.window.showWarningMessage(message); }
    }) : undefined;

  statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    60
  );
  statusBar.command = "opencodeInlineReview.toggle";

  const proposalEvents = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  const proposalProvider: vscode.FileSystemProvider = {
    onDidChangeFile: proposalEvents.event,
    watch: () => new vscode.Disposable(() => {}),
    stat: (uri) => ({ type: vscode.FileType.File, ctime: 0, mtime: Date.now(), size: Buffer.byteLength(session.proposalContent(proposalFilePath(uri)) ?? "", "utf8") }),
    readFile: (uri) => Buffer.from(session.proposalContent(proposalFilePath(uri)) ?? "", "utf8"),
    writeFile: (uri, content) => {
      session.setProposal(proposalFilePath(uri), Buffer.from(content).toString("utf8"));
      proposalEvents.fire([{ type: vscode.FileChangeType.Changed, uri }]);
    },
    delete: (uri) => session.deleteProposal(proposalFilePath(uri)),
    readDirectory: () => [],
    createDirectory: () => { throw vscode.FileSystemError.NoPermissions(); },
    rename: () => { throw vscode.FileSystemError.NoPermissions(); },
  };

  const fileWatcher = vscode.workspace.createFileSystemWatcher("**/*");

  context.subscriptions.push(
    statusBar,
    clEmitter,
    proposalEvents,
    fileWatcher,
    fileWatcher.onDidChange((uri) => { if (session.trackAll && session.shouldReview(uri.fsPath)) void reviewAgentFiles([uri.fsPath], false); }),
    fileWatcher.onDidCreate((uri) => { if (session.trackAll && session.shouldReview(uri.fsPath)) void reviewAgentFiles([uri.fsPath], false); }),
    vscode.workspace.registerFileSystemProvider(
      "oir-proposal",
      proposalProvider,
      { isCaseSensitive: process.platform !== "win32" }
    ),

    vscode.commands.registerCommand("opencodeInlineReview.start", startSession),
    vscode.commands.registerCommand("opencodeInlineReview.stop", stopSession),
    vscode.commands.registerCommand("aria.disableAll", async () => {
      await vscode.workspace.getConfiguration("aria").update("enabled", false, vscode.ConfigurationTarget.Global);
      await reconcileDirectories();
      await vscode.window.showInformationMessage("ARIA disabled in all directories. Directory and agent preferences were kept. Use Enable All Directories to resume.");
    }),
    vscode.commands.registerCommand("aria.enableAll", async () => {
      userStopped = false;
      await vscode.workspace.getConfiguration("aria").update("enabled", true, vscode.ConfigurationTarget.Global);
      await reconcileDirectories();
      await vscode.window.showInformationMessage("ARIA globally enabled. Your saved Init policy, directory choices and agent switches still apply.");
    }),
    vscode.commands.registerCommand("aria.configureAgents", configureAgents),
    vscode.commands.registerCommand("aria.disable", async () => {
      const folder = await pickDirectory();
      if (!folder) return;
      await directories.set(folder.uri.fsPath, false);
      await reconcileDirectories();
      await vscode.window.showInformationMessage(`ARIA disabled for ${folder.name}.`);
    }),
    vscode.commands.registerCommand("aria.enable", async () => {
      const folder = await pickDirectory();
      if (!folder) return;
      await directories.set(folder.uri.fsPath, true);
      userStopped = false;
      if (session.isActive) await session.syncDirectories(); else await startSession();
      refreshActive();
      await maybeOfferAdapterSetup(context);
    }),
    vscode.commands.registerCommand("aria.init", async () => {
      const folder = await pickDirectory();
      if (!folder) return;
      await directories.set(folder.uri.fsPath, true);
      userStopped = false;
      if (session.isActive) await session.syncDirectories(); else await startSession();
      refreshActive();
      await maybeOfferAdapterSetup(context);
    }),
    vscode.commands.registerCommand("aria.listDirectories", () => vscode.window.showInformationMessage(`Initialized directories:\n${directories.initialized().join("\n") || "None"}`)),
    vscode.commands.registerCommand("aria.settings", () => vscode.commands.executeCommand("workbench.action.openSettings", "@ext:krispachi.aria-inline-review")),
    vscode.commands.registerCommand("aria.configureShortcuts", () => vscode.commands.executeCommand("workbench.action.openGlobalKeybindings", "ARIA Review")),
    vscode.commands.registerCommand("aria.exportSettings", () => exportSettings(context, directories)),
    vscode.commands.registerCommand("aria.importSettings", async () => {
      changingSettings = true;
      let imported = false;
      try { imported = await importSettings(context, directories); }
      finally { changingSettings = false; }
      if (imported) { userStopped = false; session.mode = configMode(); await reconcileDirectories(); }
    }),
    vscode.commands.registerCommand("aria.cleanData", cleanData),
    vscode.commands.registerCommand("aria.openChanges", () => vscode.commands.executeCommand("aria.changes.focus")),
    vscode.commands.registerCommand("aria.openChange", async (uri: vscode.Uri, line = 0) => { if (session.shouldReview(uri.fsPath)) await inlineReview.open(await vscode.workspace.openTextDocument(uri), line); }),
    vscode.commands.registerCommand("aria.pickChange", async () => { const node = await reviewPanel.pick(); if (node) await inlineReview.open(await vscode.workspace.openTextDocument(node.uri), node.line); }),
    vscode.commands.registerCommand("aria.panelAccept", (node: ReviewNode) => decideNode(node, true)),
    vscode.commands.registerCommand("aria.panelReject", (node: ReviewNode) => decideNode(node, false)),
    vscode.commands.registerCommand("aria.acceptCurrentChange", () => decideCurrent(true)),
    vscode.commands.registerCommand("aria.rejectCurrentChange", () => decideCurrent(false)),
    vscode.commands.registerCommand("aria.undoDecision", async () => {
      if (await session.undoDecision()) {
        await inlineReview.refreshAll(); refreshActive();
        if (reviewSetting("autoAdvance", true)) {
          const file = [...session.hunks.keys()][0];
          if (file) await inlineReview.open(await vscode.workspace.openTextDocument(vscode.Uri.file(file)), session.hunks.get(file)![0].newStart - 1);
        }
      }
    }),
    vscode.commands.registerCommand("aria.clearSavedReview", async () => {
      savedConflicts = [];
      session.clearHistory(); await cache?.clear(); reviewPanel.refresh();
      await vscode.window.showInformationMessage("ARIA: local saved review and Undo history cleared. Current pending review stays in memory; persistence resumes after review content changes. Turn off persistReview to keep all future review in memory only.");
    }),
    vscode.commands.registerCommand("aria.quickSettings", quickSettings),
    vscode.commands.registerCommand("aria.chooseActionLocation", chooseActionLocation),
    vscode.commands.registerCommand("aria.recoverSavedReview", recoverSavedReview),
    vscode.commands.registerCommand("aria.toggleAutoAdvance", () => toggleSetting("autoAdvance", true)),
    vscode.commands.registerCommand("aria.toggleAutoOpen", () => toggleSetting("autoOpen", true)),
    vscode.commands.registerCommand("opencodeInlineReview.toggle", toggleSession),
    vscode.commands.registerCommand(
      "opencodeInlineReview.recompute",
      refreshActive
    ),
    vscode.commands.registerCommand(
      "opencodeInlineReview.toggleTrackAll",
      toggleTrackAll
    ),

    vscode.commands.registerCommand(
      "opencodeInlineReview.markFile",
      () => {
        const editor = vscode.window.activeTextEditor;
        if (!session.isActive || !editor) {
          return;
        }
        session.markTouched(editor.document.uri.fsPath);
        renderEditor(editor);
        void inlineReview.open(editor.document);
      }
    ),

    vscode.commands.registerCommand(
      "opencodeInlineReview.openEditableProposal",
      openEditableProposal
    ),
    vscode.commands.registerCommand(
      "opencodeInlineReview.applyProposal",
      applyProposal
    ),
    vscode.commands.registerCommand(
      "opencodeInlineReview.discardProposal",
      discardProposal
    ),

    vscode.commands.registerCommand(
      "opencodeInlineReview.setupAdapters",
      () => runSetupAndReport(context)
    ),
    vscode.commands.registerCommand(
      "opencodeInlineReview.removeAdapters",
      () => runRemovalAndReport()
    ),
    vscode.commands.registerCommand(
      "opencodeInlineReview.adaptersStatus",
      () => showAdapterStatus()
    ),

    vscode.commands.registerCommand(
      "opencodeInlineReview.acceptHunk",
      async (uri: vscode.Uri, id: string) => {
        await session.decide([uri.fsPath], () => session.acceptHunk(uri, id));
        refreshUri(uri);
      }
    ),

    vscode.commands.registerCommand(
      "opencodeInlineReview.rejectHunk",
      async (uri: vscode.Uri, id: string) => {
        await session.decide([uri.fsPath], () => session.rejectHunk(uri, id));
        refreshUri(uri);
      }
    ),

    vscode.commands.registerCommand(
      "opencodeInlineReview.acceptAllInFile",
      async (uri: vscode.Uri) => {
        await session.decide([uri.fsPath], async () => session.acceptFile(uri, (await vscode.workspace.openTextDocument(uri)).getText()));
        refreshUri(uri);
      }
    ),

    vscode.commands.registerCommand(
      "opencodeInlineReview.rejectAllInFile",
      async (uri: vscode.Uri) => {
        await session.decide([uri.fsPath], () => session.rejectAllInFile(uri));
        refreshUri(uri);
      }
    ),

    vscode.commands.registerCommand(
      "opencodeInlineReview.acceptAll",
      async () => {
        await session.decide([...session.hunks.keys()], async () => { for (const filePath of [...session.hunks.keys()]) {
          const uri = vscode.Uri.file(filePath);
          session.acceptFile(uri, (await vscode.workspace.openTextDocument(uri)).getText());
        } });
        refreshActive();
      }
    ),

    vscode.commands.registerCommand(
      "opencodeInlineReview.rejectAll",
      async () => {
        const count = session.pendingCount;
        const pick = await vscode.window.showWarningMessage(
          `Reject ${count} changes?`,
          { modal: true },
          "Reject All"
        );
        if (pick === "Reject All") {
          await session.decide([...session.hunks.keys()], () => session.rejectAll());
          refreshActive();
        }
      }
    ),

    vscode.workspace.onDidChangeTextDocument((e) => {
      if (!session.isActive) {
        return;
      }
      if (e.document.uri.scheme === "file" && isFileEnabled(e.document.uri.fsPath) && !session.trackAll && e.document.isDirty && e.contentChanges.length && !session.isApplying) {
        session.observeManual(e.document.uri, e.document.getText());
        inlineReview.update(e.document);
      }
      if (e.document.uri.scheme === "file" && session.shouldReview(e.document.uri.fsPath)) {
        session.refreshFor(e.document.uri, e.document.getText());
        inlineReview.update(e.document);
        updateStatus();
        clEmitter.fire();
      }
      const editor = findEditor(e.document.uri);
      if (editor) {
        inlineReview.render(editor);
        renderEditor(editor);
      }
    }),

    vscode.window.onDidChangeActiveTextEditor((editor) => {
      inlineReview.syncContext();
      if (editor) inlineReview.render(editor);
      renderEditor(editor);
      reviewPanel.updatePosition();
    }),
    vscode.window.onDidChangeTextEditorSelection(() => reviewPanel.updatePosition()),
    vscode.window.tabGroups.onDidChangeTabs(() => inlineReview.releaseClosed()),

    vscode.workspace.onDidChangeWorkspaceFolders(() => { void reconcileDirectories(); }),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (!changingSettings) {
        const agentsChanged = SUPPORTED_AGENTS.some(agent => e.affectsConfiguration(`aria.agents.${agent}.enabled`));
        const directoriesChanged = e.affectsConfiguration("aria.activationMode") || e.affectsConfiguration("aria.excludePatterns");
        if (agentsChanged || e.affectsConfiguration("aria.track")) session.mode = configMode();
        if (agentsChanged || e.affectsConfiguration("aria.enabled") || directoriesChanged || e.affectsConfiguration("aria.adapterSetup")) void reconcileDirectories(directoriesChanged);
      }
      if (e.affectsConfiguration("aria.undoLimit") && reviewSetting<number>("undoLimit", 20) === 0) session.clearHistory();
      if (e.affectsConfiguration("aria")) { reviewPanel.refresh(); void inlineReview.refreshAll(); }
      if (e.affectsConfiguration("aria.persistReview")) {
        if (!reviewSetting("persistReview", true)) void cache?.clear(); else cache?.resume();
      }
    })
  );

  // Auto-start: tanpa perlu klik Start Session
  setTimeout(() => void migrateAndStart(), 1000);

  // onboarding: tawarkan pasang adapter (user-level, tanpa file di proyek)
  setTimeout(() => void maybeOfferAdapterSetup(context), 2500);

  updateStatus();
  refreshActive();
}

export async function deactivate(): Promise<void> {
  if (session?.isActive) await cache?.save();
  else await cache?.drain();
  session?.stop();
}

function reviewChanged(): void {
  void vscode.commands.executeCommand("setContext", "aria.hasRecovery", savedConflicts.length > 0);
  reviewPanel?.refresh();
  if (session?.isActive && !restoringCache) cache?.schedule();
}
async function decideNode(node: ReviewNode, accept: boolean): Promise<void> {
  if (!session.isActive || !session.shouldReview(node.uri.fsPath)) return;
  if (!node.id) { await vscode.commands.executeCommand(accept ? "aria.acceptFile" : "aria.rejectFile", node.uri); return; }
  const doc = await vscode.workspace.openTextDocument(node.uri);
  await vscode.commands.executeCommand("aria.reviewBlock", node.uri, doc.getText(), session.baselineOf(node.uri.fsPath), node.id, accept);
}
async function decideCurrent(accept: boolean): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const uri = editor.document.uri.scheme === "aria-baseline" ? vscode.Uri.file(decodeURIComponent(editor.document.uri.query)) : editor.document.uri;
  const list = session.hunks.get(uri.fsPath) ?? [];
  const line = editor.selection.active.line;
  const h = [...list].reverse().find(h => h.newStart - 1 <= line) ?? list[0];
  if (h) await decideNode({ uri, id: h.id }, accept);
}
async function toggleSetting(key: string, fallback: boolean): Promise<void> {
  const config = vscode.workspace.getConfiguration("aria");
  const scope = config.inspect(key)?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
  await config.update(key, !reviewSetting(key, fallback), scope);
}
async function recoverSavedReview(): Promise<void> {
  if (!session.isActive) await startSession();
  const choices = savedConflicts.filter(item => isFileEnabled(item.file)).map(item => ({ label: displayPath(item.file), item }));
  if (!choices.length) { await vscode.window.showInformationMessage("ARIA: no conflicting saved snapshots to recover."); return; }
  const choice = await vscode.window.showQuickPick(choices, { placeHolder: "Compare a saved snapshot with the current file. Later manual edits may be included." });
  if (!choice) return;
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(choice.item.file));
  await session.restoreReview({ version: 1, savedAt: Date.now(), files: [{ ...choice.item, content: doc.getText() }], undo: session.exportReview().undo });
  savedConflicts = savedConflicts.filter(item => item.file !== choice.item.file);
  await inlineReview.open(doc, (session.hunks.get(choice.item.file)?.[0]?.newStart ?? 1) - 1);
  reviewChanged();
}
async function quickSettings(): Promise<void> {
  const choices = [
    { label: "Open all ARIA settings", key: "settings" },
    { label: `ARIA in all directories: ${reviewSetting("enabled", true) ? "On" : "Off"}`, key: "global" },
    { label: "Choose CLI agents to review", key: "agents" },
    { label: `Accept/Reject button location: file ${LOCATION_LABELS[actionLocation("file")]}, all ${LOCATION_LABELS[actionLocation("all")]}`, key: "location" },
    { label: `Per-group button position: ${reviewSetting("blockActionsAnchor", "beforeGroup") === "beforeGroup" ? "above the group (buttons, context line, red, green)" : "between red and green"}`, key: "anchor" },
    ...["autoAdvance", "autoOpen", "autoSaveResolved", "autoUnfold", "persistReview", "showChangesView", "showPosition", "showBlockActions", "showPendingBadge", "restoreOnReopen", "preserveTerminalFocus"].map(key => ({ label: `${key}: ${reviewSetting(key, !["preserveTerminalFocus"].includes(key)) ? "On" : "Off"}`, key })),
    { label: "Configure keyboard shortcuts", key: "shortcuts" }, { label: "Export settings", key: "export" }, { label: "Import settings", key: "import" },
    { label: "Clean extension data", key: "clean" },
    { label: "Notification mode", key: "notifications" }, { label: "Agent adapter status", key: "adapters" },
    { label: "Diff display settings", key: "diff" }, { label: "Diff and theme colors", key: "colors" },
  ];
  const choice = await vscode.window.showQuickPick(choices, { placeHolder: "Customize ARIA" });
  if (!choice) return;
  if (choice.key === "settings") { await vscode.commands.executeCommand("aria.settings"); return; }
  if (choice.key === "global") { await vscode.commands.executeCommand(reviewSetting("enabled", true) ? "aria.disableAll" : "aria.enableAll"); return; }
  if (choice.key === "agents") { await configureAgents(); return; }
  if (choice.key === "location") { await chooseActionLocation(); return; }
  if (choice.key === "anchor") {
    const config = vscode.workspace.getConfiguration("aria");
    const next = reviewSetting("blockActionsAnchor", "beforeGroup") === "beforeGroup" ? "firstChangedRow" : "beforeGroup";
    await config.update("blockActionsAnchor", next, config.inspect("blockActionsAnchor")?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global);
    return;
  }
  if (choice.key === "clean") { await vscode.commands.executeCommand("aria.cleanData"); return; }
  if (["shortcuts", "export", "import"].includes(choice.key)) { await vscode.commands.executeCommand(({ shortcuts: "aria.configureShortcuts", export: "aria.exportSettings", import: "aria.importSettings" } as Record<string, string>)[choice.key]); return; }
  if (choice.key === "adapters") { await showAdapterStatus(); return; }
  if (choice.key === "diff" || choice.key === "colors") { await vscode.commands.executeCommand("workbench.action.openSettings", choice.key === "diff" ? "diffEditor" : "workbench.colorCustomizations"); return; }
  if (choice.key === "notifications") {
    const mode = await vscode.window.showQuickPick(["once", "minimal", "full"], { placeHolder: "Automatic notification mode" });
    if (mode) await vscode.workspace.getConfiguration("aria").update("notifications", mode, vscode.ConfigurationTarget.Global);
  } else await toggleSetting(choice.key, !["preserveTerminalFocus"].includes(choice.key));
}

const LOCATION_LABELS: Record<ActionLocation, string> = { statusBar: "Status bar (bottom)", editorToolbar: "Editor toolbar (top)", both: "Both", hidden: "Hidden" };
async function chooseActionLocation(): Promise<void> {
  const groups = [
    { label: "Accept File / Reject File", description: LOCATION_LABELS[actionLocation("file")], keys: ["fileActionsLocation"] },
    { label: "Accept All / Reject All", description: LOCATION_LABELS[actionLocation("all")], keys: ["allActionsLocation"] },
    { label: "Both button groups", keys: ["fileActionsLocation", "allActionsLocation"] },
  ];
  const group = await vscode.window.showQuickPick(groups, { placeHolder: "Which Accept/Reject buttons do you want to move?" });
  if (!group) return;
  const current = group.keys.length === 1 ? actionLocation(group.keys[0] === "fileActionsLocation" ? "file" : "all") : undefined;
  const location = await vscode.window.showQuickPick((Object.keys(LOCATION_LABELS) as ActionLocation[]).map(value => ({ label: LOCATION_LABELS[value], description: value === current ? "current" : undefined, value })),
    { placeHolder: `Where should ${group.label} appear? Commands and the Changes view keep working when hidden.` });
  if (!location) return;
  const config = vscode.workspace.getConfiguration("aria");
  for (const key of group.keys) {
    const scope = config.inspect(key)?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    await config.update(key, location.value, scope);
  }
  inlineReview.syncContext();
}

async function configureAgents(): Promise<void> {
  const choices = SUPPORTED_AGENTS.map(agent => ({ label: AGENT_LABELS[agent], agent, picked: agentEnabled(agent) }));
  const selected = await vscode.window.showQuickPick(choices, { canPickMany: true, placeHolder: "Review edits from checked agents. Existing pending reviews remain available." });
  if (!selected) return;
  const config = vscode.workspace.getConfiguration("aria");
  const changed: Array<{ key: string; value: unknown }> = [];
  changingSettings = true;
  try {
    for (const agent of SUPPORTED_AGENTS) {
      const enabled = selected.some(item => item.agent === agent);
      if (agentEnabled(agent) === enabled) continue;
      const key = `agents.${agent}.enabled`;
      changed.push({ key, value: config.inspect(key)?.globalValue });
      await config.update(key, enabled, vscode.ConfigurationTarget.Global);
    }
  } catch (error) {
    for (const item of changed.reverse()) {
      try { await config.update(item.key, item.value, vscode.ConfigurationTarget.Global); }
      catch (failure) { adapterOutput.appendLine(`Agent setting rollback failed: ${String(failure)}`); }
    }
    await vscode.window.showErrorMessage(`ARIA could not update agent choices: ${String(error)}. Check ARIA Settings.`);
  } finally { changingSettings = false; }
  session.mode = configMode();
  await reconcileDirectories(false);
}

async function cleanData(): Promise<void> {
  const choice = await vscode.window.showQuickPick([
    { label: "Export settings, then clean", backup: true },
    { label: "Clean without exporting settings", backup: false },
  ], { placeHolder: "Remove ARIA preferences, hooks, runtime data, adapter backups and this workspace's saved review. Other workspace caches and VS Code shortcuts are not touched." });
  if (!choice || (choice.backup && !await exportSettings(extensionContext, directories))) return;
  if (await vscode.window.showWarningMessage("Clean ARIA data? Source files and unrelated settings are preserved. Pending review and directory preferences will be removed. Uninstall ARIA afterward to prevent recreation on another launch.", { modal: true }, "Clean") !== "Clean") return;
  cleaning = true;
  userStopped = true;
  try {
    await starting;
    await setupRunning;
    session.stop(); savedConflicts = []; openedAgentFiles.clear(); inlineReview.clear();
    await cache?.clear();
    const failures = cleanupRuntime(true);
    for (const [fullKey] of Object.entries(settingSchemas(extensionContext.extension.packageJSON))) {
      const split = fullKey.indexOf(".");
      const namespace = fullKey.slice(0, split), key = fullKey.slice(split + 1);
      const config = vscode.workspace.getConfiguration(namespace);
      for (const [target, value] of [[vscode.ConfigurationTarget.Global, config.inspect(key)?.globalValue], [vscode.ConfigurationTarget.Workspace, config.inspect(key)?.workspaceValue]] as const) {
        if (value !== undefined) try { await config.update(key, undefined, target); } catch (error) { failures.push(String(error)); }
      }
      for (const folder of vscode.workspace.workspaceFolders ?? []) {
        const scoped = vscode.workspace.getConfiguration(namespace, folder.uri);
        if (scoped.inspect(key)?.workspaceFolderValue !== undefined) try { await scoped.update(key, undefined, vscode.ConfigurationTarget.WorkspaceFolder); } catch (error) { failures.push(String(error)); }
      }
    }
    await directories.clear();
    for (const key of ["ariaWelcomeShown", "ariaEnabled", "adapterSetupAsked", "adapterSetupVersion", "adapterSetupAttempt", "adapterSetupSelection"]) await extensionContext.globalState.update(key, undefined);
    refreshActive();
    if (failures.length) {
      failures.forEach(failure => adapterOutput.appendLine("Cleanup: " + failure));
      await vscode.window.showWarningMessage("ARIA cleanup completed with some files/settings preserved. See Output > ARIA Review for details.");
    } else await vscode.window.showInformationMessage("ARIA data cleaned for this installation and current workspace. Uninstall ARIA now; other workspace caches and custom shortcuts can be removed through VS Code separately.");
  } catch (error) { await vscode.window.showErrorMessage(`ARIA could not finish cleanup: ${String(error)}. See ARIA settings before uninstalling.`); }
}

function configMode(): TrackMode {
  // Track All cannot identify the producer of filesystem/editor changes.
  return enabledAgents().length < SUPPORTED_AGENTS.length ? "agent" : reviewSetting<TrackMode>("track", "agent");
}

function notificationMode(): NotificationMode { return reviewSetting<NotificationMode>("notifications", "once"); }
async function automaticInfo(detail: string): Promise<void> {
  adapterOutput.appendLine(detail);
  const mode = notificationMode();
  if (!await notifications.claim(mode)) return;
  const message = mode === "full" ? detail :
    `ARIA ${session.isActive ? "review is active" : "is installed"}. CLI edits use Accept/Reject. After adapter installation, restart your CLI and approve its hook if requested. Settings: ARIA Review: Settings; disable per directory: ARIA Review: Disable.`;
  void vscode.window.showInformationMessage(message);
}

function isAutoStartEnabled(): boolean {
  return reviewSetting("autoStart", true);
}

function isEnabled(): boolean {
  return reviewSetting("enabled", true) && enabledAgents().length > 0 && !cleaning && vscode.workspace.isTrusted !== false && !!vscode.workspace.workspaceFolders?.some(folder => directories.isEnabled(folder.uri.fsPath, activationMode()));
}

function activationMode(): ActivationMode { return reviewSetting<ActivationMode>("activationMode", "all"); }

function isFileEnabled(file: string): boolean {
  const folder = vscode.workspace.workspaceFolders?.filter(folder => {
    const relative = path.relative(folder.uri.fsPath, file);
    return relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
  }).sort((a, b) => b.uri.fsPath.length - a.uri.fsPath.length)[0];
  return !!folder && directories.isEnabled(folder.uri.fsPath, activationMode()) && !excluded(path.relative(folder.uri.fsPath, file), reviewSetting("excludePatterns", ["**/.env", "**/.env.*", "**/*.pem", "**/*.key"]));
}

async function pickDirectory(): Promise<vscode.WorkspaceFolder | undefined> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) { await vscode.window.showWarningMessage("Open a directory first."); return; }
  return folders.length === 1 ? folders[0] : vscode.window.showWorkspaceFolderPick({ placeHolder: "Choose the directory for ARIA" });
}

async function reconcileDirectories(rescan = true): Promise<void> {
  // Keep pending baselines in eligible directories when mode or folder state changes.
  for (const file of [...session.hunks.keys()]) if (!isFileEnabled(file)) session.hunks.delete(file);
  if (!isEnabled()) {
    const manuallyStopped = userStopped;
    stopSession();
    userStopped = manuallyStopped;
  }
  else if (session.isActive && rescan) await session.syncDirectories();
  else if (!session.isActive && isAutoStartEnabled() && !userStopped) await autoStartSession();
  refreshActive();
  await maybeOfferAdapterSetup(extensionContext);
}

async function migrateAndStart(): Promise<void> {
  if (extensionContext.globalState.get<boolean>("ariaEnabled") === false && vscode.workspace.workspaceFolders?.length) {
    for (const folder of vscode.workspace.workspaceFolders) await directories.set(folder.uri.fsPath, false);
    await extensionContext.globalState.update("ariaEnabled", undefined);
  }
  await autoStartSession();
  if (reviewSetting("enabled", true) && !vscode.workspace.workspaceFolders?.length) await automaticInfo("ARIA installed. Open a trusted folder to start reviewing CLI edits.");
}

async function autoStartSession(): Promise<void> {
  if (
    userStopped ||
    !isEnabled() ||
    session.isActive ||
    !vscode.workspace.workspaceFolders?.length ||
    !isAutoStartEnabled()
  ) {
    return;
  }
  await startSession({ automatic: true });
}

async function startSession(opts?: { automatic?: boolean }): Promise<void> {
  if (!starting) starting = doStartSession(opts).finally(() => { starting = undefined; });
  return starting;
}
async function doStartSession(opts?: { automatic?: boolean }): Promise<void> {
  if (!vscode.workspace.workspaceFolders?.length) {
    vscode.window.showWarningMessage(
      "Open a project folder before starting a review session."
    );
    return;
  }
  if (!isEnabled()) {
    await vscode.window.showInformationMessage(!reviewSetting("enabled", true) ? "ARIA is globally disabled. Use ARIA Review: Enable All Directories." : !enabledAgents().length ? "No ARIA agents are enabled. Use ARIA Review: Choose Agents." : "ARIA is disabled or not initialized for this directory. Use ARIA Review: Init Directory or Enable.");
    return;
  }
  const mode = configMode();
  if (!opts?.automatic) userStopped = false;
  const saved = await cache?.load();
  savedConflicts = [];
  restoringCache = true;
  try {
  await vscode.window.withProgress(
    {
      location: opts?.automatic && notificationMode() !== "full" ? vscode.ProgressLocation.Window : vscode.ProgressLocation.Notification,
      title: "ARIA Review: taking baseline snapshot…",
    },
    async () => {
      await session.start(mode);
      if (!isEnabled() || !session.isActive) return;
      openedAgentFiles.clear();
      inlineReview.clear();
      if (saved) {
        const conflicts = await session.restoreReview(saved);
        savedConflicts = saved.files.filter(item => conflicts.includes(item.file));
        if (conflicts.length) void vscode.window.showWarningMessage(`ARIA restored matching files. ${conflicts.length} saved review file(s) changed while closed; snapshots were retained without replacing your files. Use Recover Saved Review to compare them, or Clear Saved Review to remove them.`);
        for (const file of [...session.hunks.keys()]) {
          const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
          inlineReview.update(doc);
          if (await fs.readFile(file, "utf8").catch(() => undefined) === doc.getText()) openedAgentFiles.set(file, doc.getText());
        }
      }
    }
  );
  } finally { restoringCache = false; }
  if (!session.isActive) return;
  updateStatus();
  refreshActive();
  const extra =
    mode === "agent"
      ? " Reviewing files reported by agent adapters."
      : " Reviewing all file changes during this session.";
  if (opts?.automatic) {
    await automaticInfo(
      `ARIA Review started automatically (mode ${mode}).${extra}`
    );
  } else {
    vscode.window.showInformationMessage(
      "Review session started. Run your CLI agent in the terminal, then review its changes." +
        extra
    );
  }
}

function stopSession(): void {
  if (session.isActive) void cache?.save();
  userStopped = true;
  session.stop();
  inlineReview.clear();
  updateStatus();

  clEmitter.fire();
}

function toggleSession(): void {
  if (session.isActive) {
    stopSession();
  } else {
    void startSession();
  }
}

async function toggleTrackAll(): Promise<void> {
  const cfg = vscode.workspace.getConfiguration("aria");
  const next: TrackMode = configMode() === "all" ? "agent" : "all";
  if (next === "all" && enabledAgents().length < SUPPORTED_AGENTS.length) {
    await vscode.window.showWarningMessage("ARIA Track All cannot distinguish agents. Enable all agents first, or keep agent mode to respect your per-agent choices.");
    return;
  }
  await cfg.update("track", next, vscode.ConfigurationTarget.Global);
  if (session.isActive) {
    session.mode = next;
    refreshActive();
  }
  updateStatus();
}

async function openEditableProposal(uri?: vscode.Uri): Promise<void> {
  const src = uri ?? vscode.window.activeTextEditor?.document.uri;
  if (!src || src.scheme !== "file" || !session.isActive) {
    return;
  }
  const filePath = src.fsPath;
  const content =
    session.proposalContent(filePath) ??
    (await vscode.workspace.openTextDocument(src)).getText();
  session.setProposal(filePath, content);

  const propUri = proposalUriFor(filePath);
  const doc = await vscode.workspace.openTextDocument(propUri);
  const activeColumn = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

  await vscode.window.showTextDocument(doc, {
    viewColumn: activeColumn === vscode.ViewColumn.One ? vscode.ViewColumn.Two : activeColumn,
    preview: false,
  });
}

async function applyProposal(uri?: vscode.Uri): Promise<void> {
  if (!session.isActive) {
    return;
  }
  const propUri =
    uri ??
    (vscode.window.activeTextEditor?.document.uri.scheme === "oir-proposal"
      ? vscode.window.activeTextEditor.document.uri
      : undefined);
  if (!propUri || propUri.scheme !== "oir-proposal") {
    vscode.window.showWarningMessage(
      "Open a Proposal tab first, then run Apply Proposal."
    );
    return;
  }
  const filePath = proposalFilePath(propUri);
  const content = (await vscode.workspace.openTextDocument(propUri)).getText();
  const realUri = vscode.Uri.file(filePath);
  await vscode.workspace.fs.writeFile(realUri, Buffer.from(content, "utf8"));
  session.acceptFile(realUri, content);
  session.deleteProposal(filePath);
  session.markTouched(filePath);
  resolveFile(filePath);
  await closeProposalTab(propUri);
  refreshUri(realUri);
  vscode.window.showInformationMessage(
    `Proposal applied: ${displayPath(filePath)}`
  );
}

async function discardProposal(uri?: vscode.Uri): Promise<void> {
  const propUri =
    uri ??
    (vscode.window.activeTextEditor?.document.uri.scheme === "oir-proposal"
      ? vscode.window.activeTextEditor.document.uri
      : undefined);
  if (!propUri || propUri.scheme !== "oir-proposal") {
    return;
  }
  const filePath = proposalFilePath(propUri);
  session.deleteProposal(filePath);
  await closeProposalTab(propUri);
}

async function closeProposalTab(propUri: vscode.Uri): Promise<void> {
  const tab = vscode.window.tabGroups.all
    .flatMap((g) => g.tabs)
    .find(
      (t) =>
        t.input instanceof vscode.TabInputText &&
        t.input.uri.toString() === propUri.toString()
    );
  if (tab) {
    await vscode.window.tabGroups.close(tab);
  }
}

function resolveFile(filePath: string): void {
  const key = filePath;
  const hunks = session.hunks.get(key) ?? [];
  const uri = vscode.Uri.file(filePath);
  for (const h of hunks) {
    session.acceptHunk(uri, h.id);
  }
  if (hunks.length === 0) {
    session.hunks.delete(key);
  }
  clEmitter.fire();
}

function refreshUri(uri: vscode.Uri): void {
  void vscode.workspace.openTextDocument(uri).then(doc => {
    if (session.isActive && session.shouldReview(uri.fsPath)) {
      session.refreshFor(uri, doc.getText());
      inlineReview.update(doc);
    }
    updateStatus();
    clEmitter.fire();
  });
  const editor = findEditor(uri);
  if (editor) {
    renderEditor(editor);
  }
}

function refreshActive(): void {
  if (session.isActive) void inlineReview.refreshAll();
  for (const editor of vscode.window.visibleTextEditors) renderEditor(editor);
  updateStatus();
  reviewChanged();
  clEmitter.fire();
}

async function reviewAgentFiles(files: string[], agentReported = true): Promise<void> {
  for (const file of files) {
    if (!session.isActive || !session.shouldReview(file)) continue;
    try {
      if ((await fs.stat(file)).size > reviewSetting("maxFileSizeKb", 1024) * 1024) {
        session.hunks.delete(path.normalize(vscode.Uri.file(file).fsPath)); adapterOutput.appendLine(`ARIA skipped oversized file: ${displayPath(file)}`); continue;
      }
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      if (agentReported) session.noteAgentBuffer(doc);
      if (agentReported) {
        const disk = await fs.readFile(file, "utf8");
        if (!session.isActive) break;
        if (doc.getText() !== disk) {
          if (doc.isDirty && doc.getText() !== openedAgentFiles.get(doc.uri.fsPath)) {
            void vscode.window.showWarningMessage(`ARIA: ${displayPath(file)} has unsaved manual edits and the agent changed its disk copy. Resolve the save conflict before reviewing.`);
            continue;
          }
          const edit = new vscode.WorkspaceEdit();
          edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), disk, { label: "ARIA agent edit", needsConfirmation: false });
          await session.internally(() => vscode.workspace.applyEdit(edit));
          // The previous buffer was confirmed safe above; the replacement belongs to the agent.
          session.noteAgentBuffer(doc, true);
        }
      }
      if (!session.isActive) break;
      const hunks = session.refreshFor(doc.uri, doc.getText());
      inlineReview.update(doc);
      if (hunks.length && reviewSetting("autoOpen", true) && openedAgentFiles.get(doc.uri.fsPath) !== doc.getText()) {
        const previous = openedAgentFiles.get(doc.uri.fsPath);
        const target = previous === undefined ? hunks[0].newStart - 1 : (computeHunks(previous, doc.getText())[0]?.newStart ?? hunks[0].newStart) - 1;
        await inlineReview.open(doc, target, reviewSetting("preserveTerminalFocus", false));
        openedAgentFiles.set(doc.uri.fsPath, doc.getText());
        if (agentReported && session.isActive && !doc.isDirty && doc.getText().length) {
          const edit = new vscode.WorkspaceEdit();
          // An annotated same-content edit keeps disk content intact and creates a native undo/dirty buffer entry.
          edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), doc.getText(), { label: "ARIA agent review", needsConfirmation: false });
          await session.internally(() => vscode.workspace.applyEdit(edit));
          // A whole-document replace moves the cursor to the end; keep focus on the change.
          const editor = findEditor(doc.uri), position = doc.validatePosition(new vscode.Position(target, 0));
          if (editor) {
            editor.selection = new vscode.Selection(position, position);
            editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
          }
        }
      }
    } catch {}
  }
  refreshActive();
}

function findEditor(uri: vscode.Uri): vscode.TextEditor | undefined {
  return vscode.window.visibleTextEditors.find(
    (e) => e.document.uri.toString() === uri.toString()
  );
}

function renderEditor(editor: vscode.TextEditor | undefined): void {
  if (!session.isActive || !editor) {
    return;
  }
  const doc = editor.document;
  if (doc.uri.scheme !== "file") {
    return;
  }
  if (!session.shouldReview(doc.uri.fsPath)) {
    if (session.hunks.has(doc.uri.fsPath)) {
      session.hunks.delete(doc.uri.fsPath);
      clEmitter.fire();
    }
    return;
  }
  session.refreshFor(doc.uri, doc.getText());

  // Native diff owns line and character backgrounds; no source decorations overlap it.
  clEmitter.fire();
  updateStatus();
}

function updateStatus(): void {
  statusBar.command = !reviewSetting("enabled", true) ? "aria.enableAll" : !enabledAgents().length ? "aria.configureAgents" : !isEnabled() ? (activationMode() === "init" ? "aria.init" : "aria.enable") : "opencodeInlineReview.toggle";
  if (!session.isActive) {
    statusBar.text = reviewSetting("enabled", true) ? "$(eye) ARIA Review" : "$(eye-closed) ARIA Off";
    statusBar.tooltip =
      !reviewSetting("enabled", true) ? "ARIA is disabled in all directories. Click to re-enable with your saved directory and agent preferences." : !enabledAgents().length ? "All ARIA agents are disabled. Click to choose agents." : "Start a review session to accept or reject agent changes.";
    statusBar.color = undefined;
  } else {
    const mode = session.trackAll ? "all" : "agent";
    const f = session.pendingFiles;
    const c = session.pendingCount;
    statusBar.text = `$(eye) ARIA Review: ${mode} · ${f} file(s) · ${c} change(s)`;
    statusBar.tooltip =
      session.trackAll
        ? "Mode: all files. Click to stop."
        : `Mode: agent files (${session.touchedCount} detected). Click to stop.`;
    statusBar.color = new vscode.ThemeColor("charts.green");
  }
  statusBar.show();
}

function adapterSetupMode(): "ask" | "auto" | "off" {
  return reviewSetting<"ask" | "auto" | "off">("adapterSetup", "auto");
}

async function maybeOfferAdapterSetup(
  context: vscode.ExtensionContext
): Promise<void> {
  if (!isEnabled()) return;
  const mode = adapterSetupMode();
  if (mode === "off") {
    return;
  }
  if (mode === "auto") {
    const version = context.extension.packageJSON.version as string;
    if (context.globalState.get<string>("adapterSetupVersion") === version && context.globalState.get<string>("adapterSetupSelection") === enabledAgents().join(",") && adaptersStatus().every(adapter => !agentEnabled(adapter.agent) || adapter.installed)) return;
    // A failed automatic attempt is not retried for the same version and agent
    // selection: retrying on every settings/folder change rewrote CLI configs
    // and repeated the warning. Install Agent Adapters retries manually.
    if (context.globalState.get<string>("adapterSetupAttempt") === `${version}|${enabledAgents().join(",")}`) return;
    await runSetupAndReport(context, true);
    return;
  }
  await offerAdapterSetup(context);
}

async function offerAdapterSetup(
  context: vscode.ExtensionContext,
  force = false
): Promise<void> {
  if (!force) {
    if (context.globalState.get<boolean>("adapterSetupAsked")) {
      return;
    }
    await context.globalState.update("adapterSetupAsked", true);
  }
  const pick = await vscode.window.showInformationMessage(
    "ARIA: install CLI agent adapters at user level?",
    "Install",
    "Later",
    ...(force ? [] : ["Do not ask again"])
  );
  if (pick === "Install") {
    await runSetupAndReport(context);
  } else if (pick === "Do not ask again") {
    await vscode.workspace.getConfiguration("aria").update("adapterSetup", "off", vscode.ConfigurationTarget.Global);
  }
}

async function runSetupAndReport(
  context: vscode.ExtensionContext,
  automatic = false
): Promise<void> {
  if (!setupRunning) setupRunning = doSetupAndReport(context, automatic).finally(() => { setupRunning = undefined; });
  return setupRunning;
}
async function doSetupAndReport(context: vscode.ExtensionContext, automatic: boolean): Promise<void> {
  if (vscode.workspace.isTrusted === false) {
    await vscode.window.showWarningMessage("Trust this workspace in VS Code before installing ARIA adapters.");
    return;
  }
  if (!reviewSetting("enabled", true) || !enabledAgents().length) {
    if (!automatic) await vscode.window.showInformationMessage("Enable ARIA globally and select at least one agent before installing adapters.");
    return;
  }
  const selected = enabledAgents();
  adapterOutput.clear();
  adapterOutput.appendLine(`Installing user-level CLI adapters for: ${selected.join(", ")}...`);
  if (!automatic) adapterOutput.show(true);
  try {
  const results = await vscode.window.withProgress(
    {
      location: automatic && notificationMode() !== "full" ? vscode.ProgressLocation.Window : vscode.ProgressLocation.Notification,
      title: "ARIA Review: setting up adapters...",
    },
    () => setupAdapters(context, selected)
  );
  const detail = results
    .map((r) => `${r.ok ? "✓" : "✗"} ${r.agent}: ${r.message}`)
    .join("\n");
  adapterOutput.appendLine(detail);
  if (automatic) await context.globalState.update("adapterSetupAttempt", `${context.extension.packageJSON.version}|${selected.join(",")}`);
  adapterOutput.appendLine("Restart the CLI after installation. For Codex CLI, run /hooks to review and trust the installed hook.");
  if (results.every((r) => r.ok)) {
    await context.globalState.update("adapterSetupVersion", context.extension.packageJSON.version);
    await context.globalState.update("adapterSetupSelection", selected.join(","));
    if (automatic) await automaticInfo("ARIA is ready. Restart your CLI and review its hook trust prompt. Disable anytime with ARIA Review: Disable.");
    else vscode.window.showInformationMessage("Adapters installed at user level.\n" + detail);
  } else {
    vscode.window.showWarningMessage(
      "Adapter installation finished; some adapters need attention:\n" + detail
    );
  }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    adapterOutput.appendLine(`Installation failed: ${message}`);
    await vscode.window.showErrorMessage(`ARIA adapter installation failed: ${message}. See Output > ARIA Review.`);
  }
}

async function showAdapterStatus(): Promise<void> {
  const st = adaptersStatus();
  const detected = detectAgents();
  const lines = st.map((s) => `${s.installed ? "✓" : "✗"} ${s.agent}: review ${agentEnabled(s.agent) ? "On" : "Off"}${!agentEnabled(s.agent) && s.installed ? " (existing hook kept; events ignored)" : ""}`).join("\n");
  vscode.window.showInformationMessage(
    `Agent file detection:\n${lines}\n\nInstalled CLIs: ${
      detected.length ? detected.join(", ") : "none detected"
    }\nStore events (global): ${storeInfo()}\nActive event stream: ${session.eventsPath || "No session"}`
  );
}

async function runRemovalAndReport(): Promise<void> {
  const results = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "ARIA Review: removing adapters...",
    },
    () => removeAdapters()
  );
  const detail = results
    .map((r) => `${r.ok ? "✓" : "✗"} ${r.agent}: ${r.message}`)
    .join("\n");
  vscode.window.showInformationMessage("Adapters removed.\n" + detail);
}
