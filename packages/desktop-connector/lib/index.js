/**
 * DSH Desktop Cowork — connection publisher.
 *
 * Contract (see DESIGN §4): this plugin publishes the running Host's own
 * connection facts and nothing else. It opens no listening port, proxies no
 * RPC, starts no model, takes over no session, and never reads the account
 * credential store, the browser cookie database, or process memory. The one
 * secret it handles is the launch token the Host itself just minted, and that
 * value is written only into a private, ACL-restricted file.
 *
 * @module dsh-desktop-cowork-connector
 */

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { AclError, aclInternals, restrictDirectory, verifyDirectory, verifyFile } from './acl.js';
import {
  buildConnection,
  ensurePrivateDirectory,
  loadOrCreateIdentity,
  removeOwnConnection,
  writeConnection,
} from './descriptor.js';
import { packageFacts, processStartedAt, profileIdentity, protocolFamilyOf } from './host-facts.js';

/** Published Host API family implemented by the bridge adapter for this release. */
const AUTH_MODE = 'browser-session';
/** Refresh cadence for `publishedAt`; the bridge treats 30s of silence as stale. */
const REFRESH_MS = 5_000;
/** Bounded retries while the Host finishes listening; never blocks Host startup. */
const READY_RETRY_MS = 500;
const READY_RETRY_LIMIT = 40;

/** @type {string} */
export const name = 'dsh-desktop-cowork-connector';

/** The two Host services whose facts this plugin publishes. */
export const inject = ['webServer', 'connection'];

/**
 * Resolve the default publish root.
 * @returns {string} absolute directory that holds one subdirectory per profile.
 */
export function defaultBaseDir() {
  const localAppData = process.env.LOCALAPPDATA;
  if (typeof localAppData === 'string' && localAppData.length > 0) {
    return join(localAppData, 'DSHDesktopCowork', 'connections');
  }
  return join(process.env.USERPROFILE ?? process.cwd(), 'AppData', 'Local', 'DSHDesktopCowork', 'connections');
}

/**
 * Extract the launch token from a launch-token URL without ever retaining the URL.
 * @param {string} authenticatedUrl - URL returned by `connection.authenticatedUrl`.
 * @returns {string} the token query value.
 */
export function launchTokenOf(authenticatedUrl) {
  const parsed = new URL(authenticatedUrl);
  const token = parsed.searchParams.get('token');
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('connection.authenticatedUrl returned no launch token');
  }
  return token;
}

/**
 * Compose the origin the bridge must target for this Host.
 *
 * `WebServer` binds either the loopback literal or all interfaces; a Desktop
 * profile always serves loopback, and the bridge refuses anything else, so the
 * origin is the loopback literal on the *listening* port.
 *
 * @param {{port: number, host: string}} webServer - the listening service.
 * @returns {string} origin without a trailing slash.
 */
export function originOf(webServer) {
  const port = webServer.port;
  if (!Number.isInteger(port) || port <= 0) throw new Error('webServer has no listening port yet');
  return `http://127.0.0.1:${String(port)}`;
}

/**
 * Publish once, then keep `publishedAt` fresh until disposal.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - owning plugin context.
 * @param {{baseDir?: string, refreshMs?: number, logger?: {warn: Function}}} [config] - optional overrides.
 * @returns {Promise<{dir: string, hostId: string, instanceId: string} | undefined>} publication facts.
 */
export async function apply(ctx, config = {}) {
  const baseDir = typeof config.baseDir === 'string' && config.baseDir.length > 0 ? config.baseDir : defaultBaseDir();
  const refreshMs = Number.isInteger(config.refreshMs) && config.refreshMs > 0 ? config.refreshMs : REFRESH_MS;
  const log = config.logger ?? ctx.logger?.('desktop-cowork-connector');

  const instanceId = randomUUID();
  const facts = packageFacts();
  const identity = profileIdentity(facts);
  const dir = join(baseDir, identity.profileKey);
  const protocolFamily = protocolFamilyOf(facts.harnessVersion);
  const hostStartedAt = processStartedAt();

  let disposed = false;
  let timer;
  let directoryReady = false;
  let hostId;
  let attempts = 0;
  let lastFailure;

  /**
   * Write the descriptor for the Host's current listening state.
   * @returns {Promise<boolean>} whether a publication landed.
   */
  const publish = async () => {
    if (disposed) return false;
    const webServer = ctx.webServer;
    if (webServer === undefined || ctx.connection === undefined) return false;

    let origin;
    let token;
    try {
      origin = originOf(webServer);
      token = launchTokenOf(ctx.connection.authenticatedUrl(`${origin}/`));
    } catch (error) {
      // Not listening yet: bounded retry, never an unbounded wait.
      attempts += 1;
      lastFailure = error instanceof Error ? error.message : String(error);
      if (attempts >= READY_RETRY_LIMIT) {
        log?.warn?.(`connector: Host never reported a listening port (${lastFailure})`);
      }
      return false;
    }

    if (!directoryReady) {
      try {
        await ensurePrivateDirectory(dir, restrictDirectory);
        await verifyDirectory(dir);
        directoryReady = true;
      } catch (error) {
        const code = error instanceof AclError ? error.code : 'acl_unknown';
        log?.warn?.(`connector: refusing to publish because the private directory is not private (${code})`);
        return false;
      }
    }

    if (hostId === undefined) hostId = (await loadOrCreateIdentity(dir)).hostId;

    const descriptor = buildConnection({
      hostId,
      instanceId,
      profileKind: facts.profileName,
      profileFingerprint: identity.profileFingerprint,
      desktopVersion: facts.desktopVersion,
      harnessVersion: facts.harnessVersion,
      origin,
      hostPid: process.pid,
      hostStartedAt,
      authMode: AUTH_MODE,
      protocolFamily,
      launchToken: token,
    });

    try {
      const written = await writeConnection(dir, descriptor);
      await verifyFile(written, await aclInternals.currentUserIdentity());
    } catch (error) {
      const code = error instanceof AclError ? error.code : 'write_failed';
      // Never echo the descriptor: it contains the launch token.
      log?.warn?.(`connector: publication failed (${code})`);
      return false;
    }

    attempts = 0;
    return true;
  };

  await publish();
  timer = setInterval(() => {
    void publish();
  }, refreshMs);
  if (typeof timer.unref === 'function') timer.unref();

  ctx.effect(() => () => {
    disposed = true;
    if (timer !== undefined) clearInterval(timer);
    return removeOwnConnection(dir, instanceId).catch(() => false);
  }, 'desktop-cowork-connector: publication lifecycle');
}

export default { name, inject, apply };
