#!/usr/bin/env node
/** Restore only wait-profile/timeout fields from an installer backup. A later
 * user edit wins. Never restore a whole private config over unrelated changes. */
import {readFile} from "node:fs/promises";
import {pathToFileURL} from "node:url";
import {resolve} from "node:path";
import {atomicInstallText, readConfigSnapshot} from "./setup-engine.js";
import {codexConfigPath, claudeConfigPath} from "./setup-desktop.js";

function table(text: string): string | undefined {
  return /^\[mcp_servers\.dsh_desktop\][^\r\n]*\r?\n[^]*?(?=^\s*\[|(?![^]))/m.exec(text)?.[0];
}

export function rollbackWaitConfig(caller: "codex" | "claude", current: string, backup: string): string {
  if (caller === "claude") {
    const now = JSON.parse(current); const before = JSON.parse(backup);
    const entry = now.mcpServers?.dsh_desktop;
    const old = before.mcpServers?.dsh_desktop;
    if (!entry || !old) throw new Error("rollback requires the dsh_desktop entry in current config and backup");
    if (entry.env?.DSH_WAIT_PROFILE === "long") {
      if (old.env?.DSH_WAIT_PROFILE === undefined) delete entry.env.DSH_WAIT_PROFILE;
      else entry.env.DSH_WAIT_PROFILE = old.env.DSH_WAIT_PROFILE;
    }
    // This installer only raises a value below 960000. A higher user value was
    // never owned, and any value subsequently edited must survive rollback.
    if (entry.timeout === 960_000 && (old.timeout === undefined || old.timeout < 960_000)) {
      if (old.timeout === undefined) delete entry.timeout;
      else entry.timeout = old.timeout;
    }
    return `${JSON.stringify(now, null, 2)}\n`;
  }
  const present = table(current); const previous = table(backup);
  if (!present || !previous) throw new Error("rollback requires the dsh_desktop table in current config and backup");
  let result = present;
  const oldProfile = /DSH_WAIT_PROFILE\s*=\s*"(bounded|long)"/.exec(previous)?.[0];
  if (/DSH_WAIT_PROFILE\s*=\s*"long"/.test(result)) {
    result = oldProfile ? result.replace(/DSH_WAIT_PROFILE\s*=\s*"long"/, oldProfile)
      : result.replace(/,?\s*DSH_WAIT_PROFILE\s*=\s*"long"\s*,?/, match => match.trim().startsWith(",") && match.trim().endsWith(",") ? "," : "");
  }
  const oldTimeout = /^\s*tool_timeout_sec\s*=\s*(\d+)[^\r\n]*/m.exec(previous);
  if ((oldTimeout === null || Number(oldTimeout[1]) < 960) && /^\s*tool_timeout_sec\s*=\s*960\s*(?:#.*)?$/m.test(result)) {
    result = result.replace(/^\s*tool_timeout_sec\s*=\s*960[^\r\n]*\r?\n?/m, oldTimeout ? `${oldTimeout[0].trimStart()}\n` : "");
  }
  return current.replace(present, result);
}

async function main() {
  const args = process.argv.slice(2);
  const value = (key: string) => args[args.indexOf(key) + 1];
  const caller = value("--caller"); const backup = value("--backup");
  if (!args.includes("--caller") || !["codex", "claude"].includes(caller ?? "") || !args.includes("--backup") || !backup) throw new Error("use --caller codex|claude --backup <installer backup> [--project <directory>] [--apply]");
  const project = args.includes("--project") ? value("--project") : undefined;
  if (args.includes("--project") && !project) throw new Error("--project requires a directory");
  const scope = project ? "project" : "user";
  const path = caller === "codex" ? codexConfigPath(scope, resolve(project ?? ".")) : claudeConfigPath(scope, resolve(project ?? "."));
  const snapshot = await readConfigSnapshot(path);
  if (!snapshot.exists) throw new Error("current config is missing");
  const content = rollbackWaitConfig(caller as "codex" | "claude", snapshot.content, await readFile(resolve(backup), "utf8"));
  if (content === snapshot.content) { console.log("no owned wait fields to restore"); return; }
  if (!args.includes("--apply")) { console.log(`would restore owned wait fields in ${path}; later user edits are preserved`); return; }
  const result = await atomicInstallText({path, content, expected:snapshot, backupLabel:"dsh-wait-rollback"});
  console.log(JSON.stringify({restored:path,backup:result.backupPath}));
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) void main().catch(error => {console.error(error instanceof Error ? error.message : String(error));process.exitCode=1;});
