import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { waitWithPolicy, compactWait, type WaitView } from "../src/wait-policy.js";
import { BridgeService } from "../src/bridge-service.js";
import { EventLedger } from "../src/event-ledger.js";
import { TaskStore } from "../src/task-store.js";
import { createMcpServer } from "../src/mcp-server.js";
import { loadConfig } from "../src/config.js";
import { applyCodexTable, applyClaudeEntry, renderCodexBlock } from "../src/setup-desktop.js";
import { FakeConnection, FakeDshApi } from "./support/fakes.js";

function view(cursor = 0, execution = "running"): WaitView {
  return { taskId: "dsh_000000000001", rootSessionId: "root", cursor, execution, lastKnownExecutionStatus: execution,
    availability: "connected", pendingInteractions: [], connection: { revision: cursor + 1 }, recovery: { state: "reconciled" },
    finalMessageStatus: "not_available", contentUnavailable: false, queueDepth: { known: false, total: 0 } };
}

test("42 ordinary events are absorbed; change default returns the first", async () => {
  for (const until of ["terminal", "change"] as const) {
    let events = 0;
    const result = await waitWithPolicy({ timeoutSec: 1, options: { until }, read: async () => view(events, events === 42 ? "turn_completed" : "running"),
      wait: async () => { events++; } });
    assert.equal(events, until === "terminal" ? 42 : 1);
    assert.equal(result.wakeReason, until === "terminal" ? "terminal" : "change");
    assert.ok(Buffer.byteLength(JSON.stringify(compactWait(result))) <= 1024);
  }
});

test("interactions, availability and recovery interrupt terminal waiting", async () => {
  for (const [patch, reason] of [
    [{ pendingInteractions: [{ requestId: "q1", payload: { type: "question/requested", questions: ["Question?"] } }] }, "interaction"],
    [{ availability: "host_unreachable" }, "availability"],
    [{ recovery: { state: "gap", reason: "unrecoverable" } }, "observation_error"],
  ] as const) {
    const result = await waitWithPolicy({ timeoutSec: 1, options: { until: "terminal" }, read: async () => ({ ...view(), ...patch }),
      wait: async () => { assert.fail("meaningful state must return immediately"); } });
    assert.equal(result.wakeReason, reason);
    const compact = compactWait(result);
    if (reason === "interaction") assert.deepEqual(compact.pendingInteractions, patch.pendingInteractions);
  }
});

test("zero timeout and elapsed deadlines never cancel the task", async () => {
  let waits = 0;
  const immediate = await waitWithPolicy({ timeoutSec: 0, options: { until: "terminal" }, read: async () => view(), wait: async () => { waits++; } });
  assert.equal(immediate.timedOut, true); assert.equal(waits, 0);
  const start = performance.now();
  const result = await waitWithPolicy({ timeoutSec: 0.06, options: { until: "terminal" }, read: async () => view(++waits),
    wait: async (_c, _r, remaining) => { await new Promise(r => setTimeout(r, Math.min(10, remaining))); } });
  assert.equal(result.timedOut, true);
  assert.ok(performance.now() - start < 500);
});

test("canceling the observer aborts its wait without a task mutation", async () => {
  const controller = new AbortController();
  let cleaned = false;
  const promise = waitWithPolicy({ timeoutSec: 30, options: { until: "terminal", signal: controller.signal }, read: async () => view(),
    wait: async (_c, _r, _ms, signal) => new Promise<void>(resolve => signal.addEventListener("abort", () => { cleaned = true; resolve(); }, { once: true })) });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(promise); assert.equal(cleaned, true);
});

test("initial RPC synchronization is included in the deadline", async () => {
  const start = performance.now();
  await assert.rejects(waitWithPolicy({ timeoutSec: 0.02, options: {}, read: async () => new Promise<WaitView>(() => {}), wait: async () => {} }),
    (e: any) => e.code === "observation_timeout");
  assert.ok(performance.now() - start < 500);
});

test("a snapshot crossing the deadline returns timeout with the last known state", async () => {
  const result = await waitWithPolicy({ timeoutSec: 0.02, options: { until: "terminal" },
    read: async initial => initial ? view() : new Promise<WaitView>(() => {}), wait: async () => {} });
  assert.equal(result.timedOut, true); assert.equal(result.status.execution, "running");
});

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "dsh-supervision-"));
  const api = new FakeDshApi(); const tasks = new TaskStore(home); const ledger = new EventLedger(home);
  const connection = new FakeConnection(ledger);
  const service = new BridgeService({ homeDir: home, hostUrl: "http://127.0.0.1:3080", requestTimeoutMs: 1000, allowRemoteHost: false }, api, tasks, connection, ledger);
  const task = await service.delegate({ cwd: home, prompt: "fixture", waitSeconds: 0 });
  let seq = 0;
  const event = async (type: string, data: unknown = {}) => ledger.append(task.taskId, { sourceSessionId: task.rootSessionId, origin: "root", type: "session/event", sourceSeq: ++seq,
    raw: { type: "session/event", sessionId: task.rootSessionId, event: { type, seq, time: seq, data } } });
  return { home, api, ledger, connection, service, task, event };
}

test("queued target excludes old completion; restart retains binding; ambiguity fails closed", async () => {
  const f = await fixture();
  try {
    await f.event("turn/start"); await f.event("assistant/message", { content: "old" }); await f.event("turn/end", { reason: { kind: "completed" } });
    f.connection.lineage[0]!.running = false;
    const receipt = await f.service.continueTask(f.task.taskId, "next", "queue");
    const target = receipt.waitTarget!.targetStartAfterCursor;
    const waiting: any = await f.service.wait(f.task.taskId, 0, undefined, { until: "terminal", responseMode: "compact", targetStartAfterCursor: target });
    assert.equal(waiting.timedOut, true); assert.equal(waiting.execution, "starting");
    assert.equal(waiting.finalMessagePointer, undefined);
    const waitingFull: any = await f.service.wait(f.task.taskId, 0, undefined, { until: "terminal", targetStartAfterCursor: target });
    assert.equal(waitingFull.status.status, "starting"); assert.equal(waitingFull.status.finalMessage, null);
    await f.event("turn/start");
    await f.event("user/message", { source: { rpcId: receipt.issuedRpcId } });
    assert.equal((await f.ledger.snapshot(f.task.taskId)).finalMessagePointer, undefined);
    await f.event("assistant/message", { content: "new" }); await f.event("turn/end", { reason: { kind: "completed" } });
    const done: any = await f.service.wait(f.task.taskId, 0, undefined, { until: "terminal", responseMode: "compact", targetStartAfterCursor: target });
    assert.equal(done.wakeReason, "terminal"); assert.ok(done.observedRunStartCursor > target);
    assert.equal((await new EventLedger(f.home).targetRun(f.task.taskId, target)).startCursor, done.observedRunStartCursor);
    await f.event("turn/start");
    await assert.rejects(f.service.wait(f.task.taskId, 0, undefined, { until: "terminal", targetStartAfterCursor: target }), (e: any) => e.code === "ambiguous_wait_target");
    const tail = await f.ledger.tail(f.task.taskId, done.finalMessageAfterCursor, 1);
    assert.equal(tail.records[0]?.sourceSeq, done.finalMessagePointer.seq);
  } finally { await rm(f.home, { recursive: true, force: true }); }
});

test("a manually started run cannot satisfy a queued bridge wait target", async () => {
  const f = await fixture();
  try {
    const receipt = await f.service.continueTask(f.task.taskId, "next", "queue");
    await f.event("turn/start"); await f.event("user/message", { source: { rpcId: "manual-prompt" } });
    await f.event("turn/end", { reason: { kind: "completed" } });
    await assert.rejects(f.service.wait(f.task.taskId, 0, undefined, { until: "terminal", ...receipt.waitTarget }), (e: any) => e.code === "ambiguous_wait_target");
  } finally { await rm(f.home, { recursive: true, force: true }); }
});

test("abort removes a ledger observer while later events still persist", async () => {
  const f = await fixture();
  try {
    const cursor = (await f.ledger.snapshot(f.task.taskId)).cursor;
    const controller = new AbortController();
    const promise = f.ledger.waitForCursor(f.task.taskId, cursor, 30000, controller.signal);
    setTimeout(() => controller.abort(), 15);
    await assert.rejects(promise);
    await f.event("turn/start");
    assert.ok((await f.ledger.snapshot(f.task.taskId)).cursor > cursor);
  } finally { await rm(f.home, { recursive: true, force: true }); }
});

test("release refuses busy, unknown queue and unknown jobs, preserving the claim", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.service.releaseWorkspace(f.task.taskId), (e: any) => e.code === "session_busy");
    await f.event("turn/start"); await f.event("turn/end", { reason: { kind: "completed" } });
    f.connection.lineage[0]!.running = false;
    f.connection.queue.known = false;
    await assert.rejects(f.service.releaseWorkspace(f.task.taskId), (e: any) => e.code === "workspace_state_unknown");
    f.connection.queue.known = true; f.connection.jobs.known = false;
    await assert.rejects(f.service.releaseWorkspace(f.task.taskId), (e: any) => e.code === "workspace_state_unknown");
    assert.ok((await f.service.status(f.task.taskId)).workspaceClaim);
    f.connection.jobs.known = true;
    assert.equal((await f.service.releaseWorkspace(f.task.taskId)).sessionClosedByRelease, false);
  } finally { await rm(f.home, { recursive: true, force: true }); }
});

test("real MCP schemas support both profiles, preserve old shape and enforce bounded limits", async () => {
  for (const toolProfile of ["desktop", "legacy"] as const) {
    const f = await fixture(); const server = createMcpServer(f.service, { toolProfile });
    const client = new Client({ name: "supervision-test", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(a); await client.connect(b);
      const call = async (args: Record<string, unknown>) => {
        const r = await client.callTool({ name: "dsh_wait", arguments: { taskId: f.task.taskId, timeoutSec: 0, ...args } });
        const text = (r.content as any)[0].text;
        return { raw: r, body: text.startsWith("{") ? JSON.parse(text) : { message: text } };
      };
      assert.ok((await call({})).body.status);
      const compact = await call({ until: "terminal", responseMode: "compact" });
      assert.equal(compact.body.schemaVersion, 1); assert.equal(compact.body.status, undefined);
      assert.equal((await call({ timeoutSec: 31 })).raw.isError, true);
      assert.equal((await call({ targetStartAfterCursor: 0 })).raw.isError, true);
      const listed = await client.listTools();
      assert.equal(listed.tools.some(t => t.name === "dsh_answer_question"), toolProfile === "legacy");
    } finally { await client.close(); await server.close(); await rm(f.home, { recursive: true, force: true }); }
  }
});

test("installation preserves custom fields/env and long mode is opt-in", () => {
  assert.equal(loadConfig({}).waitProfile, "bounded"); assert.throws(() => loadConfig({ DSH_WAIT_PROFILE: "wrong" }));
  const block = renderCodexBlock("node", "index.js", { DSH_HOST_MODE: "desktop-paired" });
  const old = '[mcp_servers.dsh_desktop]\ncommand = "old"\nargs = []\ntool_timeout_sec = 180\nenabled = false\nenv = { CUSTOM = "keep", DSH_HOST_MODE = "old" }\n';
  const merged = applyCodexTable(old, block);
  assert.match(merged, /CUSTOM = "keep"/); assert.match(merged, /enabled = false/); assert.match(merged, /tool_timeout_sec = 180/);
  assert.equal(applyCodexTable(merged, block), merged);
  const long = applyCodexTable(merged, renderCodexBlock("node", "index.js", { DSH_WAIT_PROFILE: "long" }));
  assert.match(long, /tool_timeout_sec = 960/); assert.match(long, /CUSTOM = "keep"/);
  const json = JSON.parse(applyClaudeEntry(JSON.stringify({ mcpServers: { dsh_desktop: { custom: true, env: { CUSTOM: "keep" } }, other: { command: "other" } } }), { command: "node", env: { DSH_HOST_MODE: "desktop-paired" } }));
  assert.equal(json.mcpServers.dsh_desktop.custom, true); assert.equal(json.mcpServers.dsh_desktop.env.CUSTOM, "keep"); assert.ok(json.mcpServers.other);
});
