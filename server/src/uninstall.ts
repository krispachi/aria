import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const hasMarker = (text: string): boolean =>
  ["aria", "agent-inline-review", "opencode-inline-review"].some(name => text.replace(/\\+/g, "/").includes(name + "/adapters/record-event.mjs"));

export function cleanupRuntime(removeBackups = false): string[] {
  const failures: string[] = [];
  const home = os.homedir();
  const attempt = (operation: () => void) => {
    try { operation(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") failures.push(String(error)); }
  };
  const unlinkOwned = (file: string, owns: (text: string) => boolean) => attempt(() => {
    if (fs.lstatSync(file).isFile() && owns(fs.readFileSync(file, "utf8"))) fs.unlinkSync(file);
  });
  for (const base of new Set([process.env.OIR_STORE_DIR || path.join(home, ".aria"), path.join(home, ".agent-inline-review"), path.join(home, ".opencode-inline-review")])) {
    const root = path.resolve(base);
    if (root === path.parse(root).root || root === path.resolve(home)) { failures.push("Unsafe store root preserved: " + root); continue; }
    try { if (fs.lstatSync(root).isSymbolicLink()) { failures.push("Symlinked store preserved: " + root); continue; } } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") { failures.push(String(error)); continue; } }
    for (const name of ["projects", "adapters", ...(removeBackups ? ["backup"] : [])]) {
      const target = path.resolve(root, name);
      if (path.dirname(target) !== root || path.basename(target) !== name) continue;
      attempt(() => {
        if (!fs.lstatSync(target).isDirectory() || fs.lstatSync(target).isSymbolicLink()) return;
        for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
          const owned = name === "projects" ? /^[a-f0-9]{24}\.jsonl$/.test(entry.name) : name === "adapters" ? ["record-event.mjs", "agent-review-watch.ts", "opencode-review-watch.ts"].includes(entry.name) : /^(?:settings\.json|hooks\.json|config\.toml|agent-inline-review\.json)\.\d+\.bak$/.test(entry.name);
          if (entry.isFile() && owned) attempt(() => fs.unlinkSync(path.join(target, entry.name)));
        }
        if (!fs.readdirSync(target).length) fs.rmdirSync(target);
      });
    }
    attempt(() => { if (!fs.lstatSync(root).isSymbolicLink() && !fs.readdirSync(root).length) fs.rmdirSync(root); });
  }
  const plugins = path.join(process.env.OPENCODE_CONFIG_DIR || path.join(home, ".config", "opencode"), "plugins");
  for (const name of ["agent-review-watch.ts", "opencode-review-watch.ts"]) unlinkOwned(path.join(plugins, name), text => text.includes("OpenCodeReviewWatch") && text.includes("projects") && text.includes("jsonl"));
  for (const file of [path.join(home, ".claude", "settings.json"), path.join(home, ".cursor", "hooks.json"), path.join(home, ".gemini", "settings.json")]) attempt(() => {
    const text = fs.readFileSync(file, "utf8");
    let config: any;
    try { config = JSON.parse(text); } catch { failures.push("Malformed config preserved: " + file); return; }
    if (!config?.hooks || typeof config.hooks !== "object" || Array.isArray(config.hooks)) return;
    let changed = false;
    for (const event of ["PostToolUse", "afterFileEdit", "postToolUse", "AfterTool"]) {
      const entries = config.hooks[event];
      if (!Array.isArray(entries)) continue;
      const cleaned = entries.flatMap((entry: any) => {
        if (Array.isArray(entry?.hooks)) {
          const hooks = entry.hooks.filter((hook: any) => !hasMarker(JSON.stringify(hook) ?? ""));
          if (hooks.length === entry.hooks.length) return [entry];
          changed = true;
          return hooks.length ? [{ ...entry, hooks }] : [];
        }
        if (hasMarker(JSON.stringify(entry) ?? "")) { changed = true; return []; }
        return [entry];
      });
      if (cleaned.length) config.hooks[event] = cleaned; else if (entries.length) delete config.hooks[event];
    }
    if (changed) {
      if (!Object.keys(config.hooks).length) delete config.hooks;
      fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n", "utf8");
    }
  });
  for (const name of ["agent-inline-review.json", "opencode-inline-review.json"]) {
    const file = path.join(home, ".copilot", "hooks", name);
    attempt(() => {
      const text = fs.readFileSync(file, "utf8");
      let config: any;
      try { config = JSON.parse(text); } catch { failures.push("Malformed config preserved: " + file); return; }
      if (!config?.hooks || typeof config.hooks !== "object" || Array.isArray(config.hooks)) return;
      let changed = false;
      for (const [event, entries] of Object.entries(config.hooks)) {
        if (!Array.isArray(entries)) continue;
        const filtered = entries.filter(entry => !hasMarker(JSON.stringify(entry) ?? ""));
        if (filtered.length !== entries.length) { changed = true; if (filtered.length) config.hooks[event] = filtered; else delete config.hooks[event]; }
      }
      if (changed) {
        if (!Object.keys(config.hooks).length && Object.keys(config).every(key => ["version", "hooks"].includes(key))) fs.unlinkSync(file);
        else fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n", "utf8");
      }
    });
  }
  attempt(() => {
    const file = path.join(home, ".codex", "config.toml");
    const text = fs.readFileSync(file, "utf8");
    const cleaned = text.replace(/^# aria inline review begin\r?\n[\s\S]*?^# aria inline review end(?:\r?\n|$)/gm, "");
    if (cleaned !== text) fs.writeFileSync(file, cleaned, "utf8");
  });
  return failures;
}

if (require.main === module) for (const failure of cleanupRuntime()) console.error("ARIA cleanup: " + failure);
