import * as path from "node:path";
import type { Memento } from "vscode";

export type ActivationMode = "all" | "init";
export interface DirectoryState { initialized?: boolean; enabled?: boolean }

export class DirectoryRegistry {
  private entries: Record<string, DirectoryState>;
  constructor(private storage: Memento) {
    this.entries = { ...storage.get<Record<string, DirectoryState>>("ariaDirectories", {}) };
  }
  private key(root: string): string {
    const key = path.resolve(root);
    return process.platform === "win32" ? key.toLowerCase() : key;
  }
  private reload(): void {
    this.entries = { ...this.storage.get<Record<string, DirectoryState>>("ariaDirectories", {}) };
  }
  isEnabled(root: string, mode: ActivationMode): boolean {
    this.reload();
    const entry = this.entries[this.key(root)];
    return entry?.enabled !== false && (mode === "all" || entry?.initialized === true);
  }
  async set(root: string, enabled: boolean): Promise<void> {
    this.reload();
    const key = this.key(root);
    this.entries[key] = { ...this.entries[key], enabled, ...(enabled ? { initialized: true } : {}) };
    await this.storage.update("ariaDirectories", this.entries);
  }
  initialized(): string[] {
    this.reload();
    return Object.keys(this.entries).filter(key => this.entries[key].initialized);
  }
  exportState(): Record<string, DirectoryState> {
    this.reload();
    return Object.fromEntries(Object.entries(this.entries).map(([root, state]) => [root, { ...state }]));
  }
  async mergeState(entries: Record<string, DirectoryState>): Promise<void> {
    this.reload();
    for (const [root, state] of Object.entries(entries)) this.entries[this.key(root)] = { ...this.entries[this.key(root)], ...state };
    await this.storage.update("ariaDirectories", this.entries);
  }
  async clear(): Promise<void> { await this.storage.update("ariaDirectories", undefined); this.entries = {}; }
}
