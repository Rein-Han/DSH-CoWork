import { z } from "zod";

/**
 * The private descriptor a Desktop Host publishes for this bridge.
 *
 * The value lives only in an ACL-restricted file; it carries the Host's launch
 * token, so it must never be logged, echoed in an MCP response, or embedded in
 * an error message. Everything in this module is therefore written to describe
 * the descriptor's *shape and validity*, never its secret.
 */

export const CONNECTION_SCHEMA_VERSION = 1;

export const authModeSchema = z.enum(["api-connect", "browser-session"]);
export type AuthMode = z.infer<typeof authModeSchema>;

/** How long a descriptor stays usable without a refresh. */
export const STALE_AFTER_MS = 30_000;
/** How far a Host's reported creation time may differ from the process query. */
export const START_TIME_TOLERANCE_MS = 5_000;

const nonEmpty = z.string().min(1);

export const connectionDescriptorSchema = z
  .object({
    schemaVersion: z.literal(CONNECTION_SCHEMA_VERSION),
    hostId: nonEmpty,
    instanceId: nonEmpty,
    profileKind: nonEmpty,
    profileFingerprint: nonEmpty,
    desktopVersion: nonEmpty,
    harnessVersion: nonEmpty,
    origin: nonEmpty,
    hostPid: z.number().int().positive(),
    hostStartedAt: z.number().int().positive(),
    publishedAt: nonEmpty,
    authMode: authModeSchema,
    protocolFamily: nonEmpty,
    launchToken: nonEmpty,
  })
  .strict();

export type ConnectionDescriptor = z.infer<typeof connectionDescriptorSchema>;

export type DescriptorProblemCode =
  | "connector_missing"
  | "connection_file_insecure"
  | "stale_connection"
  | "host_identity_mismatch"
  | "unsupported_host_version"
  | "protocol_mismatch"
  | "desktop_not_running";

export class DescriptorProblem extends Error {
  constructor(
    readonly code: DescriptorProblemCode,
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "DescriptorProblem";
  }
}

const LOCAL_IPV4 = /^(?:127\.(?:\d{1,3})\.(?:\d{1,3})\.(?:\d{1,3})|10\.(?:\d{1,3})\.(?:\d{1,3})\.(?:\d{1,3})|192\.168\.(?:\d{1,3})\.(?:\d{1,3})|172\.(?:1[6-9]|2\d|3[01])\.(?:\d{1,3})\.(?:\d{1,3})|169\.254\.(?:\d{1,3})\.(?:\d{1,3}))$/u;

/**
 * Decide whether an origin is a bare local address this bridge may target.
 *
 * The first version supports only a loopback Desktop Host: a remote origin is
 * refused rather than downgraded, because the launch token grants Host-owner
 * API identity and must never travel off this machine.
 *
 * @param origin - the descriptor's origin field.
 * @returns the normalized origin.
 */
export function assertLocalOrigin(origin: string): string {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new DescriptorProblem("connection_file_insecure", "connection origin is not a URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new DescriptorProblem("connection_file_insecure", `connection origin must use http or https, got ${url.protocol}`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new DescriptorProblem("connection_file_insecure", "connection origin must not contain credentials");
  }
  if (url.search !== "" || url.hash !== "") {
    throw new DescriptorProblem("connection_file_insecure", "connection origin must not contain a query or fragment");
  }
  if (url.pathname !== "/") {
    throw new DescriptorProblem("connection_file_insecure", "connection origin must not contain a path");
  }
  const host = url.hostname.replace(/^\[|\]$/gu, "");
  const isLoopback = host === "127.0.0.1" || host === "::1" || host === "localhost";
  const isLocalLiteral = LOCAL_IPV4.test(host);
  if (!isLoopback && !isLocalLiteral) {
    throw new DescriptorProblem(
      "connection_file_insecure",
      `refusing non-local DSH origin ${host}; the first version supports only a local Desktop Host`,
    );
  }
  return `${url.protocol}//${url.host}`;
}

/**
 * Parse and validate a descriptor value without touching the secret.
 * @param value - parsed JSON from the private file.
 * @returns the validated descriptor.
 */
export function parseConnectionDescriptor(value: unknown): ConnectionDescriptor {
  const parsed = connectionDescriptorSchema.safeParse(value);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join(".") || "value"}: ${issue.message}`)
      .join("; ");
    throw new DescriptorProblem("connector_missing", `connection.json does not match schema version 1: ${detail}`);
  }
  parseInstant(parsed.data.publishedAt, "publishedAt");
  return parsed.data;
}

/**
 * Parse one ISO timestamp field, failing with a descriptor problem.
 * @param value - ISO timestamp text.
 * @param field - field name for the diagnostic.
 * @returns epoch milliseconds.
 */
export function parseInstant(value: string, field: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new DescriptorProblem("connector_missing", `connection.json ${field} is not an ISO timestamp`);
  }
  return parsed;
}

/**
 * Judge freshness against the refresh contract.
 * @param descriptor - validated descriptor.
 * @param now - current epoch milliseconds.
 * @returns age in milliseconds when fresh.
 */
export function assertFresh(descriptor: ConnectionDescriptor, now = Date.now()): number {
  const publishedAt = parseInstant(descriptor.publishedAt, "publishedAt");
  const age = now - publishedAt;
  if (age > STALE_AFTER_MS) {
    throw new DescriptorProblem(
      "stale_connection",
      `connection.json has not been refreshed for ${Math.round(age / 1000)}s; the Desktop Host may have exited`,
      { ageMs: age, instanceId: descriptor.instanceId },
    );
  }
  if (age < -STALE_AFTER_MS) {
    throw new DescriptorProblem(
      "stale_connection",
      "connection.json is dated in the future; this machine's clock or the publishing Host changed",
      { ageMs: age },
    );
  }
  return age;
}

/** A connection generation identity: the pair that isolates one Host run. */
export interface ConnectionGeneration {
  hostId: string;
  instanceId: string;
}

/**
 * Compare two generations for the restart/instance-change check.
 * @param previous - last generation this bridge used.
 * @param next - generation read now.
 * @returns whether the write path must be restarted.
 */
export function generationChanged(
  previous: ConnectionGeneration | undefined,
  next: ConnectionGeneration,
): boolean {
  if (previous === undefined) return false;
  return previous.hostId !== next.hostId || previous.instanceId !== next.instanceId;
}
