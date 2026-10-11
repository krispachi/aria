import { createHash } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";

// Normalisasi & hash root workspace. ALGORITMA INI DIVERNAKAN ULANG di
// adapters/record-event.mjs (skrip hook/plugin yang berjalan di luar VS Code) —
// jika diubah di sini, ubah juga di sana agar kunci hash selalu cocok.
export function projectHash(root: string): string {
  const norm = root
    .replace(/[\\/]+$/, "")
    .replace(/\\/g, "/")
    .toLowerCase();
  return createHash("sha256").update(norm).digest("hex").slice(0, 24);
}

export function globalStoreBase(): string {
  return (
    process.env.OIR_STORE_DIR ||
    path.join(os.homedir(), ".aria")
  );
}

export function storeFileFor(root: string): string {
  return path.join(globalStoreBase(), "projects", projectHash(root) + ".jsonl");
}

// Jalur file event yang dibaca ekstensi.
// - override kosong   -> penyimpanan global (default; proyek bersih).
// - override relatif  -> <workspaceRoot>/<override> (mode in-project/legacy).
// - override absolut  -> langsung dipakai.
export function resolveEventsFile(root: string, override: string): string {
  const raw = (override || "").trim();
  if (!raw) {
    return storeFileFor(root);
  }
  return path.isAbsolute(raw) ? path.normalize(raw) : path.join(root, raw);
}

export function adapterInstallDir(): string {
  return path.join(globalStoreBase(), "adapters");
}

export function backupDir(): string {
  return path.join(globalStoreBase(), "backup");
}
