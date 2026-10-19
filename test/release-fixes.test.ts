import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { BridgeService } from "../src/bridge-service.js";
import type { BridgeConfig } from "../src/config.js";
import { EventLedger } from "../src/event-ledger.js";
import { createHostAdapter } from "../src/host-adapters/factory.js";
import { createMcpServer } from "../src/mcp-server.js";
import { applyPlan, buildPlan } from "../src/setup-desktop.js";
import { TaskStore } from "../src/task-store.js";
import { FakeConnection, FakeDshApi } from "./support/fakes.js";

function parseToolText(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const block = result.content[0];
  if (block?.type !== "text") throw new Error("expected text tool result");
  return JSON.parse(block.text) as Record<string, unknown>;
}

async function pairedFixture() {
  const home = await mkdtemp(join(tmpdir(), "dsh-cowork-fix-"));
  const cwd = await mkdtemp(join(tmpdir(), "dsh-cowork-fix-cwd-"));
  const api = new FakeDshApi();
  const tasks = new TaskStore(home);
  const ledger = new EventLedger(home);
  const config: BridgeConfig = {
    hostUrl: "http://127.0.0.1:3080",
    homeDir: home,
    requestTimeoutMs: 1_000,
    allowRemoteHost: false,
    hostMode: "desktop-paired",
  } as BridgeConfig;
  const service = new BridgeService(config, api, tasks, new FakeConnection(ledger), ledger);
  const cleanup = async () => {
    await rm(home, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  };
  return { api, service, cwd, cleanup };
}

test("desktop profile advertises no model routing on delegate or followup", async () => {
  const { service, cleanup } = await pairedFixture();
  const server = createMcpServer(service, { toolProfile: "desktop" });
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    assert.doesNotMatch(client.getInstructions() ?? "", /modlens|Flash Vision|visualIntent/i);
    const tools = (await client.listTools()).tools;
    for (const name of ["dsh_delegate", "dsh_followup", "dsh_continue"]) {
      const tool = tools.find((entry) => entry.name === name);
      assert.ok(tool, `${name} is registered`);
      const properties = Object.keys((tool.inputSchema as { properties?: object }).properties ?? {});
      for (const field of ["modelProfile", "reasoningEffort", "visualIntent", "complexity", "selectionReason"]) {
        assert.ok(!properties.includes(field), `${name} must not expose ${field}`);
      }
      assert.doesNotMatch(tool.description ?? "", /modlens|choose pro|selectModel/i);
    }
    const delegate = tools.find((entry) => entry.name === "dsh_delegate")!;
    assert.ok(!Object.keys((delegate.inputSchema as { properties?: object }).properties ?? {}).includes("agentPreset"));

    // A caller that sends a routing field anyway is rejected by the schema.
    const rejected = await client.callTool({
      name: "dsh_delegate",
      arguments: { prompt: "x", cwd: "C:\\x", modelProfile: "pro" },
    });
    assert.equal(rejected.isError, true);
  } finally {
    await client.close();
    await server.close();
    await cleanup();
  }
});

test("legacy profile keeps the upstream routing surface", async () => {
  const { service, cleanup } = await pairedFixture();
  const server = createMcpServer(service, { toolProfile: "legacy" });
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const delegate = (await client.listTools()).tools.find((entry) => entry.name === "dsh_delegate")!;
    assert.ok(Object.keys((delegate.inputSchema as { properties?: object }).properties ?? {}).includes("modelProfile"));
  } finally {
    await client.close();
    await server.close();
    await cleanup();
  }
});

test("paired mode refuses a model route before creating any DSH session", async () => {
  const { api, service, cwd, cleanup } = await pairedFixture();
  try {
    await assert.rejects(
      service.delegate({ prompt: "do it", cwd, modelProfile: "pro" }),
      (error: unknown) => (error as { code?: string }).code === "model_policy_inherit",
    );
    await assert.rejects(
      service.delegate({ prompt: "do it", cwd, agentPreset: "custom" }),
      (error: unknown) => (error as { code?: string }).code === "model_policy_inherit",
    );
    assert.equal(api.calls.filter((call) => call.method === "session.create").length, 0, "no session was created");
  } finally {
    await cleanup();
  }
});

test("paired adapter starts without a published connection and reports why", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-cowork-noconn-"));
  try {
    const selection = await createHostAdapter({
      hostUrl: "http://127.0.0.1:3080",
      homeDir: dir,
      requestTimeoutMs: 1_000,
      allowRemoteHost: false,
      hostMode: "desktop-paired",
      connectionFile: join(dir, "missing", "connection.json"),
    } as BridgeConfig);
    assert.match(selection.summary, /not connected yet/u);
    const problem = (selection.adapter as unknown as { connectionProblem(): string | undefined }).connectionProblem();
    assert.equal(typeof problem, "string");
    await selection.adapter.disconnect();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("setup --apply refuses to register a placeholder connection file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-cowork-setup-noconn-"));
  const saved = { file: process.env.DSH_CONNECTION_FILE, local: process.env.LOCALAPPDATA };
  delete process.env.DSH_CONNECTION_FILE;
  // Point the descriptor scan at an empty directory so no real publication is found.
  process.env.LOCALAPPDATA = dir;
  try {
    const plan = await buildPlan({
      caller: "codex",
      scope: "project",
      dryRun: false,
      apply: true,
      replace: false,
      uninstall: false,
      projectDir: dir,
      entry: "C:\\tools\\dist\\index.js",
    });
    assert.equal(plan.desktop.connectionFile, undefined);
    const applied = await applyPlan(plan);
    assert.equal(applied.changed.length, 0);
    assert.equal(applied.refused.length, 1);
    assert.match(applied.refused[0]!, /no published connection\.json/u);
  } finally {
    if (saved.file === undefined) delete process.env.DSH_CONNECTION_FILE;
    else process.env.DSH_CONNECTION_FILE = saved.file;
    if (saved.local === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = saved.local;
    await rm(dir, { recursive: true, force: true });
  }
});
