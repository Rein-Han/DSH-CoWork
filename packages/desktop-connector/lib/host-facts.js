/**
 * Discover what this Host can truthfully say about itself.
 *
 * Everything here is either a value the running process owns (pid, start time,
 * listening port, launch token) or a value read from the installed package
 * manifests. Nothing is guessed from a directory name, and nothing is read from
 * the account credential store.
 *
 * @module dsh-desktop-cowork-connector/host-facts
 */

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const requireFromProfile = (base) => {
  try {
    return createRequire(base);
  } catch {
    return undefined;
  }
};

/**
 * Read one JSON file, returning undefined instead of throwing.
 * @param {string} file - absolute path.
 * @returns {any} parsed value or undefined.
 */
function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Locate `@deepseek-ai/dsh/package.json` from the plugin's own install root and
 * from the profile directory, in that order.
 * @returns {string | undefined} absolute manifest path.
 */
function resolveHarnessManifest() {
  const candidates = [];
  const profileDir = process.env.DSH_PROFILE_DIR;
  if (profileDir !== undefined && profileDir !== '') candidates.push(join(profileDir, 'package.json'));
  candidates.push(import.meta.url);
  for (const base of candidates) {
    const req = requireFromProfile(base);
    if (req === undefined) continue;
    try {
      return req.resolve('@deepseek-ai/dsh/package.json');
    } catch {
      // try the next anchor
    }
  }
  return undefined;
}

/**
 * Version facts read from the installed package manifests.
 * @returns {{harnessVersion: string, desktopVersion: string, profileName: string, bundles: string[], installRoot?: string}} facts.
 */
export function packageFacts() {
  const harnessManifest = resolveHarnessManifest();
  const harness = harnessManifest === undefined ? undefined : readJson(harnessManifest);
  const harnessVersion = typeof harness?.version === 'string' ? harness.version : 'unknown';

  // `@deepseek-ai/dsh` lives at <runtime>/node_modules/@deepseek-ai/dsh, so the
  // runtime manifest two levels up names the Desktop runtime release.
  let desktopVersion = 'unknown';
  let installRoot;
  if (harnessManifest !== undefined) {
    const deepseekScope = dirname(dirname(harnessManifest));
    const nodeModules = dirname(deepseekScope);
    const runtimeRoot = dirname(nodeModules);
    installRoot = runtimeRoot;
    const runtime = readJson(join(runtimeRoot, 'package.json'));
    if (typeof runtime?.version === 'string') desktopVersion = runtime.version;
  }

  const profileDir = process.env.DSH_PROFILE_DIR;
  const profileManifest = profileDir === undefined ? undefined : readJson(join(profileDir, 'package.json'));
  const bundles = Array.isArray(profileManifest?.dsh?.profile?.bundles)
    ? profileManifest.dsh.profile.bundles.filter((entry) => typeof entry === 'string')
    : [];

  return {
    harnessVersion,
    desktopVersion,
    profileName: process.env.DSH_PROFILE ?? 'unknown',
    bundles,
    ...(installRoot === undefined ? {} : { installRoot }),
  };
}

/**
 * A stable, non-secret fingerprint of this installation + profile pair.
 *
 * Two different Harness homes, or two profiles under one home, must never share
 * a connection directory, so the fingerprint folds in the profile directory and
 * the resolved runtime root rather than the profile's display name alone.
 *
 * @param {{profileName: string, installRoot?: string}} facts - package facts.
 * @returns {{profileFingerprint: string, profileKey: string}} digests.
 */
export function profileIdentity(facts) {
  const material = [
    'dsh-desktop-cowork-connector/v1',
    process.platform,
    resolve(process.env.DSH_PROFILE_DIR ?? ''),
    facts.installRoot === undefined ? '' : resolve(facts.installRoot),
  ].join('\u0000');
  const profileFingerprint = createHash('sha256').update(material).digest('hex');
  return { profileFingerprint, profileKey: profileFingerprint.slice(0, 16) };
}

/**
 * Resolve the protocol family this Host speaks from what it actually is.
 *
 * The bridge maps a family to exactly one adapter, so this string must be
 * derived from the installed release rather than from wishful thinking.
 *
 * @param {string} harnessVersion - `@deepseek-ai/dsh` version.
 * @returns {string} protocol family identifier.
 */
export function protocolFamilyOf(harnessVersion) {
  const match = /^(\d+)\.(\d+)\./u.exec(harnessVersion);
  if (match === null) return 'unknown';
  return `dsh-host-${match[1]}.${match[2]}`;
}

/**
 * Native process creation time, as milliseconds since the Unix epoch.
 *
 * `process.uptime()` is the runtime's own accounting of process age, so this is
 * the creation instant rather than the plugin-activation instant; the bridge
 * compares it with the Windows `CreationDate` of the owning PID to detect PID
 * reuse across restarts.
 *
 * @returns {number} creation time in epoch milliseconds.
 */
export function processStartedAt() {
  return Date.now() - Math.round(process.uptime() * 1000);
}
