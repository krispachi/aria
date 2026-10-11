import * as vscode from "vscode";
import { ReviewSession, displayPath } from "./session";

export interface ReviewNode { uri: vscode.Uri; id?: string; line?: number }
export class ReviewPanel implements vscode.TreeDataProvider<ReviewNode>, vscode.Disposable {
  private changed = new vscode.EventEmitter<ReviewNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private position = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 59);
  private previous = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 60);
  private next = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 58);
  private registration: vscode.Disposable;
  constructor(private session: ReviewSession, private setting: <T>(key: string, fallback: T) => T) {
    this.registration = vscode.window.registerTreeDataProvider("aria.changes", this);
    this.position.command = "aria.pickChange";
    this.previous.command = "aria.previousChange"; this.previous.text = "$(arrow-up)"; this.previous.tooltip = "ARIA: previous pending change";
    this.next.command = "aria.nextChange"; this.next.text = "$(arrow-down)"; this.next.tooltip = "ARIA: next pending change";
  }
  getChildren(node?: ReviewNode): ReviewNode[] {
    if (!this.session.isActive) return [];
    if (!node) return [...this.session.hunks.keys()].sort().map(file => ({ uri: vscode.Uri.file(file) }));
    if (node.id) return [];
    return (this.session.hunks.get(node.uri.fsPath) ?? []).map(h => ({ uri: node.uri, id: h.id, line: h.newStart - 1 }));
  }
  getTreeItem(node: ReviewNode): vscode.TreeItem {
    const h = node.id ? this.session.hunks.get(node.uri.fsPath)?.find(h => h.id === node.id) : undefined;
    const label = node.id ? `Line ${(node.line ?? 0) + 1}` : displayPath(node.uri.fsPath);
    const item = new vscode.TreeItem(label, node.id ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Expanded);
    item.id = node.uri.toString() + (node.id ? "#" + node.id : "");
    item.resourceUri = node.uri;
    item.contextValue = node.id ? "aria.change" : "aria.file";
    item.description = h ? `+${h.newLines.length} / −${h.oldLines.length}` : `${this.session.hunks.get(node.uri.fsPath)?.length ?? 0} changes`;
    item.iconPath = new vscode.ThemeIcon(node.id ? "diff" : "file-code");
    item.command = { command: "aria.openChange", title: "Open review", arguments: [node.uri, node.line ?? (this.session.hunks.get(node.uri.fsPath)?.[0]?.newStart ?? 1) - 1] };
    item.tooltip = node.id ? `${displayPath(node.uri.fsPath)}:${(node.line ?? 0) + 1} — pending Accept/Reject` : `${node.uri.fsPath} — pending Accept/Reject`;
    return item;
  }
  refresh(): void {
    this.changed.fire(undefined);
    void vscode.commands.executeCommand("setContext", "aria.showChangesView", this.setting("showChangesView", true));
    void vscode.commands.executeCommand("setContext", "aria.canUndo", this.session.canUndo);
    void vscode.commands.executeCommand("setContext", "aria.hasPending", this.session.pendingCount > 0);
    this.updatePosition();
  }
  updatePosition(): void {
    const targets = this.getChildren().flatMap(file => this.getChildren(file));
    if (!targets.length || !this.setting("showPosition", true)) { this.position.hide(); this.previous.hide(); this.next.hide(); return; }
    const editor = vscode.window.activeTextEditor;
    const uri = editor?.document.uri;
    const file = uri?.scheme === "aria-baseline" ? decodeURIComponent(uri.query) : uri?.fsPath;
    const line = editor?.selection.active.line ?? 0;
    const same = targets.filter(node => node.uri.fsPath === file);
    const current = [...same].reverse().find(node => (node.line ?? 0) <= line) ?? same[0];
    const index = current ? targets.indexOf(current) + 1 : 0;
    this.position.text = `$(diff) ${index || "—"}/${targets.length}`;
    this.position.tooltip = current ? `ARIA: ${displayPath(current.uri.fsPath)}:${current.line! + 1}. Click to choose a change.` : "ARIA: choose a pending change";
    this.position.show(); this.previous.show(); this.next.show();
  }
  async pick(): Promise<ReviewNode | undefined> {
    const choices = this.getChildren().flatMap(file => this.getChildren(file)).map(node => ({ label: displayPath(node.uri.fsPath), description: `Line ${node.line! + 1}`, node }));
    return (await vscode.window.showQuickPick(choices, { placeHolder: "Choose a pending ARIA change" }))?.node;
  }
  dispose(): void { this.registration.dispose(); this.changed.dispose(); this.position.dispose(); this.previous.dispose(); this.next.dispose(); }
}
