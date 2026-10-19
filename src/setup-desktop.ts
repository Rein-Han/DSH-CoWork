#!/usr/bin/env node
/**
 * `setup-desktop` — the single installer entry point for the private build.
 *
 * It registers the `dsh_desktop` MCP server with Codex, Claude Code, or ZCode and
 * installs the matching caller skill. Only this project's own entries are
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

export type Caller = "codex" | "claude" | "zcode" | "both";
export type Scope = "user" | "project";

export const SERVER_NAME = "dsh_desktop";
export const LEGACY_SERVER_NAMES = ["dsh_agentlink", "dsh_collab"] as const;
const SKILL_NAMES = { codex: "codex-dsh-desktop", claude: "claude-dsh-desktop", zcode: "zcode-dsh-desktop" } as const;

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
}

interface PlannedWrite {
  caller: "codex" | "claude" | "zcode";
  kind: "mcp-config" | "skill";
  target: string;
  description: string;
  before: "absent" | "identical" | "differs";
  content?: string;
  /** Files to copy for a skill install. */
  copyFrom?: string;
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
        if (value !== "codex" && value !== "claude" && value !== "zcode" && value !== "both") {
          throw new Error(`--caller must be codex, claude, zcode, or both, received ${value}`);
        }
        options.caller = value;
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
  return options;
}

/** Resolve the compiled entry script for this package. */
export function defaultEntry(): string {
  return fileURLToPath(new URL("./index.js", import.meta.url));
}

/** The non-secret environment every installed server entry receives. */
export function bridgeEnvironment(connectionFile: string, caller: "codex" | "claude" | "zcode"): Record<string, string> {
  return {
    DSH_HOST_MODE: "desktop-paired",
    DSH_CONNECTION_FILE: connectionFile,
    DSH_BRIDGE_HOME: join(process.env.LOCALAPPDATA ?? homedir(), "DSHDesktopCowork", "bridge"),
    DSH_CALLER_KIND: caller === "claude" ? "claude-code" : caller,
    DSH_APPROVAL_MODE: "desktop",
    DSH_MODEL_POLICY: "inherit",
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

/** Where a caller's skill directory lives for one scope. */
export function skillTarget(caller: "codex" | "claude" | "zcode", scope: Scope, projectDir: string): string {
  const name = SKILL_NAMES[caller];
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
    "tool_timeout_sec = 120",
    `env = { ${Object.entries(env).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join(", ")} }`,
    "",
  ].join("\n");
}

/** The table header this build owns; the whole table is replaced on update. */
export const CODEX_TABLE_HEADER = `[mcp_servers.${SERVER_NAME}]`;

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
  const merged = [...head, ...block.replace(/\s+$/u, "").split("\n"), ...tail].join("\n");
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
  else table[SERVER_NAME] = entry;
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
  else servers[SERVER_NAME] = entry;
  return `${JSON.stringify({ ...parsed, mcp: { ...mcp, servers } }, null, 2)}\n`;
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
function classifyExisting(caller: "codex" | "claude" | "zcode", before: string | undefined, rendered: string): PlannedWrite["before"] {
  if (before === undefined) return "absent";
  if (before.trimEnd() === rendered.trimEnd()) return "identical";
  return hasOwnEntry(caller, before) ? "differs" : "absent";
}

/** Whether the file already carries a `dsh_desktop` entry. */
function hasOwnEntry(caller: "codex" | "claude" | "zcode", content: string): boolean {
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

  const callers: Array<"codex" | "claude" | "zcode"> =
    options.caller === "both" ? ["codex", "claude"] : [options.caller];
  for (const caller of callers) {
    const env = bridgeEnvironment(desktop.connectionFile ?? "<DSH_CONNECTION_FILE>", caller);
    const configPath = caller === "codex"
      ? codexConfigPath(options.scope, options.projectDir)
      : caller === "zcode" ? zcodeConfigPath(options.scope, options.projectDir) : claudeConfigPath(options.scope, options.projectDir);
    const before = await readFile(configPath, "utf8").catch(() => undefined);
    const applyJsonEntry = caller === "zcode" ? applyZcodeEntry : applyClaudeEntry;
    const rendered =
      caller === "codex"
        ? applyCodexTable(before ?? "", options.uninstall ? undefined : renderCodexBlock(nodePath, entryPath, env))
        : applyJsonEntry(
            before,
            options.uninstall
              ? undefined
              : { type: "stdio", command: nodePath, args: [entryPath], env },
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
    if (write.kind === "mcp-config") {
      if (write.before === "identical") {
        lines.push(`${write.caller}: ${write.target} already matches; no change`);
        continue;
      }
      if (write.before === "differs" && plan.options.replace !== true && plan.options.uninstall !== true) {
        refused.push(
          `${write.caller}: ${write.target} already contains a different ${SERVER_NAME} entry; rerun with --replace to overwrite just that entry`,
        );
        continue;
      }
      if (!plan.options.apply) {
        lines.push(`${write.caller}: would write ${write.target} (${write.description})`);
        continue;
      }
      const snapshot = await readConfigSnapshot(write.target);
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





