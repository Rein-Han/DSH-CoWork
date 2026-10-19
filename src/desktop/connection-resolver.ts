import { readFile } from "node:fs/promises";
import { dirname } from "node:path";

import { AuthSession } from "./auth-session.js";
import {
  assertFresh,
  assertLocalOrigin,
  generationChanged,
  parseConnectionDescriptor,
  DescriptorProblem,
  START_TIME_TOLERANCE_MS,
  type ConnectionDescriptor,
  type ConnectionGeneration,
} from "./connection-descriptor.js";
import { assertPrivateDirectory, readListenerPid, readProcessFacts, sameProcessStart } from "./windows-security.js";

export interface ResolvedConnection {
  descriptor: ConnectionDescriptor;
  origin: string;
  session: AuthSession;
  generation: ConnectionGeneration;
  /** Wall-clock age of the publication this resolution accepted. */
  ageMs: number;
}

export interface ResolveConnectionOptions {
  readonly connectionFile: string;
  /** Last generation this bridge used, to detect a restart. */
  readonly previousGeneration?: ConnectionGeneration;
  /** Skip the OS-level probes (used by doctor --offline and tests). */
  readonly skipNativeChecks?: boolean;
  readonly timeoutMs?: number;
}

/**
 * Read, verify, and authenticate one published Desktop connection.
 *
 * Verification order matters: the file's own access policy is checked before
 * its contents are trusted; the contents are checked before the origin is used;
 * and the operating system is asked whether the PID that published this file is
 * still alive, still started when it claims, and still owns the listening
 * socket. Only then is the launch token exchanged.
 *
 * @param options - descriptor path and prior generation.
 * @returns the authenticated connection generation.
 */
export async function resolveConnection(options: ResolveConnectionOptions): Promise<ResolvedConnection> {
  let raw: string;
  try {
    raw = await readFile(options.connectionFile, "utf8");
  } catch {
    throw new DescriptorProblem(
      "connector_missing",
      `no connection file at ${options.connectionFile}; install and enable the DSH Desktop Cowork connector in this Desktop profile, then restart the Desktop app`,
    );
  }

  if (options.skipNativeChecks !== true) {
    await assertPrivateDirectory(dirname(options.connectionFile)).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "connection_file_insecure") {
        throw new DescriptorProblem("connection_file_insecure", error.message);
      }
      throw error;
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new DescriptorProblem("connector_missing", "connection.json is not valid JSON");
  }
  const descriptor = parseConnectionDescriptor(parsed);
  const origin = assertLocalOrigin(descriptor.origin);
  const ageMs = assertFresh(descriptor);

  if (options.skipNativeChecks !== true) {
    const process = await readProcessFacts(descriptor.hostPid);
    if (!process.running) {
      throw new DescriptorProblem(
        "stale_connection",
        `the Desktop Host process ${String(descriptor.hostPid)} named by connection.json is no longer running`,
        { hostPid: descriptor.hostPid },
      );
    }
    if (!sameProcessStart(descriptor.hostStartedAt, process.createdAt, START_TIME_TOLERANCE_MS)) {
      throw new DescriptorProblem(
        "host_identity_mismatch",
        `process ${String(descriptor.hostPid)} did not start when connection.json claims, so the file belongs to an earlier Host run`,
        { hostPid: descriptor.hostPid, reported: descriptor.hostStartedAt, actual: process.createdAt },
      );
    }
    const port = Number(new URL(origin).port === "" ? (new URL(origin).protocol === "https:" ? 443 : 80) : new URL(origin).port);
    const listener = await readListenerPid(port);
    if (listener === undefined) {
      throw new DescriptorProblem("desktop_not_running", `nothing is listening on ${origin} any more`);
    }
    if (listener !== descriptor.hostPid) {
      throw new DescriptorProblem(
        "host_identity_mismatch",
        `port ${String(port)} is owned by PID ${String(listener)}, but connection.json was published by PID ${String(descriptor.hostPid)}`,
        { port, listenerPid: listener, hostPid: descriptor.hostPid },
      );
    }
  }

  const generation: ConnectionGeneration = { hostId: descriptor.hostId, instanceId: descriptor.instanceId };
  if (generationChanged(options.previousGeneration, generation) && options.previousGeneration !== undefined) {
    // Not an error: the caller is told so it can drop the old generation's
    // sockets, cookies, and late frames before using this one.
  }

  const session = new AuthSession({
    origin,
    generation,
    launchToken: descriptor.launchToken,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  await session.handshake();

  return { descriptor, origin, session, generation, ageMs };
}

/**
 * Describe a connection for diagnostics without authenticating.
 * @param connectionFile - descriptor path.
 * @returns non-secret descriptor facts.
 */
export async function describeConnection(connectionFile: string): Promise<{
  exists: boolean;
  schemaVersion?: number;
  hostId?: string;
  instanceId?: string;
  origin?: string;
  protocolFamily?: string;
  authMode?: string;
  harnessVersion?: string;
  desktopVersion?: string;
  ageMs?: number;
  problem?: { code: string; message: string };
}> {
  try {
    const raw = await readFile(connectionFile, "utf8");
    const descriptor = parseConnectionDescriptor(JSON.parse(raw));
    return {
      exists: true,
      schemaVersion: descriptor.schemaVersion,
      hostId: descriptor.hostId,
      instanceId: descriptor.instanceId,
      origin: assertLocalOrigin(descriptor.origin),
      protocolFamily: descriptor.protocolFamily,
      authMode: descriptor.authMode,
      harnessVersion: descriptor.harnessVersion,
      desktopVersion: descriptor.desktopVersion,
      ageMs: Date.now() - Date.parse(descriptor.publishedAt),
    };
  } catch (error) {
    if (error instanceof DescriptorProblem) {
      return { exists: false, problem: { code: error.code, message: error.message } };
    }
    return {
      exists: false,
      problem: { code: "connector_missing", message: error instanceof Error ? error.message : String(error) },
    };
  }
}
