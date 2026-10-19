/**
 * Layered diagnostics for the paired Desktop path.
 *
 * Every answer is derived from a file the user's own installation already has:
 * the Desktop runtime manifest for versions, the profile manifest for the
 * connector registration, the published descriptor for liveness, and the caller
 * configuration files for legacy entries. Nothing here reads a credential store
 * or a browser database.
 *
 * @module desktop/doctor-desktop
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface PublishedConnectionFacts {
  exists: boolean;
  path?: string;
  ageMs?: number;
  harnessVersion?: string;
  desktopVersion?: string;
  protocolFamily?: string;
  origin?: string;
  problem?: string;
}

export interface DesktopHostFacts {
  platform: string;
  nodeVersion: string;
  /** Desktop shell release, read from the runtime manifest when present. */
  desktopVersion?: string;
  runtimeNode?: string;
  runtimePnpm?: string;
  dshHome?: string;
  profileDir?: string;
  profileKind?: string;
  /** Whether the connector bundle is registered in the profile manifest. */
  connectorRegistered?: boolean;
  /** Whether the connector package is physically resolvable from the profile. */
  connectorResolvable?: boolean;
  /** Where the connector writes descriptors for this profile. */
  connectionsRoot: string;
  connectionFile?: string;
  connection: PublishedConnectionFacts;
  legacyEntries: string[];
  problems: string[];
}

function localAppData(): string {
  return process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
}

/** Root the connector publishes under. */
export function connectionsRoot(): string {
  return join(localAppData(), "DSHDesktopCowork", "connections");
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Locate the installed Desktop runtime manifest. */
async function runtimeManifest(): Promise<{ desktopVersion?: string; node?: string; pnpm?: string; root?: string }> {
  const candidates = [
    join(localAppData(), "Programs", "DeepSeek Harness", "resources", "runtime", "primary-runtime", "runtime.json"),
    join(localAppData(), "Programs", "DeepSeek Harness", "resources", "runtime", "versions.json"),
  ];
  for (const candidate of candidates) {
    const value = (await readJson(candidate)) as Record<string, unknown> | undefined;
    if (value === undefined) continue;
    return {
      ...(typeof value.desktopVersion === "string" ? { desktopVersion: value.desktopVersion } : {}),
      ...(typeof value.node === "string" ? { node: value.node } : {}),
      ...(typeof value.pnpm === "string" ? { pnpm: value.pnpm } : {}),
      root: resolve(candidate),
    };
  }
  return {};
}

/** Find the newest published descriptor for any profile. */
export async function newestConnection(root = connectionsRoot()): Promise<{ path: string; value: Record<string, unknown>; ageMs: number } | undefined> {
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return undefined;
  }
  let best: { path: string; value: Record<string, unknown>; ageMs: number } | undefined;
  for (const entry of entries) {
    const path = join(root, entry, "connection.json");
    const value = (await readJson(path)) as Record<string, unknown> | undefined;
    if (value === undefined) continue;
    const publishedAt = typeof value.publishedAt === "string" ? Date.parse(value.publishedAt) : Number.NaN;
    const ageMs = Number.isFinite(publishedAt) ? Date.now() - publishedAt : Number.POSITIVE_INFINITY;
    if (best === undefined || ageMs < best.ageMs) best = { path, value, ageMs };
  }
  return best;
}

/** Read the configured or discovered descriptor path. */
export async function configuredConnectionFile(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const explicit = env.DSH_CONNECTION_FILE?.trim();
  if (explicit !== undefined && explicit !== "") return resolve(explicit);
  return (await newestConnection())?.path;
}

/** Scan caller configuration files for competitor bridge entries. */
async function legacyEntries(): Promise<string[]> {
  const found: string[] = [];
  const codexHome = process.env.CODEX_HOME?.trim();
  const files = [
    join(codexHome === undefined || codexHome === "" ? join(homedir(), ".codex") : codexHome, "config.toml"),
    join(homedir(), ".claude.json"),
  ];
  for (const file of files) {
    let content: string;
    try {
      content = await readFile(file, "utf8");
    } catch {
      continue;
    }
    for (const name of ["dsh_agentlink", "dsh_collab"]) {
      if (content.includes(name)) found.push(`${name} in ${file}`);
    }
  }
  return found;
}

/**
 * Inspect the Desktop installation, its profile, and any published descriptor.
 * @returns the layered diagnostic facts.
 */
export async function inspectDesktopHost(): Promise<DesktopHostFacts> {
  const problems: string[] = [];
  const runtime = await runtimeManifest();
  const dshHome = process.env.DSH_HOME?.trim() || join(homedir(), ".dsh");
  const profileDir = process.env.DSH_PROFILE_DIR?.trim() || join(dshHome, "profiles", "desktop");
  const profileManifest = (await readJson(join(profileDir, "package.json"))) as
    | { dsh?: { profile?: { bundles?: unknown } }; dependencies?: Record<string, unknown> }
    | undefined;
  const bundles = Array.isArray(profileManifest?.dsh?.profile?.bundles)
    ? profileManifest.dsh.profile.bundles.filter((entry): entry is string => typeof entry === "string")
    : [];
  const connectorRegistered =
    bundles.includes("dsh-desktop-cowork-connector") ||
    Object.keys(profileManifest?.dependencies ?? {}).includes("dsh-desktop-cowork-connector");
  const connectorResolvable = await exists(join(profileDir, "node_modules", "dsh-desktop-cowork-connector", "package.json"));

  if (!runtime.desktopVersion) problems.push("cannot read the installed Desktop runtime manifest");
  if (!connectorRegistered) {
    problems.push(
      "the connector bundle is not registered in the Desktop profile; install dsh-desktop-cowork-connector through the official plugin mechanism, then restart the Desktop app",
    );
  }

  const connectionFile = await configuredConnectionFile();
  let connection: PublishedConnectionFacts = { exists: false };
  if (connectionFile === undefined) {
    problems.push(`no connection descriptor under ${connectionsRoot()}; the connector has not published yet`);
  } else {
    const value = (await readJson(connectionFile)) as Record<string, unknown> | undefined;
    if (value === undefined) {
      connection = { exists: false, path: connectionFile, problem: "descriptor is unreadable" };
      problems.push(`connection descriptor ${connectionFile} is unreadable`);
    } else {
      const publishedAt = typeof value.publishedAt === "string" ? Date.parse(value.publishedAt) : Number.NaN;
      const ageMs = Number.isFinite(publishedAt) ? Date.now() - publishedAt : undefined;
      connection = {
        exists: true,
        path: connectionFile,
        ...(ageMs === undefined ? {} : { ageMs }),
        ...(typeof value.harnessVersion === "string" ? { harnessVersion: value.harnessVersion } : {}),
        ...(typeof value.desktopVersion === "string" ? { desktopVersion: value.desktopVersion } : {}),
        ...(typeof value.protocolFamily === "string" ? { protocolFamily: value.protocolFamily } : {}),
        // The origin is sanitized for display; the token is never read here.
        ...(typeof value.origin === "string" ? { origin: value.origin } : {}),
      };
      if (ageMs !== undefined && ageMs > 30_000) {
        problems.push(`the descriptor has not been refreshed for ${String(Math.round(ageMs / 1000))}s; the Desktop Host is probably not running`);
      }
    }
  }

  return {
    platform: process.platform,
    nodeVersion: process.versions.node,
    ...(runtime.desktopVersion === undefined ? {} : { desktopVersion: runtime.desktopVersion }),
    ...(runtime.node === undefined ? {} : { runtimeNode: runtime.node }),
    ...(runtime.pnpm === undefined ? {} : { runtimePnpm: runtime.pnpm }),
    dshHome,
    profileDir,
    profileKind: process.env.DSH_PROFILE ?? (await exists(profileDir) ? "desktop" : "unknown"),
    connectorRegistered,
    connectorResolvable,
    connectionsRoot: connectionsRoot(),
    ...(connectionFile === undefined ? {} : { connectionFile }),
    connection,
    legacyEntries: await legacyEntries(),
    problems,
  };
}

/**
 * Judge whether the paired path can work right now.
 * @param facts - inspection result.
 * @returns per-layer status.
 */
export function judge(facts: DesktopHostFacts): Array<{ layer: string; status: "ok" | "blocked" | "warn"; detail: string }> {
  return [
    {
      layer: "desktop-runtime",
      status: facts.desktopVersion === undefined ? "blocked" : "ok",
      detail: facts.desktopVersion === undefined ? "the Desktop runtime manifest was not found" : `Desktop ${facts.desktopVersion}`,
    },
    {
      layer: "connector-registered",
      status: facts.connectorRegistered ? (facts.connectorResolvable ? "ok" : "warn") : "blocked",
      detail: facts.connectorRegistered
        ? facts.connectorResolvable
          ? "bundle registered and resolvable"
          : "bundle registered in the manifest but not present in the profile's node_modules; it will activate after the next plugin install or app restart"
        : "bundle not registered in the Desktop profile",
    },
    {
      layer: "published-connection",
      status: facts.connection.exists ? ((facts.connection.ageMs ?? 0) > 30_000 ? "blocked" : "ok") : "blocked",
      detail: facts.connection.exists
        ? `Published ${String(Math.round((facts.connection.ageMs ?? 0) / 1000))}s ago at ${facts.connection.path ?? "?"} (family ${facts.connection.protocolFamily ?? "?"}, origin ${facts.connection.origin ?? "?"})`
        : "no descriptor has been published for this profile",
    },
    {
      layer: "legacy-entries",
      status: facts.legacyEntries.length > 0 ? "warn" : "ok",
      detail: facts.legacyEntries.length > 0 ? facts.legacyEntries.join("; ") : "no competing bridge entries are configured",
    },
  ];
}
