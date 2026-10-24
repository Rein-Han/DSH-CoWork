#!/usr/bin/env node
/**
 * `setup-desktop` — the single installer entry point for the private build.
 *
 * It registers Codex, Claude Code, ZCode, or Kimi Code and their caller skill;
 * Kimi Work receives MCP form settings and a separate skill export. Own entries are
 * touched, every changed file is backed up with its hash recorded, a second run
 * is a no-op, and nothing that carries the launch token is ever written into a
 * configuration file.
 *
 * Usage:
 *   setup-desktop --caller both --scope user --dry-run
 *   setup-desktop --caller both --scope user --apply
 *   setup-desktop --caller codex --scope project --apply
 *   setup-desktop --uninstall --dry-run|--apply
 */

import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

import { atomicInstallText, readConfigSnapshot } from "./setup-engine.js";
import { inspectDesktopHost } from "./desktop/doctor-desktop.js";

export type DesktopCaller = "codex" | "claude" | "zcode" | "kimi-code" | "kimi-work";
export type Caller = DesktopCaller | "both";
export type Scope = "user" | "project";

export const SERVER_NAME = "dsh_desktop";
export const LEGACY_SERVER_NAMES = ["dsh_agentlink", "dsh_collab"] as const;
const SKILL_NAMES = { codex: "codex-dsh-desktop", claude: "claude-dsh-desktop", zcode: "zcode-dsh-desktop", "kimi-code": "kimi-code-dsh-desktop", "kimi-work": "kimi-work-dsh-desktop" } as const;
export const BOUNDED_CALLERS: readonly DesktopCaller[] = ["zcode", "kimi-code", "kimi-work"];

export interface SetupOptions {
  caller: Caller;
  scope: Scope;
  dryRun: boolean;
  apply: boolean;
  replace: boolean;
  uninstall: boolean;
  projectDir: string;
  /** Override the entry script; defaults to this package's compiled index.js. */
  entry?: string;
  waitProfile?: "bounded" | "long";
  /** Kimi Work exports MCP form settings and a separate skill-only plugin source. */
  outputDir?: string;
}

interface PlannedWrite {
  caller: DesktopCaller;
  kind: "mcp-config" | "export" | "skill";
  target: string;
  description: string;
  before: "absent" | "identical" | "differs";
  content?: string;
  /** Files to copy for a skill install. */
  copyFrom?: string;
  expectedBefore?: string | null;
}

export interface PlanReport {
  options: SetupOptions;
  writes: PlannedWrite[];
  warnings: string[];
  nodePath: string;
  entryPath: string;
  env: Record<string, string>;
  desktop: Awaited<ReturnType<typeof inspectDesktopHost>>;
}

/** Parse the CLI surface. */
export function parseArgs(argv: readonly string[]): SetupOptions {
  const options: SetupOptions = {
    caller: "both",
    scope: "user",
    dryRun: false,
    apply: false,
    replace: false,
    uninstall: false,
    projectDir: process.cwd(),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = (): string => {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${String(arg)} requires a value`);
      index += 1;
      return value;
    };
    switch (arg) {
      case "--caller": {
        const value = next();
        if (!["codex", "claude", "zcode", "kimi-code", "kimi-work", "both"].includes(value)) {
          throw new Error(`--caller must be codex, claude, zcode, kimi-code, kimi-work, or both, received ${value}`);
        }
        options.caller = value as Caller;
        break;
      }
      case "--scope": {
        const value = next();
        if (value !== "user" && value !== "project") throw new Error(`--scope must be user or project, received ${value}`);
        options.scope = value;
        break;
      }
      case "--project":
        options.projectDir = resolve(next());
        break;
      case "--entry":
        options.entry = resolve(next());
        break;
      case "--output":
        options.outputDir = resolve(next());
        break;
      case "--wait-profile": {
        const value = next();
        if (value !== "bounded" && value !== "long") throw new Error("--wait-profile must be bounded or long");
        options.waitProfile = value;
        break;
      }
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--apply":
        options.apply = true;
        break;
      case "--replace":
        options.replace = true;
        break;
      case "--uninstall":
        options.uninstall = true;
        break;
      default:
        throw new Error(`unknown argument ${String(arg)}`);
    }
  }
  if (options.dryRun && options.apply) throw new Error("choose either --dry-run or --apply, not both");
  if (!options.dryRun && !options.apply) options.dryRun = true;
  validateCallerOptions(options);
  return options;
}

function validateCallerOptions(options: SetupOptions): void {
  if (options.caller !== "both" && BOUNDED_CALLERS.includes(options.caller) && options.waitProfile === "long") {
    throw new Error(`${options.caller} supports bounded waits only; native long-call acceptance and rollback are not yet verified`);
  }
  if (options.outputDir && options.caller !== "kimi-work") throw new Error("--output is only for the Kimi Work setup export");
  if (options.caller === "kimi-work" && (options.scope === "project" || options.uninstall)) {
    throw new Error("Kimi Work uses its MCP settings UI and a separate skill: export with --output, then add/remove them through the client; no project config is written");
  }
}

/** Resolve the compiled entry script for this package. */
export function defaultEntry(): string {
  return fileURLToPath(new URL("./index.js", import.meta.url));
}

/** The non-secret environment every installed server entry receives. */
export function bridgeEnvironment(connectionFile: string, caller: DesktopCaller): Record<string, string> {
  return {
    DSH_HOST_MODE: "desktop-paired",
    DSH_CONNECTION_FILE: connectionFile,
    DSH_BRIDGE_HOME: join(process.env.LOCALAPPDATA ?? homedir(), "DSHDesktopCowork", "bridge"),
    DSH_CALLER_KIND: caller === "claude" ? "claude-code" : caller,
    DSH_APPROVAL_MODE: "desktop",
    DSH_MODEL_POLICY: "inherit",
    ...(BOUNDED_CALLERS.includes(caller) ? { DSH_WAIT_PROFILE: "bounded" } : {}),
  };
}

/** Where Codex keeps its MCP configuration. */
export function codexConfigPath(scope: Scope, projectDir: string): string {
  if (scope === "project") return join(projectDir, ".codex", "config.toml");
  const home = process.env.CODEX_HOME?.trim();
  return join(home === undefined || home === "" ? join(homedir(), ".codex") : home, "config.toml");
}

/** Where Claude Code keeps its user-level MCP configuration. */
export function claudeConfigPath(scope: Scope, projectDir: string): string {
  return scope === "project" ? join(projectDir, ".mcp.json") : join(homedir(), ".claude.json");
}

/** Where ZCode keeps its MCP configuration. */
export function zcodeConfigPath(scope: Scope, projectDir: string): string {
  return scope === "project" ? join(projectDir, ".zcode", "config.json") : join(homedir(), ".zcode", "cli", "config.json");
}

export function kimiCodeHome(): string {
  return resolve(process.env.KIMI_CODE_HOME?.trim() || join(homedir(), ".kimi-code"));
}

/** Kimi Code desktop and current CLI use the same engine configuration. */
export function kimiCodeConfigPath(scope: Scope, projectDir: string): string {
  return join(scope === "project" ? join(projectDir, ".kimi-code") : kimiCodeHome(), "mcp.json");
}

/** Where a caller's skill directory lives for one scope. */
export function skillTarget(caller: DesktopCaller, scope: Scope, projectDir: string): string {
  const name = SKILL_NAMES[caller];
  if (caller === "kimi-work") throw new Error("Kimi Work skills are inside the exported plugin, not a guessed global skill directory");
  if (caller === "kimi-code") return join(scope === "project" ? join(projectDir, ".kimi-code") : kimiCodeHome(), "skills", name);
  if (caller === "zcode") {
    return join(scope === "project" ? projectDir : homedir(), ".zcode", "skills", name);
  }
  if (caller === "codex") {
    return scope === "project" ? join(projectDir, ".agents", "skills", name) : join(homedir(), ".agents", "skills", name);
  }
  return scope === "project" ? join(projectDir, ".claude", "skills", name) : join(homedir(), ".claude", "skills", name);
}

/** Render the Codex TOML block for this project's server entry. */
export function renderCodexBlock(nodePath: string, entry: string, env: Record<string, string>): string {
  const envLines = Object.entries(env)
    .map(([key, value]) => `${key} = ${JSON.stringify(value)}`)
    .join("\n");
  return [
    `[mcp_servers.${SERVER_NAME}]`,
    `command = ${JSON.stringify(nodePath)}`,
    `args = [${JSON.stringify(entry)}]`,
    "startup_timeout_sec = 60",
    `tool_timeout_sec = ${env.DSH_WAIT_PROFILE === "long" ? 960 : 120}`,
    `env = { ${Object.entries(env).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join(", ")} }`,
    "",
  ].join("\n");
}

/** The table header this build owns; the whole table is replaced on update. */
export const CODEX_TABLE_HEADER = `[mcp_servers.${SERVER_NAME}]`;

function mergeInlineEnv(oldValue: string, newValue: string): string {
  const parse = (value: string) => {
    const entries = new Map<string, string>();
    const body = value.trim().replace(/^\{/, "").replace(/\}\s*(?:#.*)?$/, "");
    const rest = body.replace(/([A-Za-z0-9_]+)\s*=\s*("(?:\\.|[^"\\])*"|'[^']*')/g, (_, key: string, literal: string) => {
      if (entries.has(key)) throw new Error("duplicate environment key; review configuration manually");
      entries.set(key, literal); return "";
    });
    if (rest.replace(/[,\s]/g, "") !== "") throw new Error("unsupported TOML environment syntax; configuration was not changed");
    return entries;
  };
  const merged = parse(oldValue);
  for (const [k, v] of parse(newValue)) merged.set(k, v);
  return `{ ${[...merged].map(([k, v]) => `${k} = ${v}`).join(", ")} }`;
}

/**
 * Upsert or remove this build's Codex table without touching any other table.
 * @param content - current file content.
 * @param block - new table text, or undefined to remove the table.
 * @returns the updated content.
 */
export function applyCodexTable(content: string, block: string | undefined): string {
  const lines = content.split(/\r?\n/u);
  const start = lines.findIndex((line) => line.trim() === CODEX_TABLE_HEADER);
  if (start === -1) {
    if (block === undefined) return content;
    const prefix = content.trimEnd();
    return `${prefix === "" ? "" : `${prefix}\n\n`}${block}`;
  }
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/u.test(lines[end] ?? "")) end += 1;
  const head = lines.slice(0, start);
  const tail = lines.slice(end);
  if (block === undefined) {
    const merged = [...head, ...tail].join("\n").replace(/\n{3,}/gu, "\n\n").trimEnd();
    return merged === "" ? "" : `${merged}\n`;
  }
  const existing = lines.slice(start + 1, end);
  const incoming = block.trimEnd().split("\n").slice(1);
  // Preserve user-owned settings and env variables, including approval/allowlists.
  for (const line of incoming) {
    const match = /^([A-Za-z_]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1]!;
    const index = existing.findIndex(row => new RegExp(`^\\s*${key}\\s*=`).test(row));
    if (index < 0) { existing.push(line); continue; }
    if (key === "env") {
      existing[index] = `env = ${mergeInlineEnv(existing[index]!.replace(/^\s*env\s*=\s*/, ""), match[2]!)}`;
    } else if (key === "command" || key === "args") {
      existing[index] = line;
    } else if (key === "tool_timeout_sec" && /DSH_WAIT_PROFILE = "long"/.test(block)) {
      const prior = Number(existing[index]!.split("=")[1]?.split("#")[0]?.trim());
      if (!Number.isFinite(prior)) throw new Error("unsupported tool_timeout_sec syntax; configuration was not changed");
      existing[index] = `tool_timeout_sec = ${Math.max(prior, 960)}`;
    }
  }
  if (tail.some(row => row.trim() === `[mcp_servers.${SERVER_NAME}.env]`)) {
    throw new Error("nested dsh_desktop.env table requires manual merge; configuration was not changed");
  }
  const merged = [...head, CODEX_TABLE_HEADER, ...existing, ...tail].join("\n");
  return `${merged.replace(/\n{3,}/gu, "\n\n").trimEnd()}\n`;
}

/**
 * Upsert or remove this build's entry in a Claude JSON config without touching
 * any sibling key.
 * @param content - current file content, or undefined when absent.
 * @param entry - server entry, or undefined to remove it.
 * @returns the updated JSON text.
 */
export function applyClaudeEntry(content: string | undefined, entry: Record<string, unknown> | undefined): string {
  let parsed: Record<string, unknown> = {};
  if (content !== undefined && content.trim() !== "") {
    const value: unknown = JSON.parse(content);
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("the target Claude configuration is not a JSON object");
    }
    parsed = value as Record<string, unknown>;
  }
  const servers = parsed.mcpServers;
  const table =
    servers === undefined || servers === null
      ? {}
      : (typeof servers === "object" && !Array.isArray(servers) ? { ...(servers as Record<string, unknown>) } : undefined);
  if (table === undefined) throw new Error("the target Claude configuration has a non-object mcpServers entry");
  if (entry === undefined) delete table[SERVER_NAME];
  else {
    const previous = table[SERVER_NAME];
    if (previous !== undefined && (previous === null || typeof previous !== "object" || Array.isArray(previous))) throw new Error("dsh_desktop entry is not an object");
    const old = (previous ?? {}) as Record<string, unknown>;
    if (old.env !== undefined && (old.env === null || typeof old.env !== "object" || Array.isArray(old.env))) throw new Error("dsh_desktop env is not an object");
    const merged: Record<string, unknown> = { ...old, ...entry, env: { ...(old.env as object ?? {}), ...(entry.env as object ?? {}) } };
    if ((entry.env as Record<string, unknown> | undefined)?.DSH_WAIT_PROFILE === "long") {
      if (old.timeout !== undefined && (typeof old.timeout !== "number" || !Number.isFinite(old.timeout) || old.timeout < 0)) {
        throw new Error("unsupported Claude per-server timeout; configuration was not changed");
      }
      merged.timeout = Math.max(typeof old.timeout === "number" ? old.timeout : 0, 960_000);
    }
    table[SERVER_NAME] = merged;
  }
  return `${JSON.stringify({ ...parsed, mcpServers: table }, null, 2)}\n`;
}

/** Preserve ZCode settings and sibling servers while updating this server. */
export function applyZcodeEntry(content: string | undefined, entry: Record<string, unknown> | undefined): string {
  const object = (value: unknown, label: string): Record<string, unknown> => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`the target ZCode ${label} is not a JSON object`);
    }
    return value as Record<string, unknown>;
  };
  const parsed = content === undefined || content.trim() === "" ? {} : object(JSON.parse(content), "configuration");
  const mcp = parsed.mcp === undefined ? {} : object(parsed.mcp, "mcp entry");
  const servers = { ...(mcp.servers === undefined ? {} : object(mcp.servers, "mcp.servers entry")) };
  if (entry === undefined) delete servers[SERVER_NAME];
  else servers[SERVER_NAME] = mergeJsonServer(servers[SERVER_NAME], entry);
  return `${JSON.stringify({ ...parsed, mcp: { ...mcp, servers } }, null, 2)}\n`;
}

function jsonObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is not a JSON object`);
  return value as Record<string, unknown>;
}

/** Keep caller-owned allowlists, enabled flags, timeout and extra environment. */
function mergeJsonServer(previous: unknown, entry: Record<string, unknown>): Record<string, unknown> {
  const old = previous === undefined ? {} : jsonObject(previous, "dsh_desktop entry");
  const oldEnv = old.env === undefined ? {} : jsonObject(old.env, "dsh_desktop env");
  const newEnv = entry.env === undefined ? {} : jsonObject(entry.env, "new dsh_desktop env");
  return { ...old, ...entry, env: { ...oldEnv, ...newEnv } };
}

export function applyKimiCodeEntry(content: string | undefined, entry: Record<string, unknown> | undefined): string {
  const parsed = content === undefined || content.trim() === "" ? {} : jsonObject(JSON.parse(content), "Kimi Code configuration");
  const servers = { ...(parsed.mcpServers === undefined ? {} : jsonObject(parsed.mcpServers, "mcpServers")) };
  if (entry === undefined) delete servers[SERVER_NAME];
  else {
    const merged = mergeJsonServer(servers[SERVER_NAME], entry);
    // Existing explicit timeouts are user-owned. Only set a margin for a new entry.
    if (merged.toolTimeoutMs === undefined) merged.toolTimeoutMs = 120_000;
    servers[SERVER_NAME] = merged;
  }
  return `${JSON.stringify({ ...parsed, mcpServers: servers }, null, 2)}\n`;
}

/** Hash a file's content for the delivery record. */
export async function fileHash(path: string): Promise<string | undefined> {
  try {
    return createHash("sha256").update(await readFile(path)).digest("hex").slice(0, 16);
  } catch {
    return undefined;
  }
}

/** Whether a path exists. */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Classify the existing state of this build's entry.
 *
 * `absent` covers both a missing file and a file that simply has no
 * `dsh_desktop` entry yet - both are a plain, safe upsert. `differs` means the
 * entry already exists with other content, which needs an explicit `--replace`.
 */
function classifyExisting(caller: DesktopCaller, before: string | undefined, rendered: string): PlannedWrite["before"] {
  if (before === undefined) return "absent";
  if (before.trimEnd() === rendered.trimEnd()) return "identical";
  return hasOwnEntry(caller, before) ? "differs" : "absent";
}

/** Whether the file already carries a `dsh_desktop` entry. */
function hasOwnEntry(caller: DesktopCaller, content: string): boolean {
  if (caller === "codex") return content.includes(CODEX_TABLE_HEADER);
  try {
    const parsed = JSON.parse(content) as { mcpServers?: Record<string, unknown>; mcp?: { servers?: Record<string, unknown> } };
    const servers = caller === "zcode" ? parsed.mcp?.servers : parsed.mcpServers;
    return servers !== undefined && servers !== null && SERVER_NAME in servers;
  } catch {
    return false;
  }
}

/**
 * Build the reviewable plan: what would change, and why anything is refused.
 * @param options - parsed CLI options.
 * @returns the plan.
 */
export async function buildPlan(options: SetupOptions): Promise<PlanReport> {
  validateCallerOptions(options);
  const nodePath = process.execPath;
  const entryPath = options.entry ?? defaultEntry();
  const desktop = await inspectDesktopHost();
  const warnings: string[] = [];
  const writes: PlannedWrite[] = [];

  if (!(await exists(entryPath))) {
    warnings.push(`bridge entry script not found at ${entryPath}; run npm run build first`);
  }
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (!Number.isInteger(nodeMajor) || nodeMajor < 22) {
    warnings.push(`the bridge requires Node.js 22 or newer; this process is ${process.versions.node}`);
  }
  if (desktop.connectionFile === undefined) {
    warnings.push("no connection file is configured yet; the connector must run once to publish it");
  } else if (!desktop.connection.exists) {
    warnings.push(
      `no published connection at ${desktop.connectionFile}: install the dsh-desktop-cowork-connector bundle into the Desktop profile and restart the app`,
    );
  }
  if (desktop.legacyEntries.length > 0) {
    warnings.push(
      `legacy bridge entries are still configured (${desktop.legacyEntries.join(", ")}); the skill is told to use dsh_desktop only and will not call them`,
    );
  }

  if (options.caller === "kimi-work") {
    const output = options.outputDir ?? join(options.projectDir, "artifacts", "kimi-work-dsh-desktop");
    const env = bridgeEnvironment(desktop.connectionFile ?? "<DSH_CONNECTION_FILE>", "kimi-work");
    const manifest = {
      name: "dsh-cowork", version: "0.1.0", description: "Delegate to the running local DSH Desktop and verify results",
      skills: "./skills/",
    };
    // Installed Work 3.2.15 rejects local manifests containing MCP declarations.
    // Keep the user-level MCP form settings separate from the skill-only source.
    const settings = { mcpServers: { [SERVER_NAME]: { transport: "stdio", command: nodePath, args: [entryPath], env, startupTimeoutMs: 60_000, toolTimeoutMs: 120_000 } } };
    for (const [name, value] of [["kimi.plugin.json", manifest], ["mcp-settings.json", settings]] as const) {
      const target = join(output, name);
      const snapshot = await readConfigSnapshot(target);
      const content = `${JSON.stringify(value, null, 2)}\n`;
      writes.push({ caller: "kimi-work", kind: "export", target, description: "export only; configure MCP and skill separately in Kimi Work",
        before: !snapshot.exists ? "absent" : snapshot.content === content ? "identical" : "differs", content, expectedBefore: snapshot.exists ? snapshot.content : null });
    }
    writes.push({ caller: "kimi-work", kind: "skill", target: join(output, "skills", SKILL_NAMES["kimi-work"]), description: "export Kimi Work skill",
      before: "absent", copyFrom: fileURLToPath(new URL(`../skill/${SKILL_NAMES["kimi-work"]}`, import.meta.url)) });
    warnings.push("Kimi Work 3.2.15: local MCP plugins/local installation are disabled. Copy mcp-settings.json fields into Plugins > MCP (requires that capability); install the skill through the supported Skills/Plugin Builder path. The skill-only manifest is source material, not an installed plugin. No internal Work config is edited.");
    return { options, writes, warnings, nodePath, entryPath, env: {}, desktop };
  }

  const callers: DesktopCaller[] =
    options.caller === "both" ? ["codex", "claude"] : [options.caller];
  for (const caller of callers) {
    const env = bridgeEnvironment(desktop.connectionFile ?? "<DSH_CONNECTION_FILE>", caller);
    if (options.waitProfile !== undefined) env.DSH_WAIT_PROFILE = options.waitProfile;
    const configPath = caller === "codex"
      ? codexConfigPath(options.scope, options.projectDir)
      : caller === "zcode" ? zcodeConfigPath(options.scope, options.projectDir)
      : caller === "kimi-code" ? kimiCodeConfigPath(options.scope, options.projectDir) : claudeConfigPath(options.scope, options.projectDir);
    const configSnapshot = await readConfigSnapshot(configPath);
    const before = configSnapshot.exists ? configSnapshot.content : undefined;
    const applyJsonEntry = caller === "zcode" ? applyZcodeEntry : caller === "kimi-code" ? applyKimiCodeEntry : applyClaudeEntry;
    const rendered =
      caller === "codex"
        ? applyCodexTable(before ?? "", options.uninstall ? undefined : renderCodexBlock(nodePath, entryPath, env))
        : applyJsonEntry(
            before,
            options.uninstall
              ? undefined
              : { ...(caller === "kimi-code" ? {} : { type: "stdio" }), command: nodePath, args: [entryPath], env },
          );
    writes.push({
      caller,
      kind: "mcp-config",
      target: configPath,
      description: options.uninstall ? `remove ${SERVER_NAME}` : `register ${SERVER_NAME}`,
      // Uninstalling must never create a configuration file, nor add an empty
      // container to one that never carried this build entry.
      before:
        options.uninstall && (before === undefined || !hasOwnEntry(caller, before))
          ? "identical"
          : classifyExisting(caller, before, rendered),
      content: rendered,
      expectedBefore: before ?? null,
    });

    const source = fileURLToPath(new URL(`../skill/${SKILL_NAMES[caller]}`, import.meta.url));
    const target = skillTarget(caller, options.scope, options.projectDir);
    writes.push({
      caller,
      kind: "skill",
      target,
      description: options.uninstall ? "remove the caller skill" : `install ${SKILL_NAMES[caller]}`,
      before: (await exists(target)) ? "differs" : "absent",
      ...(options.uninstall ? {} : { copyFrom: source }),
    });
  }
  return { options, writes, warnings, nodePath, entryPath, env: {}, desktop };
}

/** Copy a skill directory recursively. */
async function copySkill(source: string, target: string): Promise<string[]> {
  const written: string[] = [];
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory()) {
      await mkdir(to, { recursive: true });
      written.push(...(await copySkill(from, to)));
    } else if (entry.isFile()) {
      await mkdir(dirname(to), { recursive: true });
      const content = await readFile(from);
      const previous = await readFile(to).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (previous?.equals(content)) continue;
      if (previous !== undefined) await copyFile(to, `${to}.bak-dsh-desktop-cowork-${Date.now()}`);
      await copyFile(from, to);
      written.push(to);
    }
  }
  return written;
}

/**
 * Apply (or, with --dry-run, only report) the plan.
 * @param plan - the reviewed plan.
 * @returns one line per action plus the changed paths.
 */
export async function applyPlan(plan: PlanReport): Promise<{ lines: string[]; changed: string[]; refused: string[] }> {
  const lines: string[] = [];
  const changed: string[] = [];
  const refused: string[] = [];
  const refusedCallers = new Set<DesktopCaller>();
  // Without a published descriptor there is no real DSH_CONNECTION_FILE to write;
  // a placeholder entry would install a server that can never start. Refuse the
  // whole install (config and skill) until the connector has published once.
  if (!plan.options.uninstall && plan.desktop.connectionFile === undefined) {
    refused.push(
      "no published connection.json was found: install the connector, restart DSH Desktop, confirm `npm run doctor:desktop` reports published-connection ok, then rerun setup-desktop",
    );
    return { lines, changed, refused };
  }
  for (const write of plan.writes) {
    if (refusedCallers.has(write.caller)) continue;
    if (write.kind === "mcp-config" || write.kind === "export") {
      if (write.before === "identical") {
        lines.push(`${write.caller}: ${write.target} already matches; no change`);
        continue;
      }
      if (write.before === "differs" && plan.options.replace !== true && plan.options.uninstall !== true) {
        refused.push(
          `${write.caller}: ${write.target} already contains a different ${SERVER_NAME} entry; rerun with --replace to overwrite just that entry`,
        );
        refusedCallers.add(write.caller);
        continue;
      }
      if (!plan.options.apply) {
        lines.push(`${write.caller}: would write ${write.target} (${write.description})`);
        continue;
      }
      const snapshot = await readConfigSnapshot(write.target);
      if (write.expectedBefore !== undefined && (snapshot.exists !== (write.expectedBefore !== null) || (snapshot.exists && snapshot.content !== write.expectedBefore))) {
        throw new Error("configuration changed after planning; no replacement was made, rerun setup");
      }
      const result = await atomicInstallText({
        path: write.target,
        content: write.content ?? "",
        expected: snapshot,
        backupLabel: "dsh-desktop-cowork",
      });
      changed.push(write.target);
      lines.push(`${write.caller}: wrote ${write.target}${result.backupPath === undefined ? "" : ` (backup ${result.backupPath})`}`);
      continue;
    }
    if (plan.options.uninstall) {
      if (!(await exists(write.target))) {
        lines.push(`${write.caller}: ${write.target} is already absent`);
        continue;
      }
      if (!plan.options.apply) {
        lines.push(`${write.caller}: would remove ${write.target}`);
        continue;
      }
      await rm(write.target, { recursive: true, force: true });
      await rmdir(dirname(write.target)).catch(() => undefined);
      changed.push(write.target);
      lines.push(`${write.caller}: removed ${write.target}`);
      continue;
    }
    if (write.copyFrom === undefined) continue;
    if (!(await exists(write.copyFrom))) {
      refused.push(`${write.caller}: skill source ${write.copyFrom} is missing; run npm run build first`);
      continue;
    }
    if (!plan.options.apply) {
      lines.push(`${write.caller}: would install skill at ${write.target}`);
      continue;
    }
    const written = await copySkill(write.copyFrom, write.target);
    changed.push(...written);
    lines.push(`${write.caller}: installed ${String(written.length)} skill files at ${write.target}`);
  }
  return { lines, changed, refused };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const plan = await buildPlan(options);
  console.log(`# setup-desktop (${options.dryRun ? "dry-run" : "apply"})`);
  console.log(`node: ${plan.nodePath}`);
  console.log(`entry: ${plan.entryPath}`);
  console.log(
    `desktop: ${(plan.desktop.connection.harnessVersion ?? plan.desktop.desktopVersion) ?? "unknown"} / profile ${plan.desktop.profileKind ?? "unknown"} / connection ${
      plan.desktop.connection.exists ? `published ${String(plan.desktop.connection.ageMs ?? "?")}ms ago` : "absent"
    }`,
  );
  for (const warning of plan.warnings) console.log(`warning: ${warning}`);
  for (const write of plan.writes) {
    console.log(`- ${write.caller} ${write.kind} ${write.target} (current: ${write.before})`);
  }
  const result = await applyPlan(plan);
  for (const line of result.lines) console.log(line);
  for (const refusal of result.refused) console.log(`refused: ${refusal}`);
  // A refusal is a failed install, so it must not look like success to a script.
  if (result.refused.length > 0) process.exitCode = 2;
  if (!options.apply) console.log("no files were changed; rerun with --apply to write this plan");
  else if (result.changed.length === 0) console.log("nothing changed");
  else console.log(`changed ${String(result.changed.length)} paths`);
}

const invokedDirectly = process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  void main().catch((error: unknown) => {
    console.error(`setup-desktop: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}





