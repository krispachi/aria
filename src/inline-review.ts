import * as vscode from "vscode";
import { actionLocation, ActionLocation } from "./config";
import { ReviewSession, displayPath } from "./session";

interface Model { source: vscode.Uri; content: string; baseline: string; uri: vscode.Uri }

export class InlineReview implements vscode.Disposable {
  private models = new Map<string, Model>();
  private changed = new vscode.EventEmitter<vscode.Uri>();
  private lensesChanged = new vscode.EventEmitter<void>();
  private subscriptions: vscode.Disposable[];
  private restoring = false;
  private swapping = false;
  private acceptFileItem = this.statusButton("$(check) Accept File", "aria.acceptFile", 57);
  private rejectFileItem = this.statusButton("$(discard) Reject File", "aria.rejectFile", 56);
  private acceptAllItem = this.statusButton("$(check-all) Accept All", "aria.acceptAllFiles", 55);
  private rejectAllItem = this.statusButton("$(close-all) Reject All", "aria.rejectAllFiles", 54);
  private badgesChanged = new vscode.EventEmitter<vscode.Uri[] | undefined>();
  constructor(private session: ReviewSession, private refresh: () => void, private autoAdvance: () => boolean = () => true,
    private setting: <T>(key: string, fallback: T) => T = (_key, fallback) => fallback, private onChanged: () => void = () => {}) {
    this.subscriptions = [
      vscode.workspace.registerTextDocumentContentProvider("aria-baseline", {
        onDidChange: this.changed.event,
        provideTextDocumentContent: uri => this.models.get(uri.toString())?.baseline ?? "",
      }),
      vscode.languages.registerCodeLensProvider({ scheme: "file" }, { onDidChangeCodeLenses: this.lensesChanged.event, provideCodeLenses: doc => this.lenses(doc) }),
      vscode.window.registerFileDecorationProvider({
        onDidChangeFileDecorations: this.badgesChanged.event,
        provideFileDecoration: uri => this.setting("showPendingBadge", true) && uri.scheme === "file" && this.session.isActive && this.session.hunks.get(uri.fsPath)?.length ?
          { badge: "M", tooltip: "ARIA: pending Accept/Reject", color: new vscode.ThemeColor("gitDecoration.modifiedResourceForeground") } : undefined,
      }),
      vscode.commands.registerCommand("aria.nextChange", () => this.navigate(1)),
      vscode.commands.registerCommand("aria.previousChange", () => this.navigate(-1)),
      ...[["aria.acceptFile", "opencodeInlineReview.acceptAllInFile"], ["aria.rejectFile", "opencodeInlineReview.rejectAllInFile"], ["aria.acceptAllFiles", "opencodeInlineReview.acceptAll"], ["aria.rejectAllFiles", "opencodeInlineReview.rejectAll"]].map(([command, target]) => vscode.commands.registerCommand(command, async (uri?: vscode.Uri) => {
        const model = this.modelFor(uri ?? vscode.window.activeTextEditor?.document.uri);
        if (!this.session.isActive || (!model && (command === "aria.acceptFile" || command === "aria.rejectFile"))) return;
        const pending = this.session.pendingCount;
        const source = model?.source ?? ([...this.session.hunks.keys()][0] ? vscode.Uri.file([...this.session.hunks.keys()][0]) : undefined);
        await vscode.commands.executeCommand(target, model?.source);
        await this.refreshAll(); this.refresh();
        if (source && this.session.pendingCount < pending) await this.advance(source);
      })),
      vscode.commands.registerCommand("aria.reviewBlock", async (uri: vscode.Uri, content: string, baseline: string, id: string, accept: boolean) => {
        const doc = await vscode.workspace.openTextDocument(uri);
        const line = this.session.hunks.get(uri.fsPath)?.find(h => h.id === id)?.newStart ?? 1;
        let decided = false;
        if (doc.getText() !== content || this.session.baselineOf(uri.fsPath) !== baseline) {
          await vscode.window.showWarningMessage("The file changed. Review the updated changes before accepting or rejecting.");
        } else {
          this.session.refreshFor(uri, content);
          await this.session.decide([uri.fsPath], async () => {
            if (doc.getText() !== content || this.session.baselineOf(uri.fsPath) !== baseline) return;
            if (accept) this.session.acceptHunk(uri, id); else await this.session.rejectHunk(uri, id);
          });
          decided = true;
        }
        this.session.refreshFor(uri, doc.getText()); this.update(doc); this.refresh();
        if (decided) await this.advance(uri, line);
      }),
    ];
  }
  private async navigate(direction: 1 | -1): Promise<void> {
    if (!this.session.isActive) return;
    const editor = vscode.window.activeTextEditor;
    const source = this.modelFor(editor?.document.uri)?.source;
    const targets = [...this.session.hunks.entries()].sort(([a], [b]) => a.localeCompare(b)).flatMap(([file, hunks]) =>
      hunks.map(h => ({ file, line: h.newStart - 1 })));
    if (!targets.length) return;
    const line = editor?.selection.active.line ?? 0;
    const same = targets.filter(target => target.file === source?.fsPath);
    let target = direction === 1 ? same.find(target => target.line > line) : [...same].reverse().find(target => target.line < line);
    if (!target) {
      const files = [...new Set(targets.map(target => target.file))];
      const index = source ? files.indexOf(source.fsPath) : -1;
      const nextFile = index < 0 ? (direction === 1 ? files[0] : files.at(-1)) : files[(index + direction + files.length) % files.length];
      const inFile = targets.filter(target => target.file === nextFile);
      target = direction === 1 ? inFile[0] : inFile.at(-1);
    }
    if (target) await this.open(await vscode.workspace.openTextDocument(vscode.Uri.file(target.file)), target.line);
  }
  private async advance(source: vscode.Uri, line = 1): Promise<void> {
    if (!this.autoAdvance() || !this.session.isActive) return;
    const same = this.session.hunks.get(source.fsPath) ?? [];
    const next = same.find(h => h.newStart >= line) ?? same[0];
    if (next) { await this.open(await vscode.workspace.openTextDocument(source), next.newStart - 1); return; }
    const files = [...this.session.hunks.keys()].sort();
    const file = files.find(file => file > source.fsPath) ?? files[0];
    if (file) await this.open(await vscode.workspace.openTextDocument(vscode.Uri.file(file)), this.session.hunks.get(file)![0].newStart - 1);
  }
  update(doc: vscode.TextDocument): Model {
    const uri = vscode.Uri.from({ scheme: "aria-baseline", path: doc.uri.path, query: encodeURIComponent(doc.uri.fsPath) });
    const model = { uri, source: doc.uri, content: doc.getText(), baseline: this.session.hunks.get(doc.uri.fsPath)?.length ? this.session.baselineOf(doc.uri.fsPath) : doc.getText() };
    const previous = this.models.get(uri.toString());
    this.models.set(uri.toString(), model);
    this.badgesChanged.fire([doc.uri]);
    if (!previous || previous.baseline !== model.baseline) this.changed.fire(uri);
    this.lensesChanged.fire(); this.syncContext();
    this.onChanged();
    return model;
  }
  private modelFor(uri?: vscode.Uri): Model | undefined {
    if (!uri) return;
    return this.models.get(uri.toString()) ?? [...this.models.values()].find(model => model.source.toString() === uri.toString());
  }
  syncContext(): void {
    const model = this.modelFor(vscode.window.activeTextEditor?.document.uri);
    const fileHunks = model && this.session.isActive ? this.session.hunks.get(model.source.fsPath)?.length ?? 0 : 0;
    void vscode.commands.executeCommand("setContext", "aria.reviewPending", fileHunks > 0);
    const file = actionLocation("file"), all = actionLocation("all");
    const inToolbar = (location: ActionLocation) => location === "editorToolbar" || location === "both";
    const inStatusBar = (location: ActionLocation) => location === "statusBar" || location === "both";
    void vscode.commands.executeCommand("setContext", "aria.fileActionsInToolbar", inToolbar(file));
    void vscode.commands.executeCommand("setContext", "aria.allActionsInToolbar", inToolbar(all));
    const name = model ? displayPath(model.source.fsPath) : "";
    this.acceptFileItem.tooltip = `ARIA: accept ${fileHunks} change(s) in ${name}`;
    this.rejectFileItem.tooltip = `ARIA: reject ${fileHunks} change(s) in ${name}`;
    const total = this.session.isActive ? this.session.pendingCount : 0, files = this.session.pendingFiles;
    this.acceptAllItem.tooltip = `ARIA: accept ${total} change(s) in ${files} file(s)`;
    this.rejectAllItem.tooltip = `ARIA: reject ${total} change(s) in ${files} file(s)`;
    for (const item of [this.acceptFileItem, this.rejectFileItem]) inStatusBar(file) && fileHunks > 0 ? item.show() : item.hide();
    for (const item of [this.acceptAllItem, this.rejectAllItem]) inStatusBar(all) && total > 0 ? item.show() : item.hide();
  }
  private statusButton(text: string, command: string, priority: number): vscode.StatusBarItem {
    const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, priority);
    item.text = text; item.command = command;
    return item;
  }
  async open(doc: vscode.TextDocument, sourceLine = 0, preserveFocus = false): Promise<void> {
    const model = this.update(doc);
    const groups = vscode.window.tabGroups.all;
    const sourceTabs = groups.flatMap(group => group.tabs.filter(tab => tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === doc.uri.toString()).map(tab => ({ tab, column: group.viewColumn })));
    const existing = groups.find(group => group.tabs.some(tab => tab.input instanceof vscode.TabInputTextDiff && tab.input.modified.toString() === doc.uri.toString() && tab.input.original.toString() === model.uri.toString()));
    const position = doc.validatePosition(new vscode.Position(sourceLine, 0));
    await vscode.commands.executeCommand("vscode.diff", model.uri, doc.uri, displayPath(doc.uri.fsPath), {
      viewColumn: existing?.viewColumn ?? sourceTabs[0]?.column ?? vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One,
      preview: false, preserveFocus, selection: new vscode.Range(position, position),
    });
    // The modified editor uses the exact source document; closing its plain tab does not discard the shared buffer.
    if (sourceTabs.length) await vscode.window.tabGroups.close(sourceTabs.map(item => item.tab), true);
    const editor = vscode.window.visibleTextEditors.find(editor => editor.document.uri.toString() === doc.uri.toString());
    if (this.setting("autoUnfold", true) && !preserveFocus) {
      await vscode.commands.executeCommand("editor.unfold", { selectionLines: [position.line], levels: 99 });
    }
    editor?.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
    this.syncContext();
    this.onChanged();
  }
  render(editor: vscode.TextEditor): void {
    // Once a review is resolved, a later unreported edit must not inherit the
    // old diff or controls (it may belong to an agent the user has disabled).
    if (editor.document.uri.scheme === "file" && this.modelFor(editor.document.uri) && !this.session.shouldReview(editor.document.uri.fsPath)) this.update(editor.document);
    this.syncContext();
    void this.restorePlainEditors();
    void this.restore(editor).catch(error => vscode.window.showErrorMessage(`ARIA could not reopen review: ${String(error)}`));
  }
  async restore(editor: vscode.TextEditor): Promise<void> {
    if (!this.setting("restoreOnReopen", true) || this.restoring || !this.session.isActive || editor.document.uri.scheme !== "file" || !this.session.shouldReview(editor.document.uri.fsPath)) return;
    const h = this.session.hunks.get(editor.document.uri.fsPath)?.[0];
    if (!h) return;
    const active = vscode.window.tabGroups.activeTabGroup.activeTab;
    // A reopened plain source needs its snapshot diff restored; an existing diff is left alone.
    if (!(active?.input instanceof vscode.TabInputText) || active.input.uri.toString() !== editor.document.uri.toString()) return;
    this.restoring = true;
    try { await this.open(editor.document, h.newStart - 1); }
    finally { this.restoring = false; }
  }
  private lenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    if (!this.setting("showBlockActions", true) || !this.session.isActive || !this.session.shouldReview(doc.uri.fsPath)) return [];
    return (this.session.hunks.get(doc.uri.fsPath) ?? []).flatMap(h => [true, false].map(accept => new vscode.CodeLens(
      this.actionRange(doc, h.newStart - 1, h.oldLines.length > 0),
      { title: accept ? "✓ Accept" : "✕ Reject", command: "aria.reviewBlock", arguments: [doc.uri, doc.getText(), this.session.baselineOf(doc.uri.fsPath), h.id, accept] }
    )));
  }
  private actionRange(doc: vscode.TextDocument, start: number, removed: boolean): vscode.Range {
    // Native CodeLens renders directly above its source row and always below a
    // deleted-row view zone at that row, so it cannot sit directly above red rows.
    // "beforeGroup" anchors to the preceding unchanged row (actions, one context
    // row, red, green); "firstChangedRow" keeps actions next to the change (red,
    // actions, green). Added-only groups are directly above green either way.
    // Hunks come from the editor's own diff algorithm, so rows match the diff.
    const before = removed && start > 0 && this.setting<string>("blockActionsAnchor", "beforeGroup") === "beforeGroup";
    const line = doc.validatePosition(new vscode.Position(before ? start - 1 : start, 0)).line;
    return new vscode.Range(line, 0, line, 0);
  }
  async refreshAll(): Promise<void> {
    // Explorer caches decorations independently of editor models. Closed files
    // still need invalidation after decisions, Undo and directory/session changes.
    this.badgesChanged.fire(undefined);
    for (const model of [...this.models.values()]) {
      const doc = await vscode.workspace.openTextDocument(model.source);
      if (!this.session.isActive) return;
      if (this.session.shouldReview(doc.uri.fsPath)) this.session.refreshFor(doc.uri, doc.getText());
      this.update(doc);
    }
    await this.restorePlainEditors();
  }
  async restorePlainEditors(): Promise<void> {
    // A resolved file goes back to a normal editor: the snapshot diff keeps a
    // second line-number column and diff chrome even without differences.
    // Background diff tabs are swapped when they become visible.
    if (this.swapping || this.session.isDeciding) return;
    this.swapping = true;
    try {
      const isResolvedDiff = (tab: vscode.Tab, original?: vscode.Uri): tab is vscode.Tab & { input: vscode.TabInputTextDiff } =>
        tab.input instanceof vscode.TabInputTextDiff && tab.input.original.scheme === "aria-baseline" && tab.input.modified.scheme === "file" &&
        (!original || tab.input.original.toString() === original.toString()) &&
        !(this.session.isActive && this.session.hunks.get(tab.input.modified.fsPath)?.length);
      const targets = vscode.window.tabGroups.all.flatMap(group => group.tabs.filter(tab => tab.isActive && isResolvedDiff(tab))
        .map(tab => ({ column: group.viewColumn, focused: group.isActive, original: (tab.input as vscode.TabInputTextDiff).original, source: (tab.input as vscode.TabInputTextDiff).modified })));
      for (const target of targets) {
        const doc = await vscode.workspace.openTextDocument(target.source);
        const previous = vscode.window.visibleTextEditors.find(editor => editor.document === doc && (editor.viewColumn === undefined || editor.viewColumn === target.column));
        const top = previous?.visibleRanges[0]?.start;
        // Open the plain editor first so the shared (possibly dirty) buffer stays open.
        const editor = await vscode.window.showTextDocument(doc, { viewColumn: target.column, preview: false, preserveFocus: !target.focused, selection: previous?.selection });
        if (top) editor.revealRange(new vscode.Range(top, top), vscode.TextEditorRevealType.AtTop);
        const stale = vscode.window.tabGroups.all.find(group => group.viewColumn === target.column)?.tabs.filter(tab => isResolvedDiff(tab, target.original));
        if (stale?.length) await vscode.window.tabGroups.close(stale, true);
      }
    } finally { this.swapping = false; }
    this.syncContext();
  }
  releaseClosed(): void {
    const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs);
    for (const [key, model] of this.models) if (!tabs.some(tab =>
      (tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === model.source.toString()) ||
      (tab.input instanceof vscode.TabInputTextDiff && tab.input.original.toString() === model.uri.toString())
    )) this.models.delete(key);
  }
  clear(): void {
    this.badgesChanged.fire(undefined);
    for (const model of this.models.values()) { model.baseline = model.content; this.changed.fire(model.uri); this.badgesChanged.fire([model.source]); }
    this.lensesChanged.fire(); this.syncContext();
    if (!this.session.isActive) void this.restorePlainEditors();
    this.onChanged();
  }
  dispose(): void { this.subscriptions.forEach(item => item.dispose()); this.changed.dispose(); this.lensesChanged.dispose(); this.badgesChanged.dispose(); }
}
