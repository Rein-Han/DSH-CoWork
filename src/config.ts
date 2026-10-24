import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

export type HostMode = "static" | "desktop-auto" | "desktop-paired";

/** Which calling client this bridge process serves. Display and attribution only — never an authorization claim. */
export type CallerKind = "codex" | "claude-code" | "zcode" | "kimi-code" | "kimi-work" | "unknown";

export interface BridgeConfig {
  hostUrl: string;
  hostMode?: HostMode;
  homeDir: string;
  requestTimeoutMs: number;
  allowRemoteHost: boolean;
  defaultAgentPreset?: string;
  clientTimeZone?: string;
  declaredDshVersion?: string;
  approvalTimeoutMs?: number;
  /** Absolute path of the private descriptor a paired Desktop Host publishes. */
  connectionFile?: string;
  /** Calling client, for display and attribution. Always populated by loadConfig. */
  callerKind?: CallerKind;
  /** Where a Host interaction is answered: only the Desktop UI in this build. */
  approvalMode?: "desktop";
  /** Model policy: inherit the Host's own selection, never override it. */
  modelPolicy?: "inherit";
  /** Opt-in only after the calling client's long-call behaviour has been verified. */
  waitProfile?: "bounded" | "long";
}

const DEFAULT_HOST_URL = "http://127.0.0.1:3080";
const DEFAULT_TIMEOUT_MS = 30_000;

/** Environment variables that would silently re-route model or preset choice. */
const ROUTING_OVERRIDES = ["DSH_BRIDGE_AGENT_PRESET", "DSH_BRIDGE_MODEL_ROUTING", "DSH_MODEL_POLICY"] as const;

export class BridgeConfigError extends Error {
  readonly code = "config_conflict" as const;
  constructor(message: string) {
    super(message);
    this.name = "BridgeConfigError";
  }
}

function booleanEnv(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

function positiveIntegerEnv(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new BridgeConfigError(`expected a positive integer, received ${JSON.stringify(value)}`);
  }
  return parsed;
}

function optionalPositiveIntegerEnv(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  return positiveIntegerEnv(value, 1);
}

function isLoopback(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
}

function normalizeHostUrl(raw: string, allowRemoteHost: boolean): string {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BridgeConfigError(`DSH host URL must use http or https, received ${url.protocol}`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new BridgeConfigError("DSH host URL must not contain credentials");
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new BridgeConfigError("DSH host URL must be an origin without a path, query, or fragment");
  }
  if (!allowRemoteHost && !isLoopback(url.hostname)) {
    throw new BridgeConfigError(
      `refusing non-loopback DSH host ${url.hostname}; set DSH_ALLOW_REMOTE_HOST=true only for a trusted deployment`,
    );
  }
  url.pathname = url.pathname.replace(/\/$/, "");
  return url.toString().replace(/\/$/, "");
}

function detectTimeZone(): string | undefined {
  try {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return timeZone === "" ? undefined : timeZone;
  } catch {
    return undefined;
  }
}

function callerKindOf(raw: string | undefined): CallerKind {
  const value = raw?.trim().toLowerCase();
  if (value === "codex") return "codex";
  if (value === "zcode") return "zcode";
  if (value === "kimi-code" || value === "kimi-work") return value;
  if (value === "claude-code" || value === "claude") return "claude-code";
  return "unknown";
}

/**
 * Refuse a paired configuration that would silently change how the Desktop Host
 * runs. A paired bridge inherits the Host's model, effort, preset, and approval
 * policy; an environment variable that routes any of them is a conflict to
 * report, not a preference to honour.
 */
function assertPairedEnvironmentIsClean(env: NodeJS.ProcessEnv): void {
  if (env.DSH_HOST_URL !== undefined && env.DSH_HOST_URL.trim() !== "") {
    throw new BridgeConfigError(
      "DSH_HOST_MODE=desktop-paired conflicts with DSH_HOST_URL: a paired bridge reads its origin from the private connection file and never from a configured URL",
    );
  }
  if (booleanEnv(env.DSH_ALLOW_REMOTE_HOST)) {
    throw new BridgeConfigError(
      "DSH_HOST_MODE=desktop-paired conflicts with DSH_ALLOW_REMOTE_HOST: the first version connects to a local Desktop Host only",
    );
  }
  for (const name of ROUTING_OVERRIDES) {
    const value = env[name]?.trim();
    if (value !== undefined && value !== "" && !(name === "DSH_MODEL_POLICY" && value === "inherit")) {
      throw new BridgeConfigError(
        `DSH_HOST_MODE=desktop-paired conflicts with ${name}=${JSON.stringify(value)}: a paired bridge never routes models, reasoning effort, presets, or approvals`,
      );
    }
  }
  const approval = env.DSH_APPROVAL_MODE?.trim();
  if (approval !== undefined && approval !== "" && approval !== "desktop") {
    throw new BridgeConfigError(
      `DSH_HOST_MODE=desktop-paired conflicts with DSH_APPROVAL_MODE=${JSON.stringify(approval)}: approvals are answered only in the DSH Desktop UI`,
    );
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const waitProfile = env.DSH_WAIT_PROFILE ?? "bounded";
  if (waitProfile !== "bounded" && waitProfile !== "long") throw new BridgeConfigError("DSH_WAIT_PROFILE must be bounded or long");
  if (waitProfile === "long" && ["zcode", "kimi-code", "kimi-work"].includes(callerKindOf(env.DSH_CALLER_KIND))) {
    throw new BridgeConfigError("this caller supports bounded waits only until native long-call acceptance is verified");
  }
  const allowRemoteHost = booleanEnv(env.DSH_ALLOW_REMOTE_HOST);
  const requestedHostMode = env.DSH_HOST_MODE?.trim() || "static";
  if (requestedHostMode !== "static" && requestedHostMode !== "desktop-auto" && requestedHostMode !== "desktop-paired") {
    throw new BridgeConfigError(
      `DSH_HOST_MODE must be static, desktop-auto, or desktop-paired, received ${JSON.stringify(requestedHostMode)}`,
    );
  }
  if (env.DSH_HOME !== undefined && env.DSH_HOME.trim() === "") throw new BridgeConfigError("DSH_HOME must not be empty");
  if (env.DSH_BRIDGE_HOME !== undefined && env.DSH_BRIDGE_HOME.trim() === "") {
    throw new BridgeConfigError("DSH_BRIDGE_HOME must not be empty");
  }

  const paired = requestedHostMode === "desktop-paired";
  if (paired) assertPairedEnvironmentIsClean(env);

  const dshHome = env.DSH_HOME === undefined ? resolve(homedir(), ".dsh") : resolve(env.DSH_HOME);
  const defaultAgentPreset = env.DSH_BRIDGE_AGENT_PRESET?.trim();
  const clientTimeZone = env.DSH_BRIDGE_TIME_ZONE?.trim() || detectTimeZone();
  const declaredDshVersion = env.DSH_HOST_VERSION?.trim();
  const approvalTimeoutMs = optionalPositiveIntegerEnv(env.DSH_APPROVAL_TIMEOUT_MS);

  let connectionFile: string | undefined;
  if (paired) {
    const raw = env.DSH_CONNECTION_FILE?.trim();
    if (raw === undefined || raw === "") {
      throw new BridgeConfigError("DSH_HOST_MODE=desktop-paired requires DSH_CONNECTION_FILE to name the private connection.json");
    }
    if (!isAbsolute(raw)) {
      throw new BridgeConfigError(`DSH_CONNECTION_FILE must be an absolute path, received ${JSON.stringify(raw)}`);
    }
    connectionFile = resolve(raw);
  } else if (env.DSH_CONNECTION_FILE !== undefined && env.DSH_CONNECTION_FILE.trim() !== "") {
    throw new BridgeConfigError(
      "DSH_CONNECTION_FILE is only meaningful with DSH_HOST_MODE=desktop-paired; set DSH_HOST_MODE or remove the file path",
    );
  }

  const configuredHostMode: HostMode = env.DSH_HOST_URL === undefined ? requestedHostMode : "static";
  if (paired && configuredHostMode !== "desktop-paired") {
    throw new BridgeConfigError("DSH_HOST_MODE=desktop-paired must not fall back to a static host");
  }

  return {
    // A paired bridge has no configured origin: it reads the Host's own origin
    // from the private descriptor on every (re)connect.
    hostUrl: paired ? "" : normalizeHostUrl(env.DSH_HOST_URL ?? DEFAULT_HOST_URL, allowRemoteHost),
    hostMode: configuredHostMode,
    homeDir: resolve(
      env.DSH_BRIDGE_HOME ?? (paired ? resolve(env.LOCALAPPDATA ?? homedir(), "DSHDesktopCowork", "bridge") : resolve(dshHome, "codex-bridge")),
    ),
    requestTimeoutMs: positiveIntegerEnv(env.DSH_REQUEST_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    allowRemoteHost: paired ? false : allowRemoteHost,
    ...(defaultAgentPreset === undefined || defaultAgentPreset === "" ? {} : { defaultAgentPreset }),
    ...(clientTimeZone === undefined ? {} : { clientTimeZone }),
    ...(declaredDshVersion === undefined || declaredDshVersion === "" ? {} : { declaredDshVersion }),
    ...(approvalTimeoutMs === undefined ? {} : { approvalTimeoutMs }),
    ...(connectionFile === undefined ? {} : { connectionFile }),
    callerKind: callerKindOf(env.DSH_CALLER_KIND),
    approvalMode: "desktop",
    modelPolicy: "inherit",
    waitProfile,
  };
}
