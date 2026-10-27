#!/usr/bin/env node
/** Restore only wait-profile/timeout fields from an installer backup. A later
 * user edit wins. Never restore a whole private config over unrelated changes. */
import {assertEditableServers, parseInlineStringTable} from "./toml-edit.js";
import {readFile} from "node:fs/promises";
import {pathToFileURL} from "node:url";
import {resolve} from "node:path";
import {atomicInstallText, readConfigSnapshot} from "./setup-engine.js";
import {codexConfigPath, claudeConfigPath, kimiCodeConfigPath, zcodeConfigPath} from "./setup-desktop.js";

type Caller = "codex" | "claude" | "kimi-code" | "zcode";
export function rollbackWaitConfig(caller: Caller, current: string, backup: string, installedProfile: "adaptive" | "long" = "long"): string {
  const minimum = installedProfile === "adaptive" ? 360 : 960;
  if (caller !== "codex") {
    const now = JSON.parse(current), before = JSON.parse(backup);
    const servers = (v: any) => caller === "zcode" ? v.mcp?.servers : v.mcpServers;
    const entry = servers(now)?.dsh_desktop, old = servers(before)?.dsh_desktop;
    if (!entry || !old) throw new Error("rollback requires the dsh_desktop entry in current config and backup");
    // Explicit installed profile makes a later profile change user-owned.
    if (entry.env?.DSH_WAIT_PROFILE !== installedProfile) return current;
    if (old.env?.DSH_WAIT_PROFILE === undefined) delete entry.env.DSH_WAIT_PROFILE;
    else entry.env.DSH_WAIT_PROFILE = old.env.DSH_WAIT_PROFILE;
    const key = caller === "kimi-code" ? "toolTimeoutMs" : caller === "claude" ? "timeout" : undefined;
    if (key && entry[key] === minimum * 1000 && (old[key] === undefined || old[key] < minimum * 1000)) {
      if (old[key] === undefined) delete entry[key]; else entry[key] = old[key];
    }
    return `${JSON.stringify(now, null, 2)}\n`;
  }
  const fields = (text: string) => assertEditableServers(text,["dsh_desktop"]).filter(s => s.key && s.table.length === 2 && s.table[0] === "mcp_servers" && s.table[1] === "dsh_desktop");
  const present = fields(current), previous = fields(backup);
  if (!present.length || !previous.length) throw new Error("rollback requires the dsh_desktop table in current config and backup");
  const env = present.find(s => s.key![0] === "env"), oldEnv = previous.find(s => s.key![0] === "env");
  if (!env) return current;
  const values = parseInlineStringTable(env.value!), prior = oldEnv ? parseInlineStringTable(oldEnv.value!) : new Map<string,string>();
  if (values.get("DSH_WAIT_PROFILE") !== JSON.stringify(installedProfile)) return current;
  if (prior.has("DSH_WAIT_PROFILE")) values.set("DSH_WAIT_PROFILE", prior.get("DSH_WAIT_PROFILE")!); else values.delete("DSH_WAIT_PROFILE");
  const edits = [{start:env.start,end:env.end,text:`env = { ${[...values].map(([k,v])=>`${/^[A-Za-z0-9_-]+$/.test(k)?k:JSON.stringify(k)} = ${v}`).join(", ")} }`}];
  const timeout = present.find(s=>s.key![0]==="tool_timeout_sec"), oldTimeout = previous.find(s=>s.key![0]==="tool_timeout_sec");
  const numeric = (v: string) => Number(v.split("#")[0]!.trim().replaceAll("_",""));
  if (timeout && numeric(timeout.value!)===minimum && (!oldTimeout || numeric(oldTimeout.value!)<minimum)) {
    edits.push({start:timeout.start,end:timeout.end,text:oldTimeout?`tool_timeout_sec = ${oldTimeout.value}`:""});
  }
  const lines=current.split(/\r?\n/);
  for (const edit of edits.sort((a,b)=>b.start-a.start)) lines.splice(edit.start,edit.end-edit.start,...(edit.text?[edit.text]:[]));
  return lines.join("\n");
}

async function main() {
  const args = process.argv.slice(2);
  const value = (key: string) => args[args.indexOf(key) + 1];
  const caller = value("--caller"); const backup = value("--backup");
  if (!args.includes("--caller") || !["codex", "claude", "kimi-code", "zcode"].includes(caller ?? "") || !args.includes("--backup") || !backup) throw new Error("use --caller codex|claude|kimi-code|zcode --backup <installer backup> [--profile adaptive|long] [--project <directory>] [--apply]");
  const project = args.includes("--project") ? value("--project") : undefined;
  if (args.includes("--project") && !project) throw new Error("--project requires a directory");
  const scope = project ? "project" : "user";
  const getPath = caller === "codex" ? codexConfigPath : caller === "kimi-code" ? kimiCodeConfigPath : caller === "zcode" ? zcodeConfigPath : claudeConfigPath;
  const path = getPath(scope, resolve(project ?? "."));
  const profile = args.includes("--profile") ? value("--profile") : "long";
  if (profile !== "adaptive" && profile !== "long") throw new Error("--profile must be adaptive or long");
  const snapshot = await readConfigSnapshot(path);
  if (!snapshot.exists) throw new Error("current config is missing");
  const content = rollbackWaitConfig(caller as Caller, snapshot.content, await readFile(resolve(backup), "utf8"), profile);
  if (content === snapshot.content) { console.log("no owned wait fields to restore"); return; }
  if (!args.includes("--apply")) { console.log(`would restore owned wait fields in ${path}; later user edits are preserved`); return; }
  const result = await atomicInstallText({path, content, expected:snapshot, backupLabel:"dsh-wait-rollback"});
  console.log(JSON.stringify({restored:path,backup:result.backupPath}));
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) void main().catch(error => {console.error(error instanceof Error ? error.message : String(error));process.exitCode=1;});
