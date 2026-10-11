import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  adapterInstallDir,
  backupDir,
  globalStoreBase,
} from "./store";

export interface AdapterResult {
  agent: string;
  ok: boolean;
  message: string;
}

const MARKER = "aria/adapters/record-event.mjs";

function homedir(): string {
  return os.homedir();
}

function readJson(file: string): any {
  try {
    const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) throw new Error(`Expected a configuration object: ${file}`);
    if (cfg.hooks !== undefined && (!cfg.hooks || typeof cfg.hooks !== "object" || Array.isArray(cfg.hooks))) throw new Error(`Invalid hooks object; configuration preserved: ${file}`);
    return cfg;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function hookList(cfg: any, event: string): any[] {
  const list = cfg.hooks?.[event] ?? [];
  if (!Array.isArray(list)) throw new Error(`Invalid ${event} hooks; configuration preserved.`);
  return list;
}

function withoutAriaHooks(entries: any[]): any[] {
  return entries.flatMap(entry => {
    if (Array.isArray(entry?.hooks)) {
      const hooks = entry.hooks.filter((hook: any) => !hasMarker(JSON.stringify(hook) ?? ""));
      return hooks.length === entry.hooks.length ? [entry] : hooks.length ? [{ ...entry, hooks }] : [];
    }
    return hasMarker(JSON.stringify(entry) ?? "") ? [] : [entry];
  });
}

function backupIfExists(file: string): void {
  if (!fs.existsSync(file)) {
    return;
  }
  fs.mkdirSync(backupDir(), { recursive: true });
  fs.copyFileSync(
    file,
    path.join(backupDir(), `${path.basename(file)}.${Date.now()}.bak`)
  );
}

function writeJson(file: string, value: any): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", "utf8");
}

// Cek binary CLI pada PATH (win32: `where`, lainnya: `command -v`).
export function detectAgents(): string[] {
  const bins: Record<string, string> = {
    opencode: "opencode",
    claude: "claude",
    codex: "codex",
    cursor: "cursor-agent",
    copilot: "copilot",
    gemini: "gemini",
  };
  const shells = [
    { bin: "cursor-agent", aliases: ["cursor", "cursor-agent"] },
  ];
  const found: string[] = [];
  const cmd = process.platform === "win32" ? "where" : "command";
  for (const [agent, bin] of Object.entries(bins)) {
    let resolved = false;
    const candidates = shells.find((s) => s.bin === bin)?.aliases ?? [bin];
    for (const c of candidates) {
      try {
        if (process.platform === "win32") execFileSync(cmd, [c], { stdio: "ignore", timeout: 4000 });
        else execFileSync("sh", ["-c", 'command -v "$1"', "aria", c], { stdio: "ignore", timeout: 4000 });
        resolved = true;
        break;
      } catch {
        // lanjut cari alias berikutnya
      }
    }
    if (resolved) {
      found.push(agent);
    }
  }
  return found;
}

function copyAsset(name: string, target: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(__dirname, "..", "adapters", name), target);
}

// ---------------------------------------------------------------------------
// Installer per agent (level user / global — BUKAN di proyek)
// ---------------------------------------------------------------------------

async function installOpencode(): Promise<AdapterResult> {
  try {
    const pluginsDir =
      (process.env.OPENCODE_CONFIG_DIR && path.join(process.env.OPENCODE_CONFIG_DIR, "plugins")) ||
      path.join(homedir(), ".config", "opencode", "plugins");
    const target = path.join(pluginsDir, "agent-review-watch.ts");
    backupIfExists(target);
    copyAsset("agent-review-watch.ts", target);
    return {
      agent: "opencode",
      ok: true,
      message: `plugin global → ${target}`,
    };
  } catch (err) {
    return {
      agent: "opencode",
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

async function installClaude(): Promise<AdapterResult> {
  try {
    const scriptPath = ensureRecordEvent();
    const settingsPath = path.join(homedir(), ".claude", "settings.json");
    const hookCmd = `node "${scriptPath}" --agent claude`;
    const entry = {
      matcher: "Edit|MultiEdit|Write",
      hooks: [{ type: "command", command: hookCmd, timeout: 5 }],
    };
    backupIfExists(settingsPath);
    const cfg = readJson(settingsPath) ?? {};
    cfg.hooks = cfg.hooks ?? {};
    const list = hookList(cfg, "PostToolUse");
    cfg.hooks.PostToolUse = withoutAriaHooks(list);
    cfg.hooks.PostToolUse.push(entry);
    writeJson(settingsPath, cfg);
    return { agent: "claude", ok: true, message: `Hook in ~/.claude/settings.json` };
  } catch (err) {
    return {
      agent: "claude",
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

async function installCursor(): Promise<AdapterResult> {
  try {
    const scriptPath = ensureRecordEvent();
    const hooksPath = path.join(homedir(), ".cursor", "hooks.json");
    backupIfExists(hooksPath);
    const cfg = readJson(hooksPath) ?? { version: 1, hooks: {} };
    cfg.version = 1;
    cfg.hooks = cfg.hooks ?? {};
    const list = hookList(cfg, "afterFileEdit");
    cfg.hooks.afterFileEdit = withoutAriaHooks(list);
    cfg.hooks.afterFileEdit.push({ command: `node "${scriptPath}" --agent cursor` });
    const postTools = hookList(cfg, "postToolUse");
    cfg.hooks.postToolUse = withoutAriaHooks(postTools);
    cfg.hooks.postToolUse.push({ matcher: "Write|Edit|Delete", command: `node "${scriptPath}" --agent cursor` });
    writeJson(hooksPath, cfg);
    return { agent: "cursor", ok: true, message: `Hook in ~/.cursor/hooks.json` };
  } catch (err) {
    return {
      agent: "cursor",
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

async function installCopilot(): Promise<AdapterResult> {
  try {
    const scriptPath = ensureRecordEvent();
    const hooksDir = path.join(homedir(), ".copilot", "hooks");
    const hooksPath = path.join(hooksDir, "agent-inline-review.json");
    backupIfExists(hooksPath);
    const cfg = readJson(hooksPath) ?? { version: 1, hooks: {} };
    cfg.version = 1;
    cfg.hooks = cfg.hooks ?? {};
    cfg.hooks.postToolUse = withoutAriaHooks(hookList(cfg, "postToolUse"));
    cfg.hooks.postToolUse.push({
      type: "command", matcher: "^(?:edit|create)$",
      bash: `node "${scriptPath}" --agent copilot`,
      powershell: `node "${scriptPath}" --agent copilot`, timeoutSec: 5,
    });
    writeJson(hooksPath, cfg);
    return { agent: "copilot", ok: true, message: `Hook in "${hooksPath}"` };
  } catch (err) {
    return {
      agent: "copilot",
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

async function installGemini(): Promise<AdapterResult> {
  try {
    const scriptPath = ensureRecordEvent();
    const settingsPath = path.join(homedir(), ".gemini", "settings.json");
    const cfg = readJson(settingsPath) ?? {};
    cfg.hooks = cfg.hooks ?? {};
    const list = hookList(cfg, "AfterTool");
    cfg.hooks.AfterTool = withoutAriaHooks(list);
    cfg.hooks.AfterTool.push({
      matcher: "^(write_file|replace)$",
      hooks: [{ name: "aria-review", type: "command", command: `node "${scriptPath}" --agent gemini --gemini`, timeout: 5000 }],
    });
    backupIfExists(settingsPath);
    writeJson(settingsPath, cfg);
    return { agent: "gemini", ok: true, message: "AfterTool hook in ~/.gemini/settings.json; verify in Gemini CLI." };
  } catch (error) {
    return { agent: "gemini", ok: false, message: String(error) };
  }
}

async function installCodex(): Promise<AdapterResult> {
  try {
    const scriptPath = ensureRecordEvent();
    const codexDir = path.join(homedir(), ".codex");
    const tomlPath = path.join(codexDir, "config.toml");
    const command = JSON.stringify(`node "${scriptPath.replace(/\\/g, "/")}" --agent codex`);
    const block =
      `\n# aria inline review begin\n` +
      `[[hooks.PostToolUse]]\nmatcher = "apply_patch"\n` +
      `[[hooks.PostToolUse.hooks]]\ntype = "command"\ncommand = ${command}\ntimeout = 5\n` +
      `# aria inline review end\n`;
    if (!fs.existsSync(tomlPath)) {
      fs.mkdirSync(codexDir, { recursive: true });
      fs.writeFileSync(tomlPath, block, "utf8");
      return { agent: "codex", ok: true, message: `Created Codex config.toml` };
    }
    const text = fs.readFileSync(tomlPath, "utf8");
    const ownBlock = /^# aria inline review begin\r?\n[\s\S]*?^# aria inline review end(?:\r?\n|$)/gm;
    if (text.includes("# aria inline review begin") && hasMarker(text)) {
      if (text.replace(/\r\n/g, "\n").includes(block.trim())) return { agent: "codex", ok: true, message: "Already installed" };
      // Older blocks lack the agent tag or point to a previous runtime path;
      // untagged events are ignored once any agent is disabled.
      backupIfExists(tomlPath);
      fs.writeFileSync(tomlPath, text.replace(ownBlock, "").replace(/\s*$/, "\n") + block, "utf8");
      return { agent: "codex", ok: true, message: "Hook block updated" };
    }
    if (/^\s*(?:\[hooks\]|PostToolUse\s*=)/m.test(text) || hasMarker(text)) {
      return {
        agent: "codex",
        ok: false,
        message:
          `config.toml already has a [hooks] table; add the ARIA PostToolUse entry manually (command: ${command}). See README > Agent adapters.`,
      };
    }
    backupIfExists(tomlPath);
    fs.appendFileSync(tomlPath, block, "utf8");
    return { agent: "codex", ok: true, message: "Hook block added" };
  } catch (err) {
    return {
      agent: "codex",
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

function ensureRecordEvent(): string {
  const target = path.join(adapterInstallDir(), "record-event.mjs");
  copyAsset("record-event.mjs", target);
  return target;
}

function hasMarker(text: string): boolean {
  const normalized = text.replace(/\\+/g, "/");
  return [MARKER, "agent-inline-review/adapters/record-event.mjs", "opencode-inline-review/adapters/record-event.mjs"].some((marker) => normalized.includes(marker));
}

// ---------------------------------------------------------------------------
// API publik
// ---------------------------------------------------------------------------

export async function setupAdapters(selected?: readonly string[]): Promise<AdapterResult[]> {
  const installers: Array<[string, () => Promise<AdapterResult>]> = [
    ["opencode", installOpencode], ["claude", installClaude], ["cursor", installCursor],
    ["copilot", installCopilot], ["codex", installCodex], ["gemini", installGemini],
  ];
  if (selected?.some(agent => !installers.some(([known]) => known === agent))) throw new Error("Unknown agent adapter requested.");
  const results: AdapterResult[] = [];
  for (const [agent, install] of installers) if (selected === undefined || selected.includes(agent)) results.push(await install());
  return results;
}

export async function removeAdapters(): Promise<AdapterResult[]> {
  const results: AdapterResult[] = [];
  try {
    const pluginsDir =
      (process.env.OPENCODE_CONFIG_DIR && path.join(process.env.OPENCODE_CONFIG_DIR, "plugins")) ||
      path.join(homedir(), ".config", "opencode", "plugins");
        const pluginFile = path.join(pluginsDir, "agent-review-watch.ts");
    if (fs.existsSync(pluginFile)) {
      fs.rmSync(pluginFile, { force: true });
      results.push({
        agent: "opencode",
        ok: true,
        message: "Global plugin removed",
      });
    } else {
      results.push({
        agent: "opencode",
        ok: true,
        message: "Not installed",
      });
    }
  } catch (err) {
    results.push({ agent: "opencode", ok: false, message: String(err) });
  }

  for (const [agent, file] of [
    ["claude", path.join(homedir(), ".claude", "settings.json")],
    ["cursor", path.join(homedir(), ".cursor", "hooks.json")],
    ["gemini", path.join(homedir(), ".gemini", "settings.json")],
  ] as const) {
    try {
      if (!fs.existsSync(file)) {
        results.push({ agent, ok: true, message: "Not installed" });
        continue;
      }
      backupIfExists(file);
      const cfg = readJson(file);
      if (cfg?.hooks?.PostToolUse) {
        cfg.hooks.PostToolUse = withoutAriaHooks(hookList(cfg, "PostToolUse"));
        if (cfg.hooks.PostToolUse.length === 0) delete cfg.hooks.PostToolUse;
      }
      if (cfg?.hooks?.afterFileEdit) {
        cfg.hooks.afterFileEdit = withoutAriaHooks(hookList(cfg, "afterFileEdit"));
        if (cfg.hooks.afterFileEdit.length === 0) delete cfg.hooks.afterFileEdit;
      }
      if (cfg?.hooks?.AfterTool) {
        cfg.hooks.AfterTool = withoutAriaHooks(hookList(cfg, "AfterTool"));
        if (!cfg.hooks.AfterTool.length) delete cfg.hooks.AfterTool;
      }
      if (cfg?.hooks?.postToolUse) {
        cfg.hooks.postToolUse = withoutAriaHooks(hookList(cfg, "postToolUse"));
        if (!cfg.hooks.postToolUse.length) delete cfg.hooks.postToolUse;
      }
      if (!cfg?.hooks || Object.keys(cfg.hooks).length === 0) {
        if (cfg) delete cfg.hooks;
      }
      writeJson(file, cfg);
      results.push({ agent, ok: true, message: "ARIA hooks removed" });
    } catch (err) {
      results.push({ agent, ok: false, message: String(err) });
    }
  }

  try {
    const copilotFile = path.join(
      homedir(),
      ".copilot",
      "hooks",
      "agent-inline-review.json"
    );
    if (fs.existsSync(copilotFile)) {
      const cfg = readJson(copilotFile);
      let changed = false;
      for (const event of Object.keys(cfg.hooks ?? {})) {
        const entries = hookList(cfg, event);
        const cleaned = withoutAriaHooks(entries);
        if (JSON.stringify(cleaned) !== JSON.stringify(entries)) {
          changed = true;
          if (cleaned.length) cfg.hooks[event] = cleaned; else delete cfg.hooks[event];
        }
      }
      if (changed) {
        backupIfExists(copilotFile);
        if (!Object.keys(cfg.hooks).length && Object.keys(cfg).every(key => ["version", "hooks"].includes(key))) fs.rmSync(copilotFile);
        else writeJson(copilotFile, cfg);
      }
    }
    results.push({ agent: "copilot", ok: true, message: "Hook removed" });
  } catch (err) {
    results.push({ agent: "copilot", ok: false, message: String(err) });
  }

  try {
    const tomlPath = path.join(homedir(), ".codex", "config.toml");
    if (fs.existsSync(tomlPath)) {
      const text = fs.readFileSync(tomlPath, "utf8");
      if (hasMarker(text)) {
        const cleaned = text.replace(/^# aria inline review begin\r?\n[\s\S]*?^# aria inline review end(?:\r?\n|$)/gm, "");
        if (cleaned !== text) {
          backupIfExists(tomlPath);
          fs.writeFileSync(tomlPath, cleaned, "utf8");
        } else {
          results.push({ agent: "codex", ok: false, message: "Legacy hook needs manual removal; config preserved." });
          return results;
        }
      }
      results.push({ agent: "codex", ok: true, message: "ARIA hook block removed" });
    } else {
      results.push({ agent: "codex", ok: true, message: "Not installed" });
    }
  } catch (err) {
    results.push({ agent: "codex", ok: false, message: String(err) });
  }

  return results;
}

export function adaptersStatus(): { agent: string; installed: boolean }[] {
  const checks: [string, () => boolean][] = [
    ["gemini", () => hasMarker(JSON.stringify(readJson(path.join(homedir(), ".gemini", "settings.json"))?.hooks?.AfterTool ?? []))],
    [
      "opencode",
      () =>
        fs.existsSync(
          path.join(
            (process.env.OPENCODE_CONFIG_DIR && path.join(process.env.OPENCODE_CONFIG_DIR, "plugins")) ||
              path.join(homedir(), ".config", "opencode", "plugins"),
            "agent-review-watch.ts"
          )
        ),
    ],
    [
      "claude",
      () => {
        const cfg = readJson(path.join(homedir(), ".claude", "settings.json"));
        return hasMarker(JSON.stringify(cfg ?? {}));
      },
    ],
    [
      "cursor",
      () => {
        const cfg = readJson(path.join(homedir(), ".cursor", "hooks.json"));
        return hasMarker(JSON.stringify(cfg ?? {}));
      },
    ],
    [
      "copilot",
      () =>
        hasMarker(JSON.stringify(readJson(path.join(homedir(), ".copilot", "hooks", "agent-inline-review.json")) ?? {})),
    ],
    [
      "codex",
      () => {
        const p = path.join(homedir(), ".codex", "config.toml");
        if (!fs.existsSync(p)) return false;
        return hasMarker(fs.readFileSync(p, "utf8"));
      },
    ],
  ];
  return checks.map(([agent, fn]) => {
    try { return { agent, installed: fn() && (agent === "opencode" || fs.existsSync(path.join(adapterInstallDir(), "record-event.mjs"))) }; }
    catch { return { agent, installed: false }; }
  });
}

export function storeInfo(): string {
  return globalStoreBase();
}
