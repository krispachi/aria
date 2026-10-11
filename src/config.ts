import * as vscode from "vscode";
import * as path from "node:path";
import type { DirectoryRegistry, DirectoryState } from "./directories";

export const SUPPORTED_AGENTS = ["opencode", "claude", "codex", "cursor", "copilot", "gemini"] as const;
export const AGENT_LABELS: Record<string, string> = { opencode: "OpenCode", claude: "Claude Code", codex: "Codex CLI", cursor: "Cursor CLI", copilot: "GitHub Copilot CLI", gemini: "Gemini CLI" };
export function enabledAgents(): string[] { return SUPPORTED_AGENTS.filter(agent => reviewSetting(`agents.${agent}.enabled`, true)); }
export function agentEnabled(agent?: string): boolean {
  if (SUPPORTED_AGENTS.some(known => known === agent)) return reviewSetting(`agents.${agent}.enabled`, true);
  // Old hooks have no producer tag. Once a source is disabled, ambiguous events
  // cannot safely be attributed; reinstall adapters to get tagged events.
  return enabledAgents().length === SUPPORTED_AGENTS.length;
}

export function reviewSetting<T>(key: string, fallback: T): T {
  for (const namespace of ["aria", "agentInlineReview", "opencodeInlineReview"]) {
    const config = vscode.workspace.getConfiguration(namespace);
    const value = config.inspect<T>(key);
    if (value?.workspaceFolderValue !== undefined || value?.workspaceValue !== undefined || value?.globalValue !== undefined) {
      return config.get<T>(key, fallback);
    }
  }
  return vscode.workspace.getConfiguration("aria").get<T>(key, fallback);
}

// The user's own value (folder > workspace > user) across legacy namespaces, ignoring defaults.
// VS Code invents a default (false) for boolean settings without one, so get() cannot tell them apart.
function userValue<T>(key: string): T | undefined {
  for (const namespace of ["aria", "agentInlineReview", "opencodeInlineReview"]) {
    const value = vscode.workspace.getConfiguration(namespace).inspect<T>(key);
    const explicit = value?.workspaceFolderValue ?? value?.workspaceValue ?? value?.globalValue;
    if (explicit !== undefined) return explicit;
  }
}

export type ActionLocation = "statusBar" | "editorToolbar" | "both" | "hidden";
export const ACTION_LOCATIONS: ActionLocation[] = ["statusBar", "editorToolbar", "both", "hidden"];
export function actionLocation(kind: "file" | "all"): ActionLocation {
  const key = kind === "file" ? "fileActionsLocation" : "allActionsLocation";
  // An explicit false on the deprecated toggles keeps hiding the buttons until the new setting is chosen.
  const value = userValue<ActionLocation>(key);
  if (value === undefined && userValue<boolean>(kind === "file" ? "showFileActions" : "showAllActions") === false) return "hidden";
  return value && ACTION_LOCATIONS.includes(value) ? value : "statusBar";
}

interface SettingSchema { type: string; enum?: unknown[]; minimum?: number; maximum?: number; items?: { type: string }; default?: unknown; scope?: string }
type Schemas = Record<string, SettingSchema>;
export interface SettingsBundle { format: "aria-settings"; version: 1; settings: Record<string, unknown>; directories?: Record<string, DirectoryState> }
const MAX_SETTINGS_BYTES = 256 * 1024;
// Settings are contributed as titled categories (an array) for the Settings UI.
export function settingSchemas(packageJSON: { contributes: { configuration: { properties?: Schemas } | Array<{ properties?: Schemas }> } }): Schemas {
  const configuration = packageJSON.contributes.configuration;
  return Object.assign({}, ...(Array.isArray(configuration) ? configuration : [configuration]).map(section => section.properties ?? {}));
}
function schemas(context: vscode.ExtensionContext): Schemas { return settingSchemas(context.extension.packageJSON); }
export function validateSettingsBundle(value: unknown, definitions: Schemas): SettingsBundle {
  const bundle = value as SettingsBundle;
  const record = (item: unknown): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item);
  if (!record(bundle) || bundle.format !== "aria-settings" || bundle.version !== 1 || !record(bundle.settings)) throw new Error("Not a supported ARIA settings export.");
  const settings: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(bundle.settings)) {
    const definition = Object.hasOwn(definitions, key) && definitions[key];
    if (!key.startsWith("aria.") || !definition) throw new Error(`Unknown ARIA setting: ${key}`);
    const valid = definition.type === "array" ? Array.isArray(value) && value.length <= 256 && value.every(item => typeof item === "string" && item.length <= 2048) :
      definition.type === "integer" ? typeof value === "number" && Number.isInteger(value) : typeof value === definition.type;
    if (!valid || (typeof value === "string" && value.length > 4096) ||
      (definition.enum && !definition.enum.includes(value)) ||
      (typeof value === "number" && (!Number.isFinite(value) || (definition.minimum !== undefined && value < definition.minimum) || (definition.maximum !== undefined && value > definition.maximum)))) throw new Error(`Invalid value for ${key}`);
    settings[key] = value;
  }
  let directories: Record<string, DirectoryState> | undefined;
  if (bundle.directories !== undefined) {
    if (!record(bundle.directories) || Object.keys(bundle.directories).length > 1000) throw new Error("Invalid directory preferences.");
    directories = {};
    for (const [root, state] of Object.entries(bundle.directories)) {
      if (!path.isAbsolute(root) || root.length > 4096 || !record(state) || Object.keys(state).some(key => !["initialized", "enabled"].includes(key)) || Object.values(state).some(value => typeof value !== "boolean")) throw new Error("Invalid directory preference entry.");
      directories[root] = { ...state };
    }
  }
  return { format: "aria-settings", version: 1, settings, ...(directories ? { directories } : {}) };
}
export async function exportSettings(context: vscode.ExtensionContext, directories: DirectoryRegistry): Promise<boolean> {
  try {
    const scope = await vscode.window.showQuickPick([
      { label: "Settings only", directories: false, description: "Portable ARIA preferences; no directory list" },
      { label: "Settings and directory preferences", directories: true, description: "Includes absolute paths and per-directory Init/Enable/Disable choices" },
    ], { placeHolder: "Choose what to export. No source code, hooks or review history are included." });
    if (!scope) return false;
    const uri = await vscode.window.showSaveDialog({ title: "Export ARIA settings", saveLabel: "Export", filters: { JSON: ["json"] } });
    if (!uri) return false;
    const settings = Object.fromEntries(Object.entries(schemas(context)).filter(([key, definition]) => key.startsWith("aria.") && definition.default !== undefined).map(([key, definition]) => [key, reviewSetting(key.slice(5), definition.default)]));
    const bundle = validateSettingsBundle({ format: "aria-settings", version: 1, settings, ...(scope.directories ? { directories: directories.exportState() } : {}) }, schemas(context));
    const content = Buffer.from(JSON.stringify(bundle, null, 2) + "\n");
    if (content.length > MAX_SETTINGS_BYTES) throw new Error("Settings export exceeds 256 KB.");
    await vscode.workspace.fs.writeFile(uri, content);
    await vscode.window.showInformationMessage("ARIA settings exported. Keep this file to restore preferences after reinstalling.");
    return true;
  } catch (error) { await vscode.window.showErrorMessage(`ARIA could not export settings: ${String(error)}`); return false; }
}
export async function importSettings(context: vscode.ExtensionContext, directories: DirectoryRegistry): Promise<boolean> {
  try {
    const selected = await vscode.window.showOpenDialog({ title: "Import ARIA settings", canSelectMany: false, canSelectFolders: false, filters: { JSON: ["json"] } });
    if (!selected?.[0]) return false;
    if ((await vscode.workspace.fs.stat(selected[0])).size > MAX_SETTINGS_BYTES) throw new Error("Settings import exceeds 256 KB.");
    const data = await vscode.workspace.fs.readFile(selected[0]);
    if (data.byteLength > MAX_SETTINGS_BYTES) throw new Error("Settings import exceeds 256 KB.");
    const definitions = schemas(context);
    const bundle = validateSettingsBundle(JSON.parse(Buffer.from(data).toString("utf8").replace(/^\uFEFF/, "")), definitions);
    const choice = await vscode.window.showQuickPick([
      { label: "User settings", target: vscode.ConfigurationTarget.Global },
      ...(vscode.workspace.workspaceFolders?.length ? [{ label: "Workspace settings", target: vscode.ConfigurationTarget.Workspace }] : []),
    ], { placeHolder: "Where should ARIA preferences be imported? Workspace overrides may take priority over User settings." });
    if (!choice) return false;
    const entries = Object.entries(bundle.settings);
    const directoryCount = Object.keys(bundle.directories ?? {}).length;
    if (await vscode.window.showWarningMessage(`Import ${entries.length} ARIA settings${directoryCount ? ` and merge ${directoryCount} directory preferences` : ""}? Existing unrelated settings stay unchanged. Application-wide options apply to User settings.`, { modal: true }, "Import") !== "Import") return false;
    const config = vscode.workspace.getConfiguration("aria");
    const changed: Array<{ key: string; value: unknown; target: vscode.ConfigurationTarget }> = [];
    const oldDirectories = directories.exportState();
    try {
      for (const [fullKey, value] of entries) {
        const key = fullKey.slice(5);
        const target = definitions[fullKey].scope === "application" ? vscode.ConfigurationTarget.Global : choice.target;
        const old = config.inspect(key);
        changed.push({ key, target, value: target === vscode.ConfigurationTarget.Global ? old?.globalValue : old?.workspaceValue });
        await config.update(key, value, target);
      }
      if (bundle.directories) await directories.mergeState(bundle.directories);
    } catch (error) {
      const failures: unknown[] = [];
      for (const item of changed.reverse()) try { await config.update(item.key, item.value, item.target); } catch (failure) { failures.push(failure); }
      try { await context.globalState.update("ariaDirectories", oldDirectories); } catch (failure) { failures.push(failure); }
      if (failures.length) throw new Error(`${String(error)}. Some settings could not be rolled back; check ARIA Settings.`);
      throw error;
    }
    await vscode.window.showInformationMessage("ARIA settings imported. Keyboard shortcuts use VS Code's Keyboard Shortcuts editor and are not included in this export.");
    return true;
  } catch (error) { await vscode.window.showErrorMessage(`ARIA could not import settings: ${String(error)}`); return false; }
}
