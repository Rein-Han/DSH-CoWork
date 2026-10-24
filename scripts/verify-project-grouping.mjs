#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { configuredConnectionFile, inspectDesktopHost } from "../dist/desktop/doctor-desktop.js";
import { observeVerification } from "../dist/caller-verification.js";

const CALLERS = new Set(["codex", "claude-code", "zcode", "kimi-code", "kimi-work"]);

function option(argv, name) {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

async function run(argv) {
  const projectArg = option(argv, "--project");
  const bridgeArg = option(argv, "--bridge-home");
  assert.ok(projectArg, "--project <existing project root> is required");
  assert.ok(bridgeArg, "--bridge-home <isolated acceptance home> is required");
  const project = await realpath(resolve(projectArg));
  const requestedCwd = argv.includes("--cwd") ? await realpath(resolve(option(argv, "--cwd"))) : project;
  const child = relative(project, requestedCwd);
  assert.ok(child === "" || (!child.startsWith("..") && !isAbsolute(child)), "--cwd must be the project root or its descendant");
  const callers = (option(argv, "--callers") ?? "codex,claude-code,zcode,kimi-code,kimi-work")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  assert.ok(callers.length > 0 && callers.every((caller) => CALLERS.has(caller)), "unsupported caller list");
  assert.equal(new Set(callers).size, callers.length, "caller list must not contain duplicates");
  const bridgeHome = resolve(bridgeArg);
  await mkdir(join(bridgeHome, "receipts"), { recursive: true });
  const facts = await inspectDesktopHost();
  const connectionFile = facts.connectionFile ?? (await configuredConnectionFile());
  assert.ok(connectionFile, "a published Desktop connection file is required");
  const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));
  const results = [];
  let workspaceId;

  for (const caller of callers) {
    const env = Object.fromEntries(Object.entries(process.env).filter(([, value]) => typeof value === "string"));
    delete env.DSH_HOST_URL;
    delete env.DSH_ALLOW_REMOTE_HOST;
    delete env.DSH_BRIDGE_AGENT_PRESET;
    delete env.DSH_BRIDGE_MODEL_ROUTING;
    Object.assign(env, {
      DSH_HOST_MODE: "desktop-paired",
      DSH_CONNECTION_FILE: connectionFile,
      DSH_BRIDGE_HOME: bridgeHome,
      DSH_CALLER_KIND: caller,
      DSH_WAIT_PROFILE: "bounded",
      DSH_APPROVAL_MODE: "desktop",
      DSH_MODEL_POLICY: "inherit",
    });
    const client = new Client({ name: "dsh-project-grouping-acceptance", version: "1.0.0" });
    const call = async (name, args = {}) => {
      const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 });
      const text = result.content?.filter((item) => item.type === "text").map((item) => item.text).join("\n");
      const data = JSON.parse(text || "{}");
      if (result.isError) throw new Error(`${name}: ${JSON.stringify(data)}`);
      return data;
    };
    try {
      await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry], cwd: project, env, stderr: "inherit" }));
      const deadline = performance.now() + 20000;
      let host;
      do {
        host = await call("dsh_host_status");
        if (host.reachable || host.availability !== "connecting") break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      } while (performance.now() < deadline);
      assert.equal(host.reachable, true, "DSH must be reachable");
      assert.equal(host.adapter.callerKind, caller);
      assert.equal(host.observation.profile, "bounded");

      const marker = `PROJECT_GROUPING_${caller.toUpperCase().replaceAll("-", "_")}_OK`;
      const title = `${caller} project grouping acceptance`;
      const delegated = await call("dsh_delegate", {
        projectRoot: project,
        cwd: requestedCwd,
        title,
        workspaceMode: "read-only",
        waitSeconds: 0,
        prompt: `这是 Desktop 项目归属验收。项目根为 ${project}；请求任务目录（仅任务范围，不是沙箱）为 ${requestedCwd}。不要修改文件或调用工具，只回复 ${marker}。`,
      });
      const workspace = delegated.desktopWorkspace;
      assert.ok(workspace?.workspaceId, "desktopWorkspace evidence is required");
      assert.equal(workspace.path, project);
      assert.equal(workspace.sessionCwd, project);
      assert.equal(workspace.requestedCwd, requestedCwd);
      assert.notEqual(workspace.resolution, "ancestor", "an explicit projectRoot must resolve exactly or be created there");
      assert.equal(delegated.workspaceClaim?.cwd, workspace.sessionCwd);
      if (workspaceId === undefined) workspaceId = workspace.workspaceId;
      assert.equal(workspace.workspaceId, workspaceId, "all callers must reuse the same workspaceId");
      if (results.length > 0) assert.equal(workspace.created, false, "later callers must not create another project");

      const receipt = {
        caller,
        taskId: delegated.taskId,
        rootSessionId: delegated.rootSessionId,
        targetStartAfterCursor: delegated.waitTarget?.targetStartAfterCursor,
        marker,
        bridgeHome,
        project,
        requestedCwd,
        desktopWorkspace: workspace,
      };
      const receiptPath = join(bridgeHome, "receipts", `${delegated.taskId}.json`);
      await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
      console.log(JSON.stringify({ delegated: { caller, taskId: delegated.taskId, rootSessionId: delegated.rootSessionId, receiptPath, desktopWorkspace: workspace } }));

      const observed = await observeVerification(call, delegated.taskId, delegated.waitTarget?.targetStartAfterCursor);
      assert.equal(observed.execution, "turn_completed");
      assert.equal(observed.finalMessage?.trim(), marker);
      assert.ok(observed.release?.released, "normal workspace release is required");
      assert.equal(observed.release?.releaseEvidence?.source, "desktop-live");
      const discovered = await call("dsh_find_sessions", { cwd: project, title, titleMatch: "exact", maxResults: 10, includeBlank: false });
      const session = discovered.sessions?.find((item) => item.sessionId === delegated.rootSessionId);
      assert.ok(session, "created session must be discoverable under the project root");
      assert.equal(session.cwd, project);
      results.push({ caller, taskId: delegated.taskId, rootSessionId: delegated.rootSessionId, receiptPath, desktopWorkspace: workspace, releaseEvidence: observed.release.releaseEvidence });
    } finally {
      await client.close();
    }
  }

  const summary = {
    status: "PASS",
    evidence: "SDK transport and real Desktop Host; native caller UI acceptance is separate",
    desktopVersion: facts.desktopVersion,
    project,
    requestedCwd,
    workspaceId,
    callers: results,
  };
  const summaryPath = join(bridgeHome, "project-grouping-summary.json");
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify({ ...summary, summaryPath }));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await run(process.argv.slice(2));
