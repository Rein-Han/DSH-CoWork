/**
 * The private connection descriptor: schema, atomic publication, and cleanup.
 *
 * `identity.json` is non-secret and stable for the life of the profile.
 * `connection.json` carries this activation's origin and launch token, is
 * replaced atomically, and is removed only by the activation that wrote it.
 *
 * @module dsh-desktop-cowork-connector/descriptor
 */

import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Fixed schema version of `connection.json`. */
export const CONNECTION_SCHEMA_VERSION = 1;

export const IDENTITY_FILE = 'identity.json';
export const CONNECTION_FILE = 'connection.json';

/**
 * Read one JSON file, returning undefined when it is absent or unparseable.
 * @param {string} file - absolute path.
 * @returns {Promise<any>} parsed value or undefined.
 */
async function readJsonIfExists(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Ensure the private directory exists, is a real directory, and is restricted.
 * @param {string} dir - absolute directory path.
 * @param {(dir: string) => Promise<unknown>} restrict - ACL application callback.
 * @returns {Promise<void>} resolves once the directory is restricted.
 */
export async function ensurePrivateDirectory(dir, restrict) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await restrict(dir);
}

/**
 * Load or create the stable host identity for this profile.
 *
 * The id is a bridge identifier, not an official Harness Host id: it never
 * claims to be one, and it survives restarts so a resumed task keeps its
 * namespace.
 *
 * @param {string} dir - private directory.
 * @returns {Promise<{hostId: string, created: boolean, path: string}>} identity.
 */
export async function loadOrCreateIdentity(dir) {
  const path = join(dir, IDENTITY_FILE);
  const existing = await readJsonIfExists(path);
  if (typeof existing?.hostId === 'string' && existing.hostId.length > 0) {
    return { hostId: existing.hostId, created: false, path };
  }
  const hostId = randomUUID();
  const record = { schemaVersion: CONNECTION_SCHEMA_VERSION, hostId, createdAt: new Date().toISOString() };
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return { hostId, created: true, path };
}

/**
 * Build the descriptor body for one publication.
 * @param {object} input - the facts of this activation.
 * @returns {object} the `connection.json` value.
 */
export function buildConnection(input) {
  return {
    schemaVersion: CONNECTION_SCHEMA_VERSION,
    hostId: input.hostId,
    instanceId: input.instanceId,
    profileKind: input.profileKind,
    profileFingerprint: input.profileFingerprint,
    desktopVersion: input.desktopVersion,
    harnessVersion: input.harnessVersion,
    origin: input.origin,
    hostPid: input.hostPid,
    hostStartedAt: input.hostStartedAt,
    publishedAt: new Date().toISOString(),
    authMode: input.authMode,
    protocolFamily: input.protocolFamily,
    launchToken: input.launchToken,
  };
}

/**
 * Replace `connection.json` atomically inside the private directory.
 *
 * The temporary sibling is created with exclusive create and the same mode as
 * the target so it inherits the restricted policy and can never be observed
 * half-written.
 *
 * @param {string} dir - private directory.
 * @param {object} descriptor - body from {@link buildConnection}.
 * @returns {Promise<string>} absolute path written.
 */
export async function writeConnection(dir, descriptor) {
  const target = join(dir, CONNECTION_FILE);
  const temp = join(dir, `${CONNECTION_FILE}.${randomUUID()}.tmp`);
  const handle = await open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(descriptor, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, target);
  return target;
}

/**
 * Read the descriptor written by whichever activation currently owns the file.
 * @param {string} dir - private directory.
 * @returns {Promise<any>} parsed descriptor, or undefined.
 */
export function readConnection(dir) {
  return readJsonIfExists(join(dir, CONNECTION_FILE));
}

/**
 * Remove the descriptor only while it still names this activation.
 *
 * A late disposal of an old activation must never delete the file a newer
 * activation just published, so the instance id is re-read inside the removal.
 *
 * @param {string} dir - private directory.
 * @param {string} instanceId - this activation's id.
 * @returns {Promise<boolean>} whether the file was removed.
 */
export async function removeOwnConnection(dir, instanceId) {
  const current = await readConnection(dir);
  if (current === undefined || current.instanceId !== instanceId) return false;
  await rm(join(dir, CONNECTION_FILE), { force: true });
  return true;
}
