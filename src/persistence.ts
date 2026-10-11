import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SavedReview, ReviewFileState, ReviewDecision } from "./session";

const MAX_BYTES = 32 * 1024 * 1024;
function fileState(value: unknown): value is ReviewFileState {
  const item = value as ReviewFileState;
  return !!item && typeof item.file === "string" && path.isAbsolute(item.file) && typeof item.baseline === "string" && typeof item.content === "string";
}
function decision(value: unknown): value is ReviewDecision {
  const item = value as ReviewDecision;
  return !!item && Array.isArray(item.before) && Array.isArray(item.after) && Array.isArray(item.disk) && item.before.length === item.after.length && item.after.length === item.disk.length &&
    item.before.every(fileState) && item.after.every((after, i) => fileState(after) && after.file === item.before[i].file) &&
    item.disk.every((disk, i) => disk?.file === item.after[i].file && (typeof disk.content === "string" || disk.content === null));
}

/** Workspace-local, unsynced storage. It never modifies source files when restoring. */
export class ReviewCache {
  private timer?: ReturnType<typeof setTimeout>;
  private queue: Promise<void> = Promise.resolve();
  private readonly file: string;
  private clearedState?: string;
  constructor(root: string, private snapshot: () => SavedReview, private enabled: () => boolean, private retentionDays: () => number, private report: (message: string) => void) {
    this.file = path.join(root, "review-session.json");
  }
  async load(): Promise<SavedReview | undefined> {
    // A save queued by stop must land before a restart reads the file.
    await this.queue;
    if (!this.enabled()) { await this.clear(); return; }
    try {
      const stat = await fs.stat(this.file);
      if (stat.size > MAX_BYTES) throw new Error("Saved review exceeds the local cache size limit");
      const saved: SavedReview = JSON.parse(await fs.readFile(this.file, "utf8"));
      if (saved.version !== 1 || !Number.isFinite(saved.savedAt) || !Array.isArray(saved.files) || !saved.files.every(fileState) || !Array.isArray(saved.undo) || !saved.undo.every(decision)) throw new Error("Invalid saved review format");
      if (Date.now() - saved.savedAt > this.retentionDays() * 86400000) { await this.clear(); return; }
      return saved;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.report(`ARIA could not restore local review: ${String(error)}`);
    }
  }
  schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = undefined; void this.save(); }, 300);
  }
  save(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    let saved = this.enabled() ? this.snapshot() : undefined;
    if (saved && this.clearedState === JSON.stringify({ files: saved.files, undo: saved.undo })) saved = undefined;
    else if (saved) this.clearedState = undefined;
    return this.enqueue(async () => {
      if (!saved || (!saved.files.length && !saved.undo.length)) { await fs.unlink(this.file).catch(error => { if (error.code !== "ENOENT") throw error; }); return; }
      const text = JSON.stringify(saved);
      if (Buffer.byteLength(text) > MAX_BYTES) throw new Error("Local review exceeds 32 MB; it was not persisted");
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.writeFile(this.file + ".tmp", text, { mode: 0o600 });
      await fs.rename(this.file + ".tmp", this.file);
    });
  }
  clear(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    const state = this.snapshot();
    this.clearedState = JSON.stringify({ files: state.files, undo: state.undo });
    return this.enqueue(async () => { await fs.unlink(this.file).catch(error => { if (error.code !== "ENOENT") throw error; }); });
  }
  drain(): Promise<void> { return this.queue; }
  resume(): void { this.clearedState = undefined; this.schedule(); }
  private enqueue(operation: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(operation).catch(error => this.report(`ARIA local review storage: ${String(error)}`));
    return this.queue;
  }
}

/** Simple path globs: *, ** and ?. No regular expressions are accepted from settings. */
export function excluded(relative: string, patterns: string[]): boolean {
  const file = relative.replace(/\\/g, "/");
  return patterns.some(pattern => {
    let expression = "";
    for (let i = 0; i < pattern.length; i++) {
      const c = pattern[i];
      if (c === "*" && pattern[i + 1] === "*") {
        i++;
        if (pattern[i + 1] === "/") { i++; expression += "(?:.*/)?"; } else expression += ".*";
      } else if (c === "*") expression += "[^/]*";
      else if (c === "?") expression += "[^/]";
      else expression += c.replace(/[\\^$+.()|{}\[\]]/g, "\\$&");
    }
    return new RegExp("^" + expression + "$", process.platform === "win32" ? "i" : "").test(file);
  });
}
