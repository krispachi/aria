#!/usr/bin/env node
// record-event.mjs — hook/plugin runtime bersama untuk "OpenCode Inline Review".
//
// Dipanggil oleh hook CLI agent (Claude Code, Cursor, Copilot, Codex) lewat
// `node <ini>/record-event.mjs`. Memberi satu baris JSON di stdin:
//
//   { "file": "path/ke/file", ... }
//
// Skrip menetapkan root proyek dari (urut prioritas):
//   1. field "root"   pada JSON
//   2. env OIR_PROJECT_ROOT
//   3. env CLAUDE_PROJECT_DIR
//   4. cwd proses
// lalu menambahkan {"t","file","agent"} ke penyimpanan GLOBAL (BUKAN ke proyek):
// "agent" opsional untuk kompatibilitas hook lama; hook baru memakai --agent <id>.
//   ~/.aria/projects/<hash-root>.jsonl
//
// Berguna juga mandiri: `echo "{...}" | node record-event.mjs`
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";

const agentFlag = process.argv.indexOf("--agent");
const sourceAgent = agentFlag >= 0 && /^[a-z][a-z0-9-]{0,31}$/.test(process.argv[agentFlag + 1] ?? "")
  ? process.argv[agentFlag + 1] : process.argv.includes("--gemini") ? "gemini" : undefined;

// ALGORITMA HASH musti identik dengan src/store.ts (VS Code) agar kunci cocok.
function normalizeRoot(dir) {
  return dir.replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
}
function projectHash(root) {
  return createHash("sha256")
    .update(normalizeRoot(root))
    .digest("hex")
    .slice(0, 24);
}
function storeBase() {
  return process.env.OIR_STORE_DIR || path.join(homedir(), ".aria");
}
function storeFileFor(root) {
  return path.join(storeBase(), "projects", projectHash(root) + ".jsonl");
}

function toAbs(root, file) {
  if (path.isAbsolute(file) || /^[A-Za-z]:[\\/]/.test(file) || file.startsWith("/")) {
    return file;
  }
  return path.join(root, file);
}

// Ambil path file dari berbagai bentuk payload hook (terima kasih: banyak CLI).
function extractFiles(ev) {
  const found = new Set();
  const add = (file) => {
    if (typeof file === "string" && file.trim() && !/[\r\n\0]/.test(file)) found.add(file);
  };
  const visit = (value, depth = 0) => {
    if (depth > 8 || !value) return;
    if (typeof value === "string") {
      try {
        visit(JSON.parse(value), depth + 1);
      } catch {}
      const lines = value.replace(/\r\n/g, "\n").split("\n");
      const start = lines.indexOf("*** Begin Patch");
      const end = lines.indexOf("*** End Patch", start + 1);
      if (start >= 0 && end > start) {
        for (const line of lines.slice(start + 1, end)) {
          const match = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/.exec(line);
          if (match) add(match[1]);
        }
      }
      return;
    }
    if (typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    for (const key of ["file", "filePath", "file_path", "path"]) add(value[key]);
    if (Array.isArray(value.files)) {
      for (const file of value.files) {
        if (typeof file === "string") add(file);
        else visit(file, depth + 1);
      }
    }
    for (const key of ["tool_input", "toolInput", "toolArgs", "input", "data", "properties", "arguments", "apply_patch", "patch", "command"]) {
      visit(value[key], depth + 1);
    }
  };
  visit(ev);
  return [...found];
}

function record(ev, depth = 0) {
  if (depth > 8) return;
  if (Array.isArray(ev)) {
    for (const item of ev) { try { record(item, depth + 1); } catch {} }
    return;
  }
  const root =
    (typeof ev?.root === "string" && ev.root) ||
    process.env.OIR_PROJECT_ROOT ||
    (typeof ev?.cwd === "string" && ev.cwd) ||
    (Array.isArray(ev?.workspace_roots) && ev.workspace_roots.find((root) => typeof root === "string" && root)) ||
    process.env.CLAUDE_PROJECT_DIR ||
    process.cwd();
  if (!root) return;
  const files = extractFiles(ev);
  if (files.length === 0) return;
  const file = storeFileFor(root);
  try {
    mkdirSync(path.dirname(file), { recursive: true });
  } catch {
    return;
  }
  const t = Date.now();
  for (const f of files) {
    try {
      appendFileSync(
        file,
        JSON.stringify({ t, file: path.normalize(toAbs(root, f)), ...(sourceAgent ? { agent: sourceAgent } : {}) }) + "\n",
        "utf8"
      );
    } catch {
      // best effort - jangan sampai mengganggu sesi agent
    }
  }
}

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(""));
  });
}

const raw = await readStdin();
let inputs;
try {
  inputs = [JSON.parse(raw)];
} catch {
  inputs = raw.split("\n");
}
for (const line of inputs) {
  if (typeof line === "object") {
    try { record(line); } catch {}
    continue;
  }
  const trimmed = line.trim();
  if (!trimmed) continue;
  try {
    record(JSON.parse(trimmed));
  } catch {
    // baris tidak valid - lewati
  }
}
// Gemini expects JSON on stdout. Other CLI hooks remain silent.
if (process.argv.includes("--gemini")) process.stdout.write("{}\n");
export { record, projectHash, storeFileFor };
