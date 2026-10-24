import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { computeHunks, Hunk, normalize } from "./diff";
import { resolveEventsFile } from "./store";
import { reviewSetting } from "./config";
import { lineHunk } from "./review";

export type TrackMode = "agent" | "all";
export interface ReviewFileState { file: string; baseline: string; content: string }
export interface ReviewDecision { before: ReviewFileState[]; after: ReviewFileState[]; disk: Array<{ file: string; content: string | null }> }
export interface SavedReview { version: 1; savedAt: number; files: ReviewFileState[]; undo: ReviewDecision[] }

export class ReviewSession {
  private active = false;
  private baseline = new Map<string, string>();
  private currentContent = new Map<string, string>();
  private computed = new Map<string, { baseline: string; content: string; hunks: Hunk[] }>();
  private snapshotSkipped = new Set<string>();
  private snapshotIncomplete = false;
  private internalEdits = 0;
  private agentBuffers = new Map<string, string>();
  private manualBuffers = new Set<string>();
  noteAgentBuffer(doc: vscode.TextDocument, replacement = false): void {
    const key = this.fileKey(doc.uri.fsPath);
    if (!doc.isDirty || replacement) { this.manualBuffers.delete(key); this.agentBuffers.set(key, doc.getText()); }
    else if (this.agentBuffers.get(key) !== doc.getText()) this.manualBuffers.add(key);
  }
  private hasOpenTab(uri: vscode.Uri): boolean {
    return vscode.window.tabGroups.all.some(group => group.tabs.some(tab =>
      (tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === uri.toString()) ||
      (tab.input instanceof vscode.TabInputTextDiff && tab.input.modified.toString() === uri.toString())));
  }
  private async reloadUnchangedBuffer(doc: vscode.TextDocument, expected: string, requireOpen = false): Promise<void> {
    const key = this.fileKey(doc.uri.fsPath);
    const valid = () => this.active && this.allowedFile(doc.uri.fsPath) && !this.manualBuffers.has(key) && doc.getText() === expected;
    if (!valid() || await this.readDisk(doc.uri.fsPath) !== expected || !valid()) throw new Error("The file changed on disk or has manual edits. Review its latest content before saving.");
    // Revert File acts on the active editor, not on a URI argument. Focus the
    // precise source/diff first so an Explorer multi-selection cannot be reverted.
    const groups = vscode.window.tabGroups.all;
    const selection = vscode.window.visibleTextEditors.find(editor => editor.document.uri.toString() === doc.uri.toString())?.selection;
    const group = groups.find(group => group.tabs.some(tab => tab.input instanceof vscode.TabInputTextDiff && tab.input.modified.toString() === doc.uri.toString()));
    const diff = group?.tabs.find(tab => tab.input instanceof vscode.TabInputTextDiff && tab.input.modified.toString() === doc.uri.toString())?.input;
    if (requireOpen && !this.hasOpenTab(doc.uri)) return;
    if (diff instanceof vscode.TabInputTextDiff) {
      await vscode.commands.executeCommand("vscode.diff", diff.original, doc.uri, displayPath(doc.uri.fsPath), { viewColumn: group!.viewColumn, selection, preview: false, preserveFocus: false });
    } else {
      await vscode.window.showTextDocument(doc, { selection, preview: true, preserveFocus: false });
    }
    if (await this.readDisk(doc.uri.fsPath) !== expected || !valid()) throw new Error("The file changed while preparing to save. Review its latest content first.");
    await vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup");
    // Do not await filesystem work between focusing and Revert: that could let
    // an Explorer selection regain focus and change the command's target.
    if (!valid() || vscode.window.activeTextEditor?.document.uri.toString() !== doc.uri.toString()) throw new Error("The file changed while preparing to save. Review its latest content first.");
    await this.internally(() => vscode.commands.executeCommand("workbench.action.files.revert"));
    if (!valid() || doc.isDirty || await this.readDisk(doc.uri.fsPath) !== expected || !valid()) throw new Error("Could not synchronize the editor with the current disk version. Your file was not overwritten.");
  }
  private async saveResolved(files: string[]): Promise<void> {
    if (!reviewSetting("autoSaveResolved", true)) return;
    for (const file of new Set(files)) {
      const key = this.fileKey(file);
      const uri = vscode.Uri.file(file);
      if (!this.hasOpenTab(uri) || await this.dropMissingFile(file)) continue;
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      if (!this.active || !this.allowedFile(file) || this.agentBuffers.get(key) !== doc.getText() || computeHunks(this.baselineOf(file), doc.getText()).length) continue;
      if (doc.isDirty && !this.manualBuffers.has(key)) {
        try {
          // Acceptance already exists on disk. Reloading clears ARIA's artificial
          // dirty marker and refreshes the native save version without a write.
          await this.reloadUnchangedBuffer(doc, doc.getText(), true);
        } catch (error) {
          void vscode.window.showWarningMessage(`ARIA: review completed, but automatic save was skipped. ${String(error)}`);
        }
      }
    }
  }
  async dropMissingFile(file: string): Promise<boolean> {
    try { await fs.stat(file); return false; }
    catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      const key = this.fileKey(file);
      this.hunks.delete(path.normalize(file));
      this.touched.delete(key);
      this.currentContent.delete(path.normalize(file));
      this.computed.delete(path.normalize(file));
      this.agentBuffers.delete(key);
      return true;
    }
  }
  private touched = new Set<string>();
  private proposals = new Map<string, string>();
  private watcher: import("node:fs").FSWatcher | null = null;
  private eventsFile = "";
  private readOffset = 0;
  private ingesting = false;
  private scanning = false;
  private globalEvents = true;
  private extraOffsets = new Map<string, number>();
  private sessionStartedAt = 0;
  private generation = 0;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  mode: TrackMode = "agent";
  private history: ReviewDecision[] = [];
  private deciding = false;
  private decisionDone: Promise<void> = Promise.resolve();
  get canUndo(): boolean { return this.history.length > 0; }
  get isDeciding(): boolean { return this.deciding; }
  clearHistory(): void { this.history = []; }

  exportReview(): SavedReview {
    const eligible = (item: ReviewFileState) => this.allowedFile(item.file) && Buffer.byteLength(item.content) <= reviewSetting("maxFileSizeKb", 1024) * 1024 && Buffer.byteLength(item.baseline) <= reviewSetting("maxFileSizeKb", 1024) * 1024;
    return { version: 1, savedAt: Date.now(), files: [...this.hunks.keys()].map(file => ({ file, baseline: this.baselineOf(file), content: this.currentContent.get(file) ?? "" })).filter(eligible),
      undo: this.history.filter(entry => [...entry.before, ...entry.after].every(eligible)).map(entry => ({ before: entry.before.map(item => ({ ...item })), after: entry.after.map(item => ({ ...item })), disk: entry.disk.map(item => ({ ...item })) })) };
  }
  async restoreReview(saved: SavedReview): Promise<string[]> {
    const conflicts: string[] = [];
    for (const item of saved.files) {
      if (!this.allowedFile(item.file) || this.snapshotSkipped.has(this.fileKey(item.file))) continue;
      try {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(item.file));
        if (doc.getText() !== item.content) { conflicts.push(item.file); continue; }
        this.baseline.set(this.fileKey(item.file), item.baseline);
        this.markTouched(item.file);
        this.refreshFor(doc.uri, doc.getText());
        this.noteAgentBuffer(doc, doc.getText() === await this.readDisk(item.file));
      } catch { conflicts.push(item.file); }
    }
    // Only retain history whose targets are still eligible; undo checks content again at execution.
    const limit = reviewSetting("undoLimit", 20);
    this.history = limit > 0 ? saved.undo.filter(entry => entry.before.every(item => this.allowedFile(item.file))).slice(-limit) : [];
    return conflicts;
  }
  async decide<T>(files: string[], operation: () => PromiseLike<T> | T): Promise<T> {
    if (this.deciding) { await this.decisionDone; return this.decide(files, operation); }
    this.deciding = true;
    let finish!: () => void;
    this.decisionDone = new Promise(resolve => { finish = resolve; });
    const capture = async (): Promise<ReviewFileState[]> => Promise.all([...new Set(files)].map(async file => ({ file, baseline: this.baselineOf(file), content: (await vscode.workspace.openTextDocument(vscode.Uri.file(file))).getText() })));
    try {
      for (const file of new Set(files)) if (await this.dropMissingFile(file)) files = files.filter(item => item !== file);
      if (reviewSetting<number>("undoLimit", 20) === 0) { const result = await operation(); await this.saveResolved(files); return result; }
      const before = await capture();
      try { const result = await operation(); await this.saveResolved(files); return result; }
      finally {
        const after = await capture();
        const changed = before.map((item, i) => item.baseline !== after[i].baseline || item.content !== after[i].content ? i : -1).filter(i => i >= 0);
        if (changed.length) {
          const actualAfter = changed.map(i => after[i]);
          const disk = await Promise.all(actualAfter.map(async item => ({ file: item.file, content: await this.readDisk(item.file) })));
          this.history.push({ before: changed.map(i => before[i]), after: actualAfter, disk });
          const limit = reviewSetting("undoLimit", 20);
          this.history = limit > 0 ? this.history.slice(-limit) : [];
        }
      }
    } finally { this.deciding = false; finish(); }
  }
  async undoDecision(): Promise<boolean> {
    const entry = this.history.at(-1);
    if (!entry || !this.active || this.deciding) return false;
    this.deciding = true;
    let finish!: () => void;
    this.decisionDone = new Promise(resolve => { finish = resolve; });
    try {
      const docs = await Promise.all(entry.after.map(item => vscode.workspace.openTextDocument(vscode.Uri.file(item.file))));
      for (let i = 0; i < entry.after.length; i++) {
        const item = entry.after[i];
        const size = await fs.stat(item.file).then(stat => stat.size).catch(() => 0);
        const disk = await this.readDisk(item.file);
        if (size > reviewSetting("maxFileSizeKb", 1024) * 1024 || !this.allowedFile(item.file) || docs[i].getText() !== item.content || this.baselineOf(item.file) !== item.baseline || disk !== entry.disk[i].content) {
          void vscode.window.showWarningMessage("ARIA cannot undo this decision because the file changed afterward. Your later edits were preserved.");
          return false;
        }
      }
      const edit = new vscode.WorkspaceEdit();
      if (docs.some((doc, i) => doc.getText() !== entry.after[i].content || this.baselineOf(entry.after[i].file) !== entry.after[i].baseline)) return false;
      for (let i = 0; i < docs.length; i++) if (docs[i].getText() !== entry.before[i].content) {
        const doc = docs[i];
        edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), entry.before[i].content);
      }
      if (docs.some((doc, i) => doc.getText() !== entry.before[i].content) && !await this.internally(() => vscode.workspace.applyEdit(edit))) return false;
      for (const item of entry.before) {
        this.baseline.set(this.fileKey(item.file), item.baseline);
        this.markTouched(item.file);
        this.refreshFor(vscode.Uri.file(item.file), item.content);
      }
      this.history.pop();
      // Undo of rejection restores the editor buffer; Save remains the user's decision.
      return true;
    } finally { this.deciding = false; finish(); }
  }
  private async readDisk(file: string): Promise<string | null> {
    try {
      if ((await fs.stat(file)).size > reviewSetting("maxFileSizeKb", 1024) * 1024) return null;
      return await fs.readFile(file, "utf8");
    } catch { return null; }
  }

  readonly hunks = new Map<string, Hunk[]>();

  constructor(private readonly onAgentFiles?: (files: string[]) => Promise<void>, private readonly allowedFile: (file: string) => boolean = () => true,
    private readonly report: (message: string) => void = () => {}, private readonly allowedAgent: (agent?: string) => boolean = () => true) {}

  get isActive(): boolean {
    return this.active;
  }
  get isApplying(): boolean { return this.internalEdits > 0; }
  async internally<T>(operation: () => PromiseLike<T>): Promise<T> {
    this.internalEdits++;
    try { return await operation(); } finally { this.internalEdits--; }
  }

  observeManual(uri: vscode.Uri, content: string): void {
    const file = path.normalize(uri.fsPath);
    if (!this.active || !this.allowedFile(file) || this.isApplying) return;
    this.agentBuffers.delete(this.fileKey(file));
    this.manualBuffers.add(this.fileKey(file));
    const previous = this.currentContent.get(file) ?? this.baselineOf(file);
    const pending = this.hunks.get(file) ?? [];
    if (!pending.length) { this.acceptFile(uri, content); this.touched.delete(this.fileKey(file)); return; }
    const manual = computeHunks(previous, content);
    const lines = normalize(this.baselineOf(file)).split("\n");
    const baseline = this.baselineOf(file);
    if (baseline.endsWith("\n")) lines.pop();
    if (!baseline) lines.length = 0;
    let trailing = baseline.endsWith("\n");
    const mapLine = (line: number): number => {
      let delta = 0;
      for (const h of pending) if (h.newStart - 1 + h.newLines.length <= line) delta += h.oldLines.length - h.newLines.length;
      return line + delta;
    };
    for (const edit of manual.reverse()) {
      const start = edit.oldStart - 1, end = start + edit.oldLines.length;
      const overlaps = pending.some(h => {
        const a = h.newStart - 1, b = a + h.newLines.length;
        return start === end ? start > a && start < b : a === b ? a > start && a < end : start < b && end > a;
      });
      if (overlaps) continue; // Edits within a pending AI block remain part of that proposal.
      const oldStart = mapLine(start), oldEnd = mapLine(end);
      if (oldEnd >= lines.length) trailing = content.endsWith("\n");
      lines.splice(oldStart, oldEnd - oldStart, ...edit.newLines);
    }
    const eol = baseline.includes("\r\n") || content.includes("\r\n") ? "\r\n" : "\n";
    this.baseline.set(this.fileKey(file), lines.join(eol) + (lines.length && trailing ? eol : ""));
    this.refreshFor(uri, content);
  }

  get eventsPath(): string {
    return this.eventsFile;
  }

  get pendingCount(): number {
    let n = 0;
    for (const list of this.hunks.values()) {
      n += list.length;
    }
    return n;
  }

  get pendingFiles(): number {
    return this.hunks.size;
  }

  get touchedCount(): number {
    return this.touched.size;
  }

  get trackAll(): boolean {
    return this.mode === "all";
  }

  isTouched(filePath: string): boolean {
    return this.touched.has(this.fileKey(filePath));
  }

  shouldReview(filePath: string): boolean {
    if (!this.active) {
      return false;
    }
    if (!this.allowedFile(filePath) || this.snapshotSkipped.has(this.fileKey(filePath)) || (this.snapshotIncomplete && !this.baseline.has(this.fileKey(filePath)))) return false;
    if (this.mode === "all") {
      return true;
    }
    return this.isTouched(filePath);
  }

  async start(mode: TrackMode): Promise<void> {
    this.stop();
    const generation = this.generation;
    this.sessionStartedAt = Date.now();
    this.mode = mode;
    // Record event offsets before the (possibly slow) snapshot: an agent edit
    // made while files are being read is then still ingested and reviewed.
    this.captureOffsets();
    const baseline = await this.snapshotWorkspace();
    if (generation !== this.generation) return;
    this.baseline = baseline;
    this.active = true;
    this.touched.clear();
    this.hunks.clear();
    this.proposals.clear();
    this.startWatching();
  }

  stop(): void {
    this.generation++;
    this.active = false;
    this.baseline.clear();
    this.currentContent.clear();
    this.computed.clear();
    this.snapshotSkipped.clear();
    this.snapshotIncomplete = false;
    this.agentBuffers.clear();
    this.manualBuffers.clear();
    this.touched.clear();
    this.hunks.clear();
    this.proposals.clear();
    this.history = [];
    this.stopWatching();
    this.readOffset = 0;
    this.extraOffsets.clear();
  }

  async syncDirectories(): Promise<void> {
    const generation = this.generation;
    const snapshot = await this.snapshotWorkspace();
    if (!this.active || generation !== this.generation) return;
    for (const key of [...this.baseline.keys()]) if (!this.allowedFile(key) || this.snapshotSkipped.has(key)) this.baseline.delete(key);
    for (const [key, text] of snapshot) if (!this.baseline.has(key)) this.baseline.set(key, text);
    for (const collection of [this.hunks, this.currentContent, this.computed]) for (const key of [...collection.keys()]) if (!this.allowedFile(key) || this.snapshotSkipped.has(this.fileKey(key))) collection.delete(key);
    for (const key of [...this.touched]) if (!this.allowedFile(key) || this.snapshotSkipped.has(key)) this.touched.delete(key);
  }

  markTouched(filePath: string): void {
    if (this.active) {
      this.touched.add(this.fileKey(filePath));
    }
  }

  baselineOf(filePath: string): string {
    return this.baseline.get(this.fileKey(filePath)) ?? "";
  }

  private fileKey(filePath: string): string {
    const normalized = path.normalize(filePath);
    return path.sep === "\\" ? normalized.toLowerCase() : normalized;
  }

  refreshFor(uri: vscode.Uri, content: string): Hunk[] {
    const filePath = path.normalize(uri.fsPath);
    if (!this.active || !this.allowedFile(filePath) || this.snapshotSkipped.has(this.fileKey(filePath)) || (this.snapshotIncomplete && !this.baseline.has(this.fileKey(filePath))) || content.includes("\0") || Buffer.byteLength(content) > reviewSetting("maxFileSizeKb", 1024) * 1024) {
      this.hunks.delete(filePath);
      this.computed.delete(filePath);
      return [];
    }
    const oldText = this.baselineOf(filePath);
    this.currentContent.set(filePath, content);
    const previous = this.computed.get(filePath);
    const hunks = previous?.baseline === oldText && previous.content === content ? previous.hunks : computeHunks(oldText, content);
    this.computed.set(filePath, { baseline: oldText, content, hunks });
    if (hunks.length) this.hunks.set(filePath, hunks);
    else this.hunks.delete(filePath);
    return hunks;
  }

  acceptHunk(uri: vscode.Uri, id: string, index?: number): void {
    const filePath = path.normalize(uri.fsPath);
    const whole = this.hunks.get(filePath)?.find((h) => h.id === id);
    const hunk = whole && (index === undefined ? whole : lineHunk(whole, index));
    if (!hunk) return;
    const baseline = this.baselineOf(filePath);
    const current = this.currentContent.get(filePath) ?? "";
    const eol = baseline.includes("\r\n") || (!baseline && current.includes("\r\n")) ? "\r\n" : "\n";
    const lines = normalize(baseline).split("\n");
    if (baseline.endsWith("\n")) lines.pop();
    if (!baseline) lines.length = 0;
    const currentLines = normalize(current).split("\n").length - (current.endsWith("\n") ? 1 : 0);
    const affectsEOF = hunk.oldStart - 1 + hunk.oldLines.length >= lines.length && hunk.newStart - 1 + hunk.newLines.length >= currentLines;
    lines.splice(hunk.oldStart - 1, hunk.oldLines.length, ...hunk.newLines);
    const suffix = lines.length && (affectsEOF ? current.endsWith("\n") : baseline.endsWith("\n")) ? eol : "";
    this.baseline.set(this.fileKey(filePath), lines.join(eol) + suffix);
    if (!this.refreshFor(uri, current).length) this.touched.delete(this.fileKey(filePath));
  }

  acceptFile(uri: vscode.Uri, content: string): void {
    const filePath = path.normalize(uri.fsPath);
    this.baseline.set(this.fileKey(filePath), content);
    this.currentContent.set(filePath, content);
    this.hunks.delete(filePath);
    this.touched.delete(this.fileKey(filePath));
  }

  async rejectHunk(uri: vscode.Uri, id: string, index?: number): Promise<void> {
    const filePath = path.normalize(uri.fsPath);
    const hunks = this.hunks.get(filePath) ?? [];
    const whole = hunks.find((h) => h.id === id);
    const hunk = whole && (index === undefined ? whole : lineHunk(whole, index));
    if (!hunk) {
      return;
    }
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      await this.applyReject(doc, hunk);
    } catch (err) {
      vscode.window.showErrorMessage(
        "Reject failed: " + (err instanceof Error ? err.message : String(err))
      );
    }
  }

  async rejectAllInFile(uri: vscode.Uri): Promise<void> {
    if (await this.dropMissingFile(uri.fsPath)) return;
    const filePath = path.normalize(uri.fsPath);
    const hunks = [...(this.hunks.get(filePath) ?? [])];
    const doc = await vscode.workspace.openTextDocument(uri);
    for (let i = hunks.length - 1; i >= 0; i--) {
      await this.applyReject(doc, hunks[i]);
    }
  }

  async rejectAll(): Promise<void> {
    const targets = [...this.hunks.keys()];
    for (const filePath of targets) {
      await this.rejectAllInFile(vscode.Uri.file(filePath));
    }
  }

  proposalContent(filePath: string): string | undefined {
    return this.proposals.get(path.normalize(filePath));
  }

  setProposal(filePath: string, content: string): void {
    this.proposals.set(path.normalize(filePath), content);
  }

  deleteProposal(filePath: string): void {
    this.proposals.delete(path.normalize(filePath));
  }

  private async applyReject(doc: vscode.TextDocument, hunk: Hunk): Promise<void> {
    const key = this.fileKey(doc.uri.fsPath);
    const before = doc.getText();
    const version = doc.version;
    const manual = this.manualBuffers.has(key);
    if (!manual) {
      // A WorkspaceEdit that imports an external agent write does not update the
      // text-file model's disk etag. Refresh it before applying/saving rejection.
      if (doc.isDirty) await this.reloadUnchangedBuffer(doc, before);
      else if (await this.readDisk(doc.uri.fsPath) !== before || doc.getText() !== before || doc.version !== version) throw new Error("The file changed on disk. Review the latest agent edit before rejecting.");
    }
    const eol = doc.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
    const added = hunk.newLines.length;
    const start = doc.validatePosition(new vscode.Position(hunk.newStart - 1, 0));
    const end = added > 0 ? doc.validatePosition(new vscode.Position(hunk.newStart - 1 + added, 0)) : start;
    const baseline = normalize(this.baselineOf(doc.uri.fsPath));
    const oldEnd = hunk.oldStart - 1 + hunk.oldLines.length;
    const baselineLines = baseline.split("\n").length - (baseline.endsWith("\n") ? 1 : 0);
    const suffix = oldEnd < baselineLines || baseline.endsWith("\n") ? eol : "";
    const prefix = hunk.newStart - 1 >= doc.lineCount && doc.getText() && !doc.getText().endsWith("\n") ? eol : "";
    const text = hunk.oldLines.length === 0 ? "" : prefix + hunk.oldLines.join(eol) + suffix;
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, new vscode.Range(start, end), text);
    await this.internally(async () => {
      if (!(await vscode.workspace.applyEdit(edit))) throw new Error("Could not apply rejection.");
      if (!manual && !this.manualBuffers.has(key)) {
        try {
          if (!(await doc.save())) throw new Error("Could not save rejection.");
          if (this.agentBuffers.get(key) === before) this.agentBuffers.set(key, doc.getText());
        } catch (error) {
          this.agentBuffers.delete(key); this.manualBuffers.add(key);
          void vscode.window.showWarningMessage(`ARIA: Reject was applied in the editor but could not be saved. The rejected result remains unsaved; compare it with the disk version before saving. ${String(error)}`);
        }
      }
    });
    if (!this.refreshFor(doc.uri, doc.getText()).length) this.touched.delete(key);
  }

  private async snapshotWorkspace(): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    const generation = this.generation;
    const skipped = new Set<string>();
    const started = Date.now();
    const counts = { binary: 0, size: 0, budget: 0, read: 0 };
    const details: string[] = [];
    const skip = (file: string, reason: keyof typeof counts, detail = "") => {
      skipped.add(this.fileKey(file)); counts[reason]++;
      if (details.length < 20) details.push(`Snapshot skipped (${reason}): ${displayPath(file)}${detail ? " - " + detail : ""}`);
    };
    const excludes =
      "**/{node_modules,.git,dist,build,builds,.next,out,target,coverage,__pycache__,.venv,venv,.opencode,.agent-review}/**";
    const files = await vscode.workspace.findFiles("**/*", excludes, 20000);
    const budget = reviewSetting("maxSnapshotSizeMb", 64) * 1024 * 1024;
    const maxFile = reviewSetting("maxFileSizeKb", 1024) * 1024;
    let reserved = 0;
    let index = 0;
    await Promise.all(Array.from({ length: Math.min(8, files.length) }, async () => {
      while (index < files.length && generation === this.generation) {
        const uri = files[index++];
        if (!this.allowedFile(uri.fsPath)) continue;
        let size = 0;
        try {
          size = (await fs.stat(uri.fsPath)).size;
          if (size > maxFile) { skip(uri.fsPath, "size"); continue; }
          if (reserved + size > budget) { skip(uri.fsPath, "budget"); continue; }
          reserved += size;
          const text = await fs.readFile(uri.fsPath, "utf8");
          const actual = Buffer.byteLength(text);
          const reason = text.includes("\0") ? "binary" : actual > maxFile ? "size" : reserved - size + actual > budget ? "budget" : undefined;
          if (reason) { reserved -= size; size = 0; skip(uri.fsPath, reason); continue; }
          reserved += actual - size;
          map.set(this.fileKey(uri.fsPath), text);
        } catch (error) {
          reserved -= size;
          skip(uri.fsPath, "read", String(error));
          // tidak terbaca - abaikan
        }
      }
    }));
    if (generation === this.generation) {
      this.snapshotSkipped = skipped;
      this.snapshotIncomplete = files.length >= 20000;
      this.report(`ARIA snapshot: ${map.size} text file(s), ${Date.now() - started} ms. Skipped: binary=${counts.binary}, size=${counts.size}, budget=${counts.budget}, read=${counts.read}.`);
      details.forEach(detail => this.report(detail));
      if (skipped.size > details.length) this.report(`${skipped.size - details.length} additional skipped files omitted from the log.`);
      const warnings = [
        ...(counts.budget ? [`${counts.budget} file(s) exceeded the snapshot memory budget`] : []),
        ...(counts.read ? [`${counts.read} file(s) could not be read`] : []),
        ...(this.snapshotIncomplete ? ["the 20,000-file scan limit was reached"] : []),
      ];
      if (warnings.length) void vscode.window.showWarningMessage(`ARIA: ${warnings.join("; ")}. Affected files are not reviewed in this session. See Output > ARIA Review for details.`);
    }
    return map;
  }

  private captureOffsets(): void {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      return;
    }
    const override = reviewSetting("eventsFile", "");
    this.globalEvents = !override.trim();
    this.eventsFile = resolveEventsFile(root, override);
    const dir = path.dirname(this.eventsFile);
    const base = path.basename(this.eventsFile);
    this.readOffset = 0;

    try {
      this.readOffset = require("node:fs").statSync(this.eventsFile).size;
    } catch {}
    this.extraOffsets.clear();
    if (this.globalEvents) {
      try {
        for (const file of require("node:fs").readdirSync(dir) as string[]) {
          if (file.endsWith(".jsonl") && file !== base) {
            const source = path.join(dir, file);
            this.extraOffsets.set(source, require("node:fs").statSync(source).size);
          }
        }
      } catch {}
    }
  }

  private startWatching(): void {
    if (!vscode.workspace.workspaceFolders?.[0] || !this.eventsFile) {
      return;
    }
    const dir = path.dirname(this.eventsFile);
    const base = path.basename(this.eventsFile);

    try {
      require("node:fs").mkdirSync(dir, { recursive: true });
    } catch {
      // abaikan
    }

    try {
      const watcher = require("node:fs").watch(
        dir,
        (_ev: any, filename: any) => {
          const name = filename?.toString() ?? "";
          if (name === base || name.endsWith(".jsonl")) {
            void this.ingestAllEvents();
          }
        }
      ) as import("node:fs").FSWatcher;
      this.watcher = watcher;
      watcher.on("error", () => {
        /* abaikan */
      });
    } catch {
      this.watcher = null;
    }

    // fallback polling agar tetap bekerja walau fs.watch bermasalah
    this.pollTimer = setInterval(() => {
      void this.ingestAllEvents();
    }, 3000);
  }

  private stopWatching(): void {
    try {
      this.watcher?.close();
    } catch {
      // abaikan
    }
    this.watcher = null;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async ingestAllEvents(): Promise<void> {
    if (!this.active || this.scanning) return;
    this.scanning = true;
    try {
      await this.ingestEvents();
      if (this.globalEvents) {
        const dir = path.dirname(this.eventsFile);
        for (const name of await fs.readdir(dir)) {
          const source = path.join(dir, name);
          if (name.endsWith(".jsonl") && source !== this.eventsFile) await this.ingestEvents(source);
        }
      }
    } catch {} finally {
      this.scanning = false;
    }
  }

  private async ingestEvents(source = this.eventsFile): Promise<void> {
    if (!this.active || !this.eventsFile || this.ingesting) {
      return;
    }
    this.ingesting = true;
    const generation = this.generation;
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      handle = await fs.open(source, "r");
      const stat = await handle.stat();
      let offset = source === this.eventsFile ? this.readOffset : this.extraOffsets.get(source) ?? 0;
      if (stat.size < offset) offset = 0;
      if (stat.size <= offset) {
        return;
      }
      const buf = Buffer.alloc(Math.min(stat.size - offset, 1024 * 1024));
      const { bytesRead } = await handle.read(buf, 0, buf.length, offset);
      if (!this.active || generation !== this.generation) return;
      const complete = buf.subarray(0, bytesRead).lastIndexOf(10) + 1;
      offset += complete;
      if (source === this.eventsFile) this.readOffset = offset;
      else this.extraOffsets.set(source, offset);
      const text = buf.subarray(0, complete).toString("utf8");
      const changed = new Set<string>();
      const ignored = new Map<string, string>();
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        try {
          const ev = JSON.parse(trimmed) as { file?: string; t?: number; agent?: string };
          if (ev.agent !== undefined && typeof ev.agent !== "string") continue;
          if (typeof ev.t === "number" && ev.t < this.sessionStartedAt) continue;
          if (typeof ev.file === "string") {
            if (!this.allowedFile(ev.file)) continue;
            const roots = vscode.workspace.workspaceFolders;
            if (roots?.length && !roots.some(({ uri }) => {
              const relative = path.relative(uri.fsPath, ev.file!);
              return relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
            })) continue;
            if (!this.allowedAgent(ev.agent)) { ignored.set(this.fileKey(ev.file), ev.file); continue; }
            this.markTouched(ev.file);
            changed.add(ev.file);
          }
        } catch {
          // baris tidak valid - lewati
        }
      }
      for (const file of changed) ignored.delete(this.fileKey(file));
      if (ignored.size && this.active && generation === this.generation) await this.absorbIgnored([...ignored.values()]);
      if (changed.size && this.active) {
        if (this.onAgentFiles) await this.onAgentFiles([...changed]);
        else this.deref();
      }
    } catch {
      // file mungkin belum ada
    } finally {
      await handle?.close().catch(() => {});
      this.ingesting = false;
    }
  }

  // Edits from a disabled agent (or untagged legacy hooks while any agent is
  // disabled) are not reviewed. Move the baseline to the new disk content so a
  // later edit by an enabled agent does not show them as its own changes.
  // Files already under review keep their baseline: the mixed edit stays
  // visible rather than silently accepting part of a pending proposal.
  private async absorbIgnored(files: string[]): Promise<void> {
    for (const file of files) {
      if (!this.active || !this.allowedFile(file) || this.hunks.get(path.normalize(file))?.length) continue;
      const key = this.fileKey(file);
      if (this.snapshotSkipped.has(key)) continue;
      const disk = await this.readDisk(file);
      if (disk === null || !this.active || this.hunks.get(path.normalize(file))?.length) continue;
      this.baseline.set(key, disk);
      this.computed.delete(path.normalize(file));
      this.touched.delete(key);
    }
  }

  private deref(): void {
    // beri tahu trigger render untuk file yang terbuka
    for (const editor of vscode.window.visibleTextEditors) {
      if (
        editor.document.uri.scheme === "file" &&
        this.shouldReview(editor.document.uri.fsPath)
      ) {
        void vscode.commands.executeCommand("opencodeInlineReview.recompute");
      }
    }
  }
}

export function proposalUriFor(filePath: string): vscode.Uri {
  const p = "/" + path.normalize(filePath).replace(/\\/g, "/");
  return vscode.Uri.from({ scheme: "oir-proposal", path: p });
}

export function proposalFilePath(uri: vscode.Uri): string {
  return path.normalize(uri.path.slice(1).replace(/\//g, path.sep));
}

export function displayPath(filePath: string): string {
  const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return ws ? path.relative(ws, filePath) || "." : filePath;
}
