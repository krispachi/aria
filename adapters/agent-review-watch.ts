// Global opencode plugin untuk "OpenCode Inline Review".
// Dipasang oleh ekstensi ke ~/.config/opencode/plugins/ (atau OPENCODE_CONFIG_DIR).
// Tidak ada file yang ditulis ke proyek; event dicatat ke penyimpanan global:
//   ~/.aria/projects/<hash-root>.jsonl
// Algoritma hash identik dengan src/store.ts & adapters/record-event.mjs.
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";

const normalizeRoot = (dir: string): string =>
  dir.replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();

const storeFileFor = (root: string): string => {
  const base =
    process.env.OIR_STORE_DIR || path.join(homedir(), ".aria");
  const hash = createHash("sha256")
    .update(normalizeRoot(root))
    .digest("hex")
    .slice(0, 24);
  return path.join(base, "projects", hash + ".jsonl");
};

const toAbs = (root: string, file: string): string => {
  if (
    path.isAbsolute(file) ||
    file.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(file)
  ) {
    return file;
  }
  return path.join(root, file);
};

export const OpenCodeReviewWatch = async ({ directory, worktree }: any) => {
  const root = process.env.OIR_PROJECT_ROOT || directory || worktree;
  if (typeof root !== "string" || !root) return {};
  const eventsPath = storeFileFor(root);

  const record = (file: string) => {
    try {
      mkdirSync(path.dirname(eventsPath), { recursive: true });
      appendFileSync(
        eventsPath,
        JSON.stringify({ t: Date.now(), file: path.normalize(toAbs(root, file)), agent: "opencode" }) + "\n"
      );
    } catch {
      // best effort
    }
  };

  return {
    event: async ({ event }: { event: any }) => {
      if (event?.type !== "file.edited") {
        return;
      }
      if (event?.file) {
        record(event.file);
        return;
      }
      for (const data of [event?.properties, event?.data]) {
        for (const key of ["file", "filePath", "file_path", "path"]) {
          if (typeof data?.[key] === "string") {
            record(data[key]);
          }
        }
      }
    },
  };
};
