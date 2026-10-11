import * as fs from "node:fs/promises";
import * as path from "node:path";
import { computeHunks, Hunk, normalize } from "./diff";
import { excluded } from "./persistence";

export interface ReviewFileState { file: string; baseline: string; content: string }
export interface ReviewDecision { before: ReviewFileState[]; after: ReviewFileState[]; disk: Array<{ file: string; content: string | null }> }
export interface SavedReview { version: 1; savedAt: number; files: ReviewFileState[]; undo: ReviewDecision[] }

export const SUPPORTED_AGENTS = ["opencode", "claude", "codex", "cursor", "copilot", "gemini"] as const;

export interface Settings {
  enabled: boolean;
  agents: Record<string, boolean>;
  adapterSetup: "auto" | "ask" | "off";
  eventsFile: string;
  excludePatterns: string[];
  maxFileSizeKb: number;
  maxSnapshotSizeMb: number;
  persistReview: boolean;
  retentionDays: number;
  undoLimit: number;
  openDiff: boolean;
}

export const DEFAULTS: Settings = {
  enabled: true,
  agents: Object.fromEntries(SUPPORTED_AGENTS.map(agent => [agent, true])),
  adapterSetup: "auto",
  eventsFile: "",
  excludePatterns: ["**/.env", "**/.env.*", "**/*.pem", "**/*.key"],
  maxFileSizeKb: 1024,
  maxSnapshotSizeMb: 64,
  persistReview: true,
  retentionDays: 7,
  undoLimit: 20,
  openDiff: false,
};

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "builds", ".next", "out", "target", "coverage", "__pycache__", ".venv", "venv", ".opencode", ".agent-review"]);
const MAX_FILES = 20000;

export function toLines(text: string): string[] {
  const lines = normalize(text).split("\n");
  if (text.endsWith("\n")) lines.pop();
  if (!text) lines.length = 0;
  return lines;
}

/** Replace `count` lines of `target` at `start` with `insert`. `other` is the
 * opposite side of the diff: when the hunk reaches the end of both texts, the
 * final newline is taken from it, so EOF changes are accepted/rejected too. */
export function applyHunk(target: string, other: string, start: number, count: number, insert: string[], otherStart: number): string {
  const eol = target.includes("\r\n") || (!target && other.includes("\r\n")) ? "\r\n" : "\n";
  const lines = toLines(target);
  const affectsEOF = start + count >= lines.length && otherStart + insert.length >= toLines(other).length;
  lines.splice(start, count, ...insert);
  return lines.join(eol) + (lines.length && (affectsEOF ? other : target).endsWith("\n") ? eol : "");
}

export class Session {
  private baseline = new Map<string, string>();
  private content = new Map<string, string>();
  private skipped = new Set<string>();
  private incomplete = false;
  readonly touched = new Set<string>();
  readonly hunks = new Map<string, Hunk[]>();
  readonly agentOf = new Map<string, string>();
  history: ReviewDecision[] = [];

  constructor(readonly root: string, public settings: Settings, private report: (message: string) => void = () => {}) {}

  key(file: string): string {
    const normalized = path.normalize(file);
    return path.sep === "\\" ? normalized.toLowerCase() : normalized;
  }

  allowedFile(file: string): boolean {
    const relative = path.relative(this.root, file);
    return !!relative && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative) && !excluded(relative, this.settings.excludePatterns);
  }

  /** Untagged (legacy) events are only trusted while every agent is enabled. */
  allowedAgent(agent?: string): boolean {
    if (agent && (SUPPORTED_AGENTS as readonly string[]).includes(agent)) return this.settings.agents[agent] !== false;
    return SUPPORTED_AGENTS.every(known => this.settings.agents[known] !== false);
  }

  reviewable(file: string): boolean {
    const key = this.key(file);
    return this.allowedFile(file) && !this.skipped.has(key) && !(this.incomplete && !this.baseline.has(key));
  }

  baselineOf(file: string): string { return this.baseline.get(this.key(file)) ?? ""; }
  setBaseline(file: string, text: string): void { this.baseline.set(this.key(file), text); }
  contentOf(file: string): string | undefined { return this.content.get(path.normalize(file)); }

  refresh(file: string, content: string): Hunk[] {
    // Hunks and content are keyed by the real path (published as URIs); baseline
    // and touched use the case-folded key on Windows.
    const key = this.key(file), real = path.normalize(file);
    if (!this.touched.has(key) || !this.reviewable(file) || content.includes("\0") || Buffer.byteLength(content) > this.settings.maxFileSizeKb * 1024) {
      this.hunks.delete(real);
      return [];
    }
    this.content.set(real, content);
    const hunks = computeHunks(this.baselineOf(file), content);
    if (hunks.length) this.hunks.set(real, hunks);
    else { this.hunks.delete(real); this.touched.delete(key); }
    return hunks;
  }

  hunk(file: string, id: string): Hunk | undefined {
    return this.hunks.get(path.normalize(file))?.find(h => h.id === id);
  }

  acceptHunk(file: string, hunk: Hunk): void {
    const current = this.contentOf(file) ?? "";
    this.setBaseline(file, applyHunk(this.baselineOf(file), current, hunk.oldStart - 1, hunk.oldLines.length, hunk.newLines, hunk.newStart - 1));
    this.refresh(file, current);
  }

  /** The file content after rejecting one hunk; the caller writes it. */
  rejectedContent(file: string, hunk: Hunk): string {
    return applyHunk(this.contentOf(file) ?? "", this.baselineOf(file), hunk.newStart - 1, hunk.newLines.length, hunk.oldLines, hunk.oldStart - 1);
  }

  acceptFile(file: string, content: string): void {
    const key = this.key(file);
    this.baseline.set(key, content);
    this.content.set(path.normalize(file), content);
    this.hunks.delete(path.normalize(file));
    this.touched.delete(key);
  }

  /** Edits made in the editor outside pending agent blocks become part of the
   * baseline, so they are never shown (or rejected) as agent changes. */
  observeManual(file: string, content: string): void {
    const key = this.key(file);
    const pending = this.hunks.get(path.normalize(file)) ?? [];
    if (!pending.length) { this.acceptFile(file, content); return; }
    const previous = this.contentOf(file) ?? this.baselineOf(file);
    const baseline = this.baselineOf(file);
    const lines = toLines(baseline);
    let trailing = baseline.endsWith("\n");
    const mapLine = (line: number): number => {
      let delta = 0;
      for (const h of pending) if (h.newStart - 1 + h.newLines.length <= line) delta += h.oldLines.length - h.newLines.length;
      return line + delta;
    };
    for (const edit of computeHunks(previous, content).reverse()) {
      const start = edit.oldStart - 1, end = start + edit.oldLines.length;
      const overlaps = pending.some(h => {
        const a = h.newStart - 1, b = a + h.newLines.length;
        return start === end ? start > a && start < b : a === b ? a > start && a < end : start < b && end > a;
      });
      if (overlaps) continue; // Edits within a pending agent block stay part of that proposal.
      const oldStart = mapLine(start), oldEnd = mapLine(end);
      if (oldEnd >= lines.length) trailing = content.endsWith("\n");
      lines.splice(oldStart, oldEnd - oldStart, ...edit.newLines);
    }
    const eol = baseline.includes("\r\n") || content.includes("\r\n") ? "\r\n" : "\n";
    this.baseline.set(key, lines.join(eol) + (lines.length && trailing ? eol : ""));
    this.refresh(file, content);
  }

  /** Edits from a disabled agent move the baseline unless the file is already under review. */
  absorb(file: string, disk: string): void {
    const key = this.key(file);
    if (this.hunks.get(path.normalize(file))?.length || !this.reviewable(file)) return;
    this.baseline.set(key, disk);
    this.touched.delete(key);
  }

  record(before: ReviewFileState[], after: ReviewFileState[], disk: ReviewDecision["disk"]): void {
    const changed = before.map((item, i) => item.baseline !== after[i].baseline || item.content !== after[i].content ? i : -1).filter(i => i >= 0);
    if (!changed.length || this.settings.undoLimit <= 0) return;
    this.history.push({ before: changed.map(i => before[i]), after: changed.map(i => after[i]), disk: changed.map(i => disk[i]) });
    this.history = this.history.slice(-this.settings.undoLimit);
  }

  exportReview(): SavedReview {
    const max = this.settings.maxFileSizeKb * 1024;
    const eligible = (item: ReviewFileState) => this.allowedFile(item.file) && Buffer.byteLength(item.content) <= max && Buffer.byteLength(item.baseline) <= max;
    return {
      version: 1, savedAt: Date.now(),
      files: [...this.hunks.keys()].map(file => ({ file, baseline: this.baselineOf(file), content: this.content.get(file) ?? "" })).filter(eligible),
      undo: this.history.filter(entry => [...entry.before, ...entry.after].every(eligible)),
    };
  }

  async snapshot(): Promise<void> {
    const files: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries: import("node:fs").Dirent[];
      try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (files.length >= MAX_FILES) return;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) await walk(full); }
        else if (entry.isFile() && this.allowedFile(full)) files.push(full);
      }
    };
    const started = Date.now();
    await walk(this.root);
    const budget = this.settings.maxSnapshotSizeMb * 1024 * 1024, maxFile = this.settings.maxFileSizeKb * 1024;
    const counts = { binary: 0, size: 0, budget: 0, read: 0 };
    const skip = (file: string, reason: keyof typeof counts) => { this.skipped.add(this.key(file)); counts[reason]++; };
    let used = 0, index = 0;
    await Promise.all(Array.from({ length: Math.min(8, files.length) }, async () => {
      while (index < files.length) {
        const file = files[index++];
        try {
          const size = (await fs.stat(file)).size;
          if (size > maxFile) { skip(file, "size"); continue; }
          if (used + size > budget) { skip(file, "budget"); continue; }
          used += size;
          const text = await fs.readFile(file, "utf8");
          if (text.includes("\0")) { used -= size; skip(file, "binary"); continue; }
          this.baseline.set(this.key(file), text);
        } catch { skip(file, "read"); }
      }
    }));
    this.incomplete = files.length >= MAX_FILES;
    this.report(`ARIA snapshot: ${this.baseline.size} text file(s), ${Date.now() - started} ms. Skipped: binary=${counts.binary}, size=${counts.size}, budget=${counts.budget}, read=${counts.read}${this.incomplete ? "; 20,000-file limit reached" : ""}.`);
  }
}

/** Tails the hook event JSONL files, starting from their size when the session started. */
export class EventLog {
  private offsets = new Map<string, number>();
  private reading = false;
  constructor(private file: string, private global: boolean, private since: number) {}

  private sources(): string[] {
    if (!this.global) return [this.file];
    try {
      const dir = path.dirname(this.file);
      return require("node:fs").readdirSync(dir).filter((name: string) => name.endsWith(".jsonl")).map((name: string) => path.join(dir, name));
    } catch { return [this.file]; }
  }

  captureOffsets(): void {
    for (const source of this.sources()) {
      try { this.offsets.set(source, require("node:fs").statSync(source).size); } catch {}
    }
  }

  async read(): Promise<Array<{ file: string; agent?: string }>> {
    if (this.reading) return [];
    this.reading = true;
    const events: Array<{ file: string; agent?: string }> = [];
    try {
      for (const source of this.sources()) {
        let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
        try {
          handle = await fs.open(source, "r");
          const { size } = await handle.stat();
          let offset = this.offsets.get(source) ?? 0;
          if (size < offset) offset = 0;
          if (size <= offset) continue;
          const buf = Buffer.alloc(Math.min(size - offset, 1024 * 1024));
          const { bytesRead } = await handle.read(buf, 0, buf.length, offset);
          const complete = buf.subarray(0, bytesRead).lastIndexOf(10) + 1;
          this.offsets.set(source, offset + complete);
          for (const line of buf.subarray(0, complete).toString("utf8").split("\n")) {
            try {
              const ev = JSON.parse(line) as { file?: unknown; t?: unknown; agent?: unknown };
              if (typeof ev.file !== "string" || (ev.agent !== undefined && typeof ev.agent !== "string")) continue;
              if (typeof ev.t === "number" && ev.t < this.since) continue;
              events.push({ file: path.normalize(ev.file), agent: ev.agent as string | undefined });
            } catch {}
          }
        } catch {} finally { await handle?.close().catch(() => {}); }
      }
    } finally { this.reading = false; }
    return events;
  }
}
