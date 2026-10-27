import { assertEditableServers } from "./toml-edit.js";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { CallerCapabilities, CallerIntegration, InstallPlan, UpsertMcpServerOperation } from "./caller-integration.js";

export const CODEX_CALLER_ID = "codex";
export const CODEX_SERVER_NAME = "dsh_agentlink";
export const CODEX_LEGACY_SERVER_NAMES = ["dsh_collab"] as const;
export const CODEX_BRIDGE_SERVER_NAMES = [CODEX_SERVER_NAME, ...CODEX_LEGACY_SERVER_NAMES] as const;
export const CODEX_RESTART_HINT =
  "Restart Codex to load dsh-Agentlink and discover the repository skill at .agents/skills/codex-dsh-orchestrator. Skill installation does not prove DSH Host connectivity, login, permissions, or end-to-end execution.";

const CODEX_CAPABILITIES: CallerCapabilities = {
  mcpStdio: true,
  configScopes: ["user", "explicit-file"],
  instructionInstall: "native",
  humanApprovalPrompt: "supported",
  legacyMigration: true,
  restartRequired: true,
};

interface RenderMcpConfigBaseOptions {
  entryPath: string;
  nodePath: string;
  dshVersion?: string;
  preset?: string;
}

export type RenderMcpConfigOptions = RenderMcpConfigBaseOptions &
  (
    | {
        hostUrl: string;
        hostMode?: "static";
      }
    | {
        hostMode: "desktop-auto";
        hostUrl?: never;
      }
  );

export type CodexInstallPlanOptions = RenderMcpConfigOptions & {
  configPath: string;
  replace: boolean;
};

function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function renderCodexOperation(operation: UpsertMcpServerOperation): string {
  const env = Object.entries(operation.env).map(([name, value]) => `${name} = ${tomlString(value)}`);
  return [
    `[mcp_servers.${operation.serverName}]`,
    `command = ${tomlString(operation.command)}`,
    `args = [${operation.args.map((argument) => tomlString(argument)).join(", ")}]`,
    "",
    `[mcp_servers.${operation.serverName}.env]`,
    ...env,
    "",
    `[mcp_servers.${operation.serverName}.tools.${operation.humanApproval.toolName}]`,
    `approval_mode = ${tomlString(operation.humanApproval.mode === "human-prompt" ? "prompt" : operation.humanApproval.mode)}`,
  ].join("\n");
}

export function renderMcpConfig(options: RenderMcpConfigOptions): string {
  return renderCodexOperation(createCodexOperation({ ...options, replace: false }));
}

export function hasBridgeConfig(config: string): boolean {
  return assertEditableServers(config, CODEX_BRIDGE_SERVER_NAMES).some(s => s.header && s.table[0] === "mcp_servers" && CODEX_BRIDGE_SERVER_NAMES.includes(s.table[1] as typeof CODEX_BRIDGE_SERVER_NAMES[number]));
}

export function extractBridgeConfig(config: string): string | undefined {
  const sections = assertEditableServers(config, CODEX_BRIDGE_SERVER_NAMES).filter(s => s.header);
  const lines = config.split(/\r?\n/), collected: string[] = [];
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i]!;
    if (s.table[0] === "mcp_servers" && CODEX_BRIDGE_SERVER_NAMES.includes(s.table[1] as typeof CODEX_BRIDGE_SERVER_NAMES[number])) collected.push(...lines.slice(s.start, sections[i+1]?.start ?? lines.length));
  }
  return collected.length ? collected.join("\n").trim() : undefined;
}

function rejectUnsupportedInlineConfig(config: string): void {
  assertEditableServers(config, CODEX_BRIDGE_SERVER_NAMES);
}
function assertBasicTomlTableSyntax(config: string): void {
  assertEditableServers(config, CODEX_BRIDGE_SERVER_NAMES);
}

export function upsertMcpConfig(config: string, bridgeBlock: string, replace: boolean): string {
  rejectUnsupportedInlineConfig(config);
  assertBasicTomlTableSyntax(config);
  const exists = hasBridgeConfig(config);
  if (exists && !replace) {
    throw new Error(
      `Codex MCP server ${CODEX_SERVER_NAME} or legacy ${CODEX_LEGACY_SERVER_NAMES.join(", ")} already exists; rerun with --replace after reviewing it`,
    );
  }

  const lines = config.split(/\r?\n/), removed = new Set<number>();
  const sections = assertEditableServers(config, CODEX_BRIDGE_SERVER_NAMES).filter(s => s.header);
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i]!;
    if (s.table[0] === "mcp_servers" && CODEX_BRIDGE_SERVER_NAMES.includes(s.table[1] as typeof CODEX_BRIDGE_SERVER_NAMES[number])) {
      for (let j = s.start; j < (sections[i+1]?.start ?? lines.length); j++) removed.add(j);
    }
  }
  const kept = lines.filter((_, i) => !removed.has(i));

  const prefix = kept.join("\n").trimEnd();
  return `${prefix === "" ? "" : `${prefix}\n\n`}${bridgeBlock.trim()}\n`;
}

export function defaultCodexConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const configuredRoot = env.CODEX_HOME?.trim();
  return join(configuredRoot === undefined || configuredRoot === "" ? join(homedir(), ".codex") : resolve(configuredRoot), "config.toml");
}

function buildEnv(options: RenderMcpConfigOptions): Record<string, string> {
  return {
    ...(options.hostMode === "desktop-auto"
      ? { DSH_HOST_MODE: "desktop-auto" }
      : { DSH_HOST_URL: options.hostUrl }),
    ...(options.dshVersion === undefined ? {} : { DSH_HOST_VERSION: options.dshVersion }),
    ...(options.preset === undefined ? {} : { DSH_BRIDGE_AGENT_PRESET: options.preset }),
  };
}

function createCodexOperation(options: RenderMcpConfigOptions & { replace: boolean }): UpsertMcpServerOperation {
  return {
    kind: "upsert-mcp-server",
    serverName: CODEX_SERVER_NAME,
    legacyServerNames: CODEX_LEGACY_SERVER_NAMES,
    command: options.nodePath,
    args: [options.entryPath],
    env: buildEnv(options),
    humanApproval: {
      toolName: "dsh_resolve_approval",
      mode: "human-prompt",
    },
    replace: options.replace,
  };
}

export function createCodexInstallPlan(options: CodexInstallPlanOptions): InstallPlan {
  const operation = createCodexOperation(options);
  const targetDescription = "Codex MCP TOML config file";
  return {
    callerId: CODEX_CALLER_ID,
    callerName: "Codex",
    capabilities: CODEX_CAPABILITIES,
    target: {
      path: options.configPath,
      format: "toml",
      scope: options.configPath === defaultCodexConfigPath() ? "user" : "explicit-file",
    },
    targetDescription,
    operations: [operation],
    verification: [{ kind: "mcp-server-block-matches", serverName: CODEX_SERVER_NAME }],
    warnings: [
      `Existing ${CODEX_SERVER_NAME} or legacy ${CODEX_LEGACY_SERVER_NAMES.join(", ")} entries require explicit replacement approval.`,
      "npm run setup installs the shipped Codex skill into the current repository's .agents/skills/codex-dsh-orchestrator directory unless --no-skill is provided.",
      CODEX_RESTART_HINT,
    ],
    restartHint: CODEX_RESTART_HINT,
  };
}

export function verifyCodexMcpBlock(content: string, bridgeBlock: string): boolean {
  try {
    rejectUnsupportedInlineConfig(content);
    assertBasicTomlTableSyntax(content);
  } catch {
    return false;
  }
  return extractBridgeConfig(content) === bridgeBlock.trim();
}

export function verifyCodexMcpConfig(content: string, operation: UpsertMcpServerOperation): boolean {
  return verifyCodexMcpBlock(content, renderCodexOperation(operation));
}

export const codexIntegration: CallerIntegration<CodexInstallPlanOptions> = {
  id: CODEX_CALLER_ID,
  name: "Codex",
  capabilities: CODEX_CAPABILITIES,
  defaultConfigPath(context) {
    return defaultCodexConfigPath(context.env);
  },
  createInstallPlan: createCodexInstallPlan,
  verifyInstalled(content, operation) {
    if (operation.kind !== "upsert-mcp-server") return false;
    return verifyCodexMcpConfig(content, operation);
  },
};
