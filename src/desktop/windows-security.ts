/**
 * Windows-side verification of a published connection.
 *
 * Three questions have to be answered with operating-system evidence before a
 * launch token may be sent anywhere:
 *   1. Is the descriptor file actually private? (NTFS DACL, not chmod)
 *   2. Is the PID the descriptor names still alive?
 *   3. Is that PID's creation time the one the descriptor reports, and does it
 *      own the listening socket of the origin being targeted?
 *
 * Evidence comes from `icacls`, `wmic`-free CIM alternatives, and
 * `Get-NetTCPConnection` through PowerShell — all built into Windows. Child
 * stdio is delivered through file descriptors rather than pipes so the probe
 * also works inside a confined parent.
 *
 * @module desktop/windows-security
 */

import { spawn } from "node:child_process";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type SecurityProblemCode =
  | "connection_file_insecure"
  | "desktop_not_running"
  | "host_identity_mismatch"
  | "connector_missing";

export class SecurityProblem extends Error {
  constructor(
    readonly code: SecurityProblemCode,
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "SecurityProblem";
  }
}

const FORBIDDEN_PRINCIPALS = [
  "everyone",
  "users",
  "authenticated users",
  "interactive",
  "anonymous logon",
  "guest",
  "guests",
  "network",
  "service",
  "remote interactive logon log",
];

/**
 * Windows built-in tools by absolute path. A bare "whoami.exe" can resolve to a
 * GNU coreutils whoami (Git for Windows puts one on PATH) that rejects /user.
 */
const SYSTEM32 = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
export const WINDOWS_TOOLS = {
  whoami: join(SYSTEM32, "whoami.exe"),
  icacls: join(SYSTEM32, "icacls.exe"),
  powershell: join(SYSTEM32, "WindowsPowerShell", "v1.0", "powershell.exe"),
} as const;

/**
 * The current user as icacls may print it: `*SID` when the name cannot be
 * resolved, otherwise `DOMAIN\name`. Both forms count as "this user".
 */
export interface UserIdentity {
  sid: string;
  name?: string;
}

const normalizeIdentity = (identity: string | UserIdentity): string[] => {
  const value = typeof identity === "string" ? { sid: identity } : identity;
  return [value.sid, value.name]
    .filter((entry): entry is string => typeof entry === "string" && entry !== "")
    .map((entry) => entry.toLowerCase().replace(/^\*/u, ""));
};

const mayHoldRights = (principal: string, self: readonly string[]): boolean =>
  self.includes(principal.replace(/^\*/u, "")) ||
  principal === "nt authority\\system" ||
  principal === "system" ||
  principal === "administrators" ||
  principal === "builtin\\administrators";

export interface Ace {
  principal: string;
  rights: string;
  inherited: boolean;
  raw: string;
}

/**
 * Parse `icacls` output into ACE rows.
 *
 * `icacls` prints the path once, before the first ACE of the set; passing that
 * path lets the parser strip it so the first row's principal is not mistaken for
 * `path principal`. Continuation lines carry no path.
 *
 * @param stdout - raw icacls listing.
 * @param pathPrefix - the path the listing was produced for, when known.
 * @returns parsed rows.
 */
export function parseIcacls(stdout: string, pathPrefix?: string): Ace[] {
  const rows: Ace[] = [];
  for (const line of stdout.split(/\r?\n/u)) {
    const trimmed = line.trim();
    const match = /^(\S.*?):((?:\([^)]*\))+)\s*$/u.exec(trimmed);
    if (match === null) continue;
    let principal = match[1]!.trim();
    if (pathPrefix !== undefined && pathPrefix !== "") {
      const candidate = principal.toLowerCase();
      const prefix = pathPrefix.trim().toLowerCase();
      if (candidate === prefix) continue;
      if (candidate.startsWith(`${prefix} `)) principal = principal.slice(pathPrefix.trim().length + 1).trim();
    }
    rows.push({
      principal: principal.toLowerCase(),
      rights: match[2]!,
      inherited: match[2]!.includes("(I)"),
      raw: trimmed,
    });
  }
  return rows;
}

/**
 * Judge one directory's DACL against the private-file policy.
 * @param rows - parsed ACEs.
 * @param identity - current user SID, or SID plus `DOMAIN\name`.
 * @returns violations; empty means acceptable.
 */
export function aclViolations(rows: Ace[], identity: string | UserIdentity): string[] {
  const self = normalizeIdentity(identity);
  const problems: string[] = [];
  if (rows.length === 0) problems.push("no explicit access entry exists");
  for (const row of rows) {
    if (row.inherited) {
      problems.push(`inherited entry grants access: ${row.raw}`);
      continue;
    }
    if (mayHoldRights(row.principal, self)) continue;
    if (FORBIDDEN_PRINCIPALS.includes(row.principal)) {
      problems.push(`broad principal holds rights: ${row.raw}`);
      continue;
    }
    problems.push(`unexpected principal holds rights: ${row.raw}`);
  }
  return problems;
}

/**
 * Run one Windows utility without piping its stdio.
 * @param exe - executable name.
 * @param args - arguments.
 * @returns captured stdout/stderr and exit code.
 */
async function runCaptured(exe: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  const scratch = await mkdtemp(join(tmpdir(), "dsh-cowork-probe-"));
  try {
    const stdoutHandle = await open(join(scratch, "out.txt"), "w");
    const stderrHandle = await open(join(scratch, "err.txt"), "w");
    try {
      const child = spawn(exe, args, { stdio: ["ignore", stdoutHandle.fd, stderrHandle.fd], windowsHide: true });
      const code = await new Promise<number>((resolve) => {
        const timer = setTimeout(() => child.kill(), 20_000);
        child.once("error", () => {
          clearTimeout(timer);
          resolve(-1);
        });
        child.once("close", (exitCode) => {
          clearTimeout(timer);
          resolve(exitCode ?? -1);
        });
      });
      return {
        stdout: await readFile(join(scratch, "out.txt"), "utf8"),
        stderr: await readFile(join(scratch, "err.txt"), "utf8"),
        code,
      };
    } finally {
      await stdoutHandle.close().catch(() => undefined);
      await stderrHandle.close().catch(() => undefined);
    }
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Resolve the current user's SID.
 * @returns SID text.
 */
export async function currentUserSid(): Promise<string> {
  return (await currentUserIdentity()).sid;
}

/**
 * Resolve the current user's SID and `DOMAIN\name` from `whoami /user`.
 * @returns the identity icacls may print for this user.
 */
export async function currentUserIdentity(): Promise<UserIdentity> {
  const result = await runCaptured(WINDOWS_TOOLS.whoami, ["/user", "/fo", "csv", "/nh"]);
  return parseWhoamiUser(result.stdout);
}

/**
 * Parse `whoami /user /fo csv /nh` output: `"domain\name","S-1-5-..."`.
 * @param stdout - whoami output.
 * @returns the identity.
 */
export function parseWhoamiUser(stdout: string): UserIdentity {
  const csv = /"([^"]+)","(S-\d-\d+(?:-\d+)+)"/u.exec(stdout);
  if (csv !== null) return { name: csv[1]!, sid: csv[2]! };
  const bare = /(S-\d-\d+(?:-\d+)+)/u.exec(stdout);
  if (bare === null) {
    throw new SecurityProblem("connection_file_insecure", "cannot resolve the current Windows user SID");
  }
  return { sid: bare[1]! };
}

/**
 * Prove the private directory is not readable by any other ordinary account.
 * @param dir - absolute directory containing `connection.json`.
 * @returns the number of explicit ACEs that hold rights.
 */
export async function assertPrivateDirectory(dir: string): Promise<number> {
  if (process.platform !== "win32") {
    throw new SecurityProblem("connection_file_insecure", "the first version verifies Windows NTFS DACLs only");
  }
  const identity = await currentUserIdentity();
  const result = await runCaptured(WINDOWS_TOOLS.icacls, [dir]);
  if (result.code !== 0) {
    throw new SecurityProblem("connection_file_insecure", `cannot read the access policy of ${dir}`);
  }
  const rows = parseIcacls(result.stdout, dir);
  const problems = aclViolations(rows, identity);
  if (problems.length > 0) {
    throw new SecurityProblem("connection_file_insecure", `${dir} is not private: ${problems.join("; ")}`, {
      problems,
    });
  }
  return rows.length;
}

export interface ProcessFacts {
  pid: number;
  createdAt: number;
  running: boolean;
}

/**
 * PowerShell that prints `present <ISO-8601 UTC>` or `absent` for one PID.
 *
 * Must run on Windows PowerShell 5.1, the only PowerShell every Windows ships:
 * `Get-Date -AsUTC` is PowerShell 7+, so convert with ToUniversalTime() instead.
 * @param pid - process id.
 * @returns the -Command script.
 */
export function processFactsScript(pid: number): string {
  return [
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${String(pid)}" -ErrorAction SilentlyContinue`,
    'if ($null -eq $p) { "absent"; exit 0 }',
    '"present " + $p.CreationDate.ToUniversalTime().ToString("o")',
  ].join("; ");
}

/**
 * Read a PID's native creation time and liveness.
 * @param pid - process id.
 * @returns process facts, with `running: false` when the PID is gone.
 */
export async function readProcessFacts(pid: number): Promise<ProcessFacts> {
  const result = await runCaptured(WINDOWS_TOOLS.powershell, ["-NoProfile", "-NonInteractive", "-Command", processFactsScript(pid)]);
  const text = result.stdout.trim();
  if (text.startsWith("absent") || text === "") return { pid, createdAt: 0, running: false };
  const stamp = /present\s+(\S+)/u.exec(text)?.[1];
  const createdAt = stamp === undefined ? Number.NaN : Date.parse(stamp);
  return { pid, createdAt, running: true };
}

/**
 * Read the PID that owns the listening socket of one local port.
 * @param port - TCP port.
 * @returns owning PID, or undefined when nothing listens.
 */
export async function readListenerPid(port: number): Promise<number | undefined> {
  const script = [
    `$c = Get-NetTCPConnection -LocalPort ${String(port)} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1`,
    'if ($null -eq $c) { "absent"; exit 0 }',
    '"owner " + $c.OwningProcess',
  ].join("; ");
  const result = await runCaptured(WINDOWS_TOOLS.powershell, ["-NoProfile", "-NonInteractive", "-Command", script]);
  const match = /owner\s+(\d+)/u.exec(result.stdout);
  return match === null ? undefined : Number(match[1]);
}

/**
 * Check whether two creation timestamps describe the same process start.
 * @param reported - timestamp the Host published.
 * @param actual - timestamp Windows reports.
 * @param toleranceMs - allowed difference.
 * @returns whether they agree.
 */
export function sameProcessStart(reported: number, actual: number, toleranceMs: number): boolean {
  if (!Number.isFinite(actual) || actual <= 0) return false;
  return Math.abs(reported - actual) <= toleranceMs;
}


