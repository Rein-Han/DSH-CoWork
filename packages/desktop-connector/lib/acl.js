/**
 * Windows file-system protection for the private connection directory.
 *
 * The bridge trusts one thing about `connection.json`: that no other ordinary
 * account on this machine can read it. chmod(0600) is meaningless on Windows —
 * NTFS DACLs decide access — so this module drives the operating system's own
 * `icacls` utility, then re-reads the result and refuses to publish when the
 * effective policy is wider than "this user, SYSTEM, Administrators".
 *
 * Nothing here is a substitute for a Host permission boundary: the launch token
 * this protects is a Host-owner credential, and file protection only keeps it
 * off every other account on the box.
 *
 * @module dsh-desktop-cowork-connector/acl
 */

import { spawn } from 'node:child_process';
import { open, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lstat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';

/** ACE principals that must never appear on the private directory. */
const FORBIDDEN_PRINCIPALS = [
  'everyone',
  'users',
  'authenticated users',
  'interactive',
  'anonymous logon',
  'guest',
  'guests',
  'network',
  'service',
  'remote interactive logon log',
];

/** Windows account names that may hold rights: this user, SYSTEM, Administrators. */
const ADMINISTRATORS = ['administrators', 'builtin\\administrators', 'administratoren', 'administrateurs'];

/** A failure that must stop publication instead of degrading to a looser file. */
export class AclError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AclError';
    this.code = code;
  }
}

const isWindows = () => process.platform === 'win32';

/**
 * Windows built-in tools by absolute path. A bare `whoami.exe` can resolve to a
 * GNU coreutils whoami (Git for Windows puts one on PATH) that rejects `/user`.
 */
const SYSTEM32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
const WHOAMI = join(SYSTEM32, 'whoami.exe');
const ICACLS = join(SYSTEM32, 'icacls.exe');

/**
 * Lower-cased forms icacls may print for the current user: the SID, and
 * `DOMAIN\name` whenever the account name resolves (the usual case).
 * @param {string | {sid: string, name?: string}} identity - SID or SID plus name.
 * @returns {string[]} comparable forms without a leading `*`.
 */
function selfForms(identity) {
  const value = typeof identity === 'string' ? { sid: identity } : identity;
  return [value.sid, value.name]
    .filter((entry) => typeof entry === 'string' && entry !== '')
    .map((entry) => entry.toLowerCase().replace(/^\*/u, ''));
}

/**
 * Run one Windows utility without piping its stdio.
 *
 * Child stdio is delivered through inherited file descriptors rather than
 * pipes: pipes are unavailable in confined environments, and a file-backed
 * capture keeps `icacls` usable from both a normal shell and the Harness
 * sandbox while never deadlocking on buffer pressure.
 *
 * @param {string} exe - executable name.
 * @param {string[]} args - arguments.
 * @returns {Promise<{stdout: string, stderr: string, code: number}>} captured output.
 */
async function runCaptured(exe, args) {
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-cowork-acl-'));
  let stdoutHandle;
  let stderrHandle;
  try {
    stdoutHandle = await open(join(scratch, 'stdout.txt'), 'w');
    stderrHandle = await open(join(scratch, 'stderr.txt'), 'w');
    const child = spawn(exe, args, {
      stdio: ['ignore', stdoutHandle.fd, stderrHandle.fd],
      windowsHide: true,
    });
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new AclError('acl_tool_timeout', `${exe} did not finish within 20s`));
      }, 20_000);
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(new AclError('acl_tool_failed', `${exe} could not start: ${error.message}`));
      });
      child.once('close', (exitCode) => {
        clearTimeout(timer);
        resolve(exitCode ?? -1);
      });
    });
    await stdoutHandle.close();
    await stderrHandle.close();
    stdoutHandle = undefined;
    stderrHandle = undefined;
    return {
      stdout: await readFile(join(scratch, 'stdout.txt'), 'utf8'),
      stderr: await readFile(join(scratch, 'stderr.txt'), 'utf8'),
      code,
    };
  } finally {
    await stdoutHandle?.close().catch(() => undefined);
    await stderrHandle?.close().catch(() => undefined);
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Run one `icacls` invocation and return its stdout.
 * @param {string[]} args - icacls arguments, path first.
 * @returns {Promise<string>} stdout text.
 */
async function icacls(args) {
  const result = await runCaptured(ICACLS, args);
  if (result.code !== 0) {
    const detail = (result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`).slice(0, 400);
    throw new AclError('acl_tool_failed', `icacls ${args[0]} failed: ${detail}`);
  }
  return result.stdout;
}

/**
 * Resolve the current user's SID so ACL grants survive localized account names.
 * @returns {Promise<string>} SID text (`S-1-5-21-...`).
 */
async function currentUserSid() {
  return (await currentUserIdentity()).sid;
}

/**
 * Resolve the current user's SID and `DOMAIN\name`.
 * @returns {Promise<{sid: string, name?: string}>} identity icacls may print.
 */
async function currentUserIdentity() {
  const result = await runCaptured(WHOAMI, ['/user', '/fo', 'csv', '/nh']);
  if (result.code !== 0) {
    throw new AclError('acl_identity_failed', `whoami failed: ${result.stderr.trim() || `exit ${result.code}`}`);
  }
  return parseWhoamiUser(result.stdout);
}

/**
 * Parse `whoami /user /fo csv /nh` output: `"domain\name","S-1-5-..."`.
 * @param {string} stdout - whoami output.
 * @returns {{sid: string, name?: string}} identity.
 */
export function parseWhoamiUser(stdout) {
  const csv = /"([^"]+)","(S-\d-\d+(?:-\d+)+)"/u.exec(stdout);
  if (csv !== null) return { name: csv[1], sid: csv[2] };
  const bare = /(S-\d-\d+(?:-\d+)+)/u.exec(stdout);
  if (bare === null) {
    throw new AclError('acl_identity_failed', 'cannot resolve the current Windows user SID: no SID in whoami output');
  }
  return { sid: bare[1] };
}

/**
 * Parse `icacls <path>` output into ACE rows.
 *
 * `icacls` prints the path once, before the first ACE of the set; passing that
 * path lets the parser strip it so the first row's principal is not mistaken for
 * `path principal`. Continuation lines carry no path.
 *
 * @param {string} stdout - icacls listing.
 * @param {string} [pathPrefix] - the path the listing was produced for.
 * @returns {Array<{principal: string, rights: string, inherited: boolean, raw: string}>} ACE rows.
 */
export function parseIcacls(stdout, pathPrefix) {
  const rows = [];
  for (const line of stdout.split(/\r?\n/u)) {
    const trimmed = line.trim();
    const match = /^(\S.*?):((?:\([^)]*\))+)\s*$/u.exec(trimmed);
    if (match === null) continue;
    let principal = match[1].trim();
    if (typeof pathPrefix === 'string' && pathPrefix !== '') {
      const candidate = principal.toLowerCase();
      const prefix = pathPrefix.trim().toLowerCase();
      if (candidate === prefix) continue;
      if (candidate.startsWith(`${prefix} `)) principal = principal.slice(pathPrefix.trim().length + 1).trim();
    }
    const rights = match[2];
    rows.push({
      principal: principal.toLowerCase(),
      rights,
      inherited: rights.includes('(I)'),
      raw: trimmed,
    });
  }
  return rows;
}

/**
 * Decide whether a parsed ACL is acceptable for the private directory.
 * @param {Array<{principal: string, rights: string, inherited: boolean}>} rows - parsed ACE rows.
 * A file inside the already-verified private directory legitimately carries the
 * directory's grants as inherited entries; `allowInherited` accepts those, but
 * only for the same three principals. The directory itself never allows them.
 *
 * @param {string | {sid: string, name?: string}} identity - the current user's SID, or SID plus `DOMAIN\name`.
 * @param {{allowInherited?: boolean}} [options] - file-level relaxation.
 * @returns {string[]} human-readable violations; empty means acceptable.
 */
export function aclViolations(rows, identity, options = {}) {
  const problems = [];
  const self = selfForms(identity);
  if (rows.length === 0) problems.push('the directory has no explicit access entry');
  for (const row of rows) {
    if (row.inherited && options.allowInherited !== true) {
      problems.push(`inherited entry grants access: ${row.raw}`);
      continue;
    }
    if (self.includes(row.principal.replace(/^\*/u, ''))) continue;
    if (ADMINISTRATORS.includes(row.principal)) continue;
    if (row.principal === 'nt authority\\system' || row.principal === 'system') continue;
    if (FORBIDDEN_PRINCIPALS.includes(row.principal)) {
      problems.push(`broad principal holds rights: ${row.raw}`);
      continue;
    }
    problems.push(`unexpected principal holds rights: ${row.raw}`);
  }
  return problems;
}

/**
 * Reject directories that are reparse points: a junction would let another
 * location own the path after the ACL was applied.
 * @param {string} dir - absolute directory path.
 * @returns {Promise<void>} resolves only for a real directory.
 */
export async function assertNotReparsePoint(dir) {
  const info = await lstat(dir);
  if (!info.isDirectory()) throw new AclError('acl_path_not_directory', `${dir} is not a directory`);
  if (info.isSymbolicLink()) throw new AclError('acl_reparse_point', `${dir} is a symbolic link`);
  let real;
  try {
    real = realpathSync.native(dir);
  } catch (error) {
    throw new AclError('acl_path_unresolvable', `cannot resolve ${dir}: ${String(error)}`);
  }
  if (real.toLowerCase() !== dir.toLowerCase()) {
    throw new AclError('acl_reparse_point', `${dir} resolves to ${real}; refusing to publish through a reparse point`);
  }
}

/**
 * Restrict a directory to this user, SYSTEM, and Administrators, then verify it.
 *
 * The directory must already exist. Inheritance is removed first, so a
 * profile-level grant of Users/Authenticated Users stops applying; the three
 * explicit grants are then object-and-container inheritable so the temporary
 * and final connection files inherit the same restricted policy.
 *
 * @param {string} dir - absolute directory path.
 * @returns {Promise<{sid: string, aces: number}>} the applied policy summary.
 */
export async function restrictDirectory(dir) {
  if (!isWindows()) throw new AclError('acl_unsupported_platform', 'private connection files require Windows ACLs');
  await assertNotReparsePoint(dir);
  const identity = await currentUserIdentity();
  const inheritable = '(OI)(CI)F';
  await icacls([dir, '/inheritance:r']);
  for (const principal of [`*${identity.sid}`, '*S-1-5-18', '*S-1-5-32-544']) {
    await icacls([dir, '/grant:r', `${principal}:${inheritable}`]);
  }
  const reported = await verifyDirectory(dir, identity);
  return { sid: identity.sid, aces: reported };
}

/**
 * Verify an already-restricted directory without changing it.
 * @param {string} dir - absolute directory path.
 * @param {string | {sid: string, name?: string}} [identity] - pre-resolved user; resolved when omitted.
 * @returns {Promise<number>} number of explicit ACEs.
 */
export async function verifyDirectory(dir, identity) {
  if (!isWindows()) throw new AclError('acl_unsupported_platform', 'Windows ACL verification requires Windows');
  await assertNotReparsePoint(dir);
  const owner = identity ?? (await currentUserIdentity());
  const rows = parseIcacls(await icacls([dir]), dir);
  const problems = aclViolations(rows, owner);
  if (problems.length > 0) {
    throw new AclError('acl_insecure', `${dir} is not private: ${problems.join('; ')}`);
  }
  return rows.length;
}

/**
 * Verify one file's own ACEs are explicitly restricted (children inherit the
 * directory grants on creation, and this re-checks the result rather than
 * assuming inheritance did what was intended).
 * @param {string} file - absolute file path.
 * @param {string | {sid: string, name?: string}} identity - the current user.
 * @returns {Promise<void>} resolves for a restricted file.
 */
export async function verifyFile(file, identity) {
  if (!isWindows()) throw new AclError('acl_unsupported_platform', 'Windows ACL verification requires Windows');
  // The file inherits the verified directory's grants; inherited rows are fine
  // as long as they name the same three principals.
  const problems = aclViolations(parseIcacls(await icacls([file]), file), identity, { allowInherited: true });
  if (problems.length > 0) throw new AclError('acl_insecure', `${file} is not private: ${problems.join('; ')}`);
}

export const aclInternals = { currentUserSid, currentUserIdentity, icacls };



