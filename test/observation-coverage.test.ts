import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { BridgeConfig } from "../src/config.js";
import { BridgeService } from "../src/bridge-service.js";
import { DshConnectionManager } from "../src/connection-manager.js";
import type { AuthSession } from "../src/desktop/auth-session.js";
import type { ResolvedConnection } from "../src/desktop/connection-resolver.js";
import { EventLedger } from "../src/event-ledger.js";
import { DesktopPairedAdapter } from "../src/host-adapters/desktop-paired/adapter.js";
import { PairedHostAdapter } from "../src/host-adapters/desktop-paired/index.js";
import { TaskStore } from "../src/task-store.js";
import { waitWithPolicy, meaningfulWake, compactWait, type WaitView } from "../src/wait-policy.js";

type Session = { sessionId: string; updatedAt: number; running: boolean; blank: boolean };
type Event = { type: string; seq: number; time: number; data: unknown };

class MemoryHost {
  readonly origin = "http://127.0.0.1:1";
  readonly sessions = new Map<string, Session>();
  readonly histories = new Map<string, Event[]>();
  readonly followers = new Map<string, (event: Event) => void>();
  readonly attempts = new Map<string, number>();
  failOnce = new Set<string>();

  add(sessionId: string, updatedAt: number, running = false): void {
    this.sessions.set(sessionId, { sessionId, updatedAt, running, blank: false });
    this.histories.set(sessionId, running ? [
      { type: "turn/start", seq: 0, time: Date.now(), data: { turn: 1 } },
      { type: "user/message", seq: 1, time: Date.now(), data: { turn: 1, source: { rpcId: "fixture-prompt" } } },
    ] : []);
  }

  async call(endpoint: string, payload: { request?: { sessionId?: string; address?: { sessionId: string } } }) {
    if (endpoint === "session/list") return { items: structuredClone([...this.sessions.values()]) };
    if (endpoint === "session/modelCatalog") return {};
    if (endpoint === "session/projections") {
      const events = this.histories.get(payload.request!.sessionId!)!;
      return { asOfSeq: events.at(-1)?.seq ?? 0, values: {} };
    }
    if (endpoint === "session/page") return {
      records: this.histories.get(payload.request!.address!.sessionId)!.map(event => ({ type: "event", event })), hasMore: false,
    };
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  }

  async *openStream(endpoint: string, payload: { request: { address: { sessionId: string } } }, signal: AbortSignal) {
    assert.equal(endpoint, "session/follow");
    const sessionId = payload.request.address.sessionId;
    this.attempts.set(sessionId, (this.attempts.get(sessionId) ?? 0) + 1);
    if (this.failOnce.delete(sessionId)) throw new Error("fixture stream failure");
    const queue: Event[] = [];
    let wake: (() => void) | undefined;
    this.followers.set(sessionId, event => { queue.push(event); wake?.(); });
    const abort = () => wake?.();
    signal.addEventListener("abort", abort);
    try {
      const records = this.histories.get(sessionId)!.map(event => ({ type: "event", event }));
      yield { type: "item", value: { type: "snapshot", header: { id: sessionId }, cursor: records.at(-1)?.event.seq ?? -1, records, hasMore: false } };
      while (!signal.aborted) {
        if (!queue.length) await new Promise<void>(resolve => { wake = resolve; });
        wake = undefined;
        while (queue.length) yield { type: "item", value: { type: "event", event: queue.shift()! } };
      }
    } finally {
      signal.removeEventListener("abort", abort);
      this.followers.delete(sessionId);
    }
  }

  complete(sessionId: string): void {
    this.sessions.get(sessionId)!.running = false;
    const events = this.histories.get(sessionId)!;
    const event = { type: "turn/end", seq: events.length, time: Date.now(), data: { turn: 1, reason: { kind: "completed" } } };
    events.push(event);
    this.followers.get(sessionId)?.(event);
  }

  dispose(): void {}
}

async function eventually(check: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, "fixture condition timed out");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function adapter(host: MemoryHost) {
  return new DesktopPairedAdapter({ session: host as unknown as AuthSession, protocolFamily: "dsh-host-0.2",
    harnessVersion: "fixture", desktopVersion: "fixture", discoveryIntervalMs: 30 });
}

function pairedAdapter(currentHost: () => MemoryHost) {
  let instance = 0;
  return new PairedHostAdapter({ connectionFile: "fixture", timeoutMs: 1_000, resolve: async () => {
    const host = currentHost();
    return { descriptor: { protocolFamily: "dsh-host-0.2", harnessVersion: "fixture", desktopVersion: "fixture" } as ResolvedConnection["descriptor"],
      session: host as unknown as AuthSession, origin: host.origin, generation: { hostId: "fixture", instanceId: String(++instance) },
      ageMs: 0 };
  } });
}

test("the paired Desktop entry point prioritizes a waited task among 25 running sessions", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "dsh-paired-observation-"));
  const host = new MemoryHost();
  host.add("target", 0, true);
  for (let index = 0; index < 24; index++) host.add(`newer-${index}`, index + 1, true);
  const api = pairedAdapter(() => host);
  const config: BridgeConfig = { homeDir, hostUrl: host.origin, requestTimeoutMs: 1_000, allowRemoteHost: false, hostMode: "desktop-paired" };
  const ledger = new EventLedger(homeDir);
  const tasks = new TaskStore(homeDir);
  const task = await tasks.create("target");
  await ledger.append(task.taskId, { sourceSessionId: "target", origin: "root", type: "bridge/prompt-issued",
    raw: { type: "bridge/prompt-issued", sessionId: "target", mode: "queue", issuedRpcId: "fixture-prompt" } });
  const manager = new DshConnectionManager(config, api, tasks, ledger);
  const service = new BridgeService(config, api, tasks, manager, ledger);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    manager.start();
    await eventually(() => host.followers.size === 24 && !host.followers.has("target") && manager.snapshot().availability === "connected");
    const waiting = service.wait(task.taskId, 2, undefined, { until: "terminal", responseMode: "compact", targetStartAfterCursor: 0 });
    await eventually(() => host.followers.has("target"));
    timer = setTimeout(() => host.complete("target"), 30);
    const result = await waiting;
    assert.equal(result.wakeReason, "terminal");
    assert.equal((result as Record<string, unknown>).execution, "turn_completed");
    assert.deepEqual((result as Record<string, unknown>).observation, { state: "following" });
    assert.ok(host.followers.size <= 24);
  } finally {
    clearTimeout(timer);
    await manager.stop();
    await api.disconnect();
    await rm(homeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("paired observers rebind after a Desktop generation changes", async () => {
  const first = new MemoryHost();
  first.add("target", Date.now(), true);
  const second = new MemoryHost();
  second.add("target", Date.now(), true);
  let host = first;
  const api = pairedAdapter(() => host);
  await api.connect();
  const states: string[] = [];
  const release = api.watchSession("target", () => states.push(api.sessionObservation("target")?.state ?? "missing"));
  const controller = new AbortController();
  const pump = (async () => { for await (const _frame of api.openMux(controller.signal)) {} })();
  try {
    await eventually(() => api.sessionObservation("target")?.state === "following" && first.followers.has("target"));
    host = second;
    await api.disconnect();
    assert.equal(api.sessionObservation("target")?.reason, "generation_unavailable");
    await api.connect();
    await eventually(() => api.sessionObservation("target")?.state === "following" && second.followers.has("target"));
    assert.ok(states.includes("retrying"));
    assert.equal(first.followers.has("target"), false);
    release();
    assert.equal(api.sessionObservation("target"), undefined);
  } finally {
    release();
    controller.abort();
    await pump;
    await api.disconnect();
  }
});

test("a waited task preempts 24 idle follows and completes without a status rescue", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "dsh-observation-"));
  const host = new MemoryHost();
  for (let index = 0; index < 24; index++) host.add(`old-${index}`, index);
  const api = adapter(host);
  const config: BridgeConfig = { homeDir, hostUrl: host.origin, requestTimeoutMs: 1_000, allowRemoteHost: false, hostMode: "desktop-paired" };
  const ledger = new EventLedger(homeDir);
  const tasks = new TaskStore(homeDir);
  const manager = new DshConnectionManager(config, api, tasks, ledger);
  const service = new BridgeService(config, api, tasks, manager, ledger);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    manager.start();
    await eventually(() => host.followers.size === 24 && manager.snapshot().availability === "connected");
    host.add("target", Date.now(), true);
    const task = await tasks.create("target");
    await ledger.append(task.taskId, { sourceSessionId: "target", origin: "root", type: "bridge/prompt-issued",
      raw: { type: "bridge/prompt-issued", sessionId: "target", mode: "queue", issuedRpcId: "fixture-prompt" } });
    await manager.trackTask(task);
    const waiting = service.wait(task.taskId, 2, undefined, { until: "terminal", responseMode: "compact", targetStartAfterCursor: 0 });
    await eventually(() => host.followers.has("target"));
    timer = setTimeout(() => host.complete("target"), 30);
    const result = await waiting;
    const summary = result as Record<string, unknown>;
    assert.equal(result.wakeReason, "terminal");
    assert.equal(summary.execution, "turn_completed");
    assert.deepEqual(summary.observation, { state: "following" });
    assert.ok(host.followers.size <= 24);
    assert.equal((await ledger.snapshot(task.taskId)).execution, "turn_completed");
  } finally {
    clearTimeout(timer);
    await manager.stop();
    await api.disconnect();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("a degraded target wakes promptly and reports its cause", async () => {
  let state: "pending" | "capacity" = "pending";
  const view = (): WaitView => ({ taskId: "target", rootSessionId: "target", cursor: 1, availability: "connected",
    execution: "running", pendingInteractions: [], connection: { revision: 1 }, recovery: { state: "reconciled" },
    observation: { state, ...(state === "capacity" ? { reason: "follow_limit" } : {}) } });
  const result = await waitWithPolicy({ timeoutSec: 2, options: { until: "terminal" }, read: async () => view(),
    wait: async () => { state = "capacity"; } });
  assert.equal(result.wakeReason, "observation_error");
  assert.equal(result.timedOut, false);
  assert.equal((compactWait(result).observation as { reason?: string }).reason, "follow_limit");
  assert.equal(meaningfulWake(view()), "observation_error");
});

test("deadline reports a refreshed terminal state without claiming it arrived before expiry", async context => {
  let clock = 0;
  let completed = false;
  context.mock.method(performance, "now", () => clock);
  const view = (): WaitView => ({ taskId: "target", rootSessionId: "target", cursor: completed ? 2 : 1,
    availability: "connected", execution: completed ? "turn_completed" : "running", pendingInteractions: [],
    connection: { revision: completed ? 2 : 1 }, recovery: { state: "reconciled" } });
  const result = await waitWithPolicy({ timeoutSec: 1, options: { until: "terminal" }, read: async () => view(),
    wait: async () => { completed = true; clock = 1_000; } });
  assert.equal(result.timedOut, true);
  assert.equal(result.status.execution, "turn_completed");
  assert.equal(result.status.snapshotFreshness, "refreshed");
});

test("a blocked deadline read stays bounded and labels the previous snapshot stale", async context => {
  let clock = 0;
  context.mock.method(performance, "now", () => clock);
  let reads = 0;
  const result = await waitWithPolicy({ timeoutSec: 1, options: { until: "terminal" }, read: async () => {
    if (++reads > 1) return new Promise<WaitView>(() => {});
    return { taskId: "target", rootSessionId: "target", cursor: 1, availability: "connected", execution: "running",
      pendingInteractions: [], connection: { revision: 1 }, recovery: { state: "reconciled" } };
  }, wait: async () => { clock = 1_000; } });
  assert.equal(result.timedOut, true);
  assert.equal(result.status.snapshotFreshness, "stale");
  assert.equal(reads, 2);
});

test("a failed deadline read labels the previous snapshot stale", async context => {
  let clock = 0;
  context.mock.method(performance, "now", () => clock);
  let reads = 0;
  const result = await waitWithPolicy({ timeoutSec: 1, options: { until: "terminal" }, read: async (): Promise<WaitView> => {
    if (++reads > 1) throw new Error("fixture read failure");
    return { taskId: "target", rootSessionId: "target", cursor: 1, availability: "connected", execution: "running",
      pendingInteractions: [], connection: { revision: 1 }, recovery: { state: "reconciled" } };
  }, wait: async () => { clock = 1_000; } });
  assert.equal(result.timedOut, true);
  assert.equal(result.status.snapshotFreshness, "stale");
  assert.equal(reads, 2);
});

test("a capped observer receives capacity instead of silent running", async () => {
  const host = new MemoryHost();
  for (let index = 0; index < 25; index++) host.add(`watched-${index}`, index);
  const api = adapter(host);
  const releases = [...host.sessions.keys()].map(sessionId => api.watchSession(sessionId, () => {}));
  const controller = new AbortController();
  const pump = (async () => { for await (const _frame of api.openMux(controller.signal)) {} })();
  try {
    await eventually(() => api.sessionObservation("watched-0")?.state === "capacity");
    assert.equal(host.followers.size, 24);
    assert.equal(api.sessionObservation("watched-0")?.reason, "follow_limit");
    releases.at(-1)!();
    await eventually(() => api.sessionObservation("watched-0")?.state === "following");
  } finally {
    releases.forEach(release => release());
    controller.abort();
    await pump;
    await api.disconnect();
  }
});

test("a failed follow reports retrying and reconnects independently", async () => {
  const host = new MemoryHost();
  host.add("target", Date.now(), true);
  host.add("other", Date.now(), true);
  host.failOnce.add("target");
  const api = adapter(host);
  const states: string[] = [];
  const release = api.watchSession("target", () => states.push(api.sessionObservation("target")!.state));
  const controller = new AbortController();
  const pump = (async () => { for await (const _frame of api.openMux(controller.signal)) {} })();
  try {
    await eventually(() => states.includes("retrying"));
    assert.equal(api.sessionObservation("target")?.reason, "stream_failed");
    await eventually(() => api.sessionObservation("target")?.state === "following");
    assert.ok((host.attempts.get("target") ?? 0) >= 2);
    assert.equal(api.sessionObservation("other"), undefined);
    assert.ok(host.followers.has("other"));
  } finally {
    release();
    controller.abort();
    await pump;
    await api.disconnect();
  }
});

test("a retrying follow leaves its slot available without a false capacity error", async () => {
  const host = new MemoryHost();
  for (let index = 0; index < 25; index++) host.add(`watched-${index}`, index);
  host.failOnce.add("watched-24");
  const api = new DesktopPairedAdapter({ session: host as unknown as AuthSession, protocolFamily: "dsh-host-0.2",
    harnessVersion: "fixture", desktopVersion: "fixture", discoveryIntervalMs: 200 });
  const releases = [...host.sessions.keys()].map(sessionId => api.watchSession(sessionId, () => {}));
  const controller = new AbortController();
  const pump = (async () => { for await (const _frame of api.openMux(controller.signal)) {} })();
  try {
    await eventually(() => api.sessionObservation("watched-24")?.state === "retrying");
    await eventually(() => api.sessionObservation("watched-0")?.state === "following");
    assert.equal(host.followers.size, 24);
    assert.equal(api.sessionObservation("watched-24")?.reason, "stream_failed");
  } finally {
    releases.forEach(release => release());
    controller.abort();
    await pump;
    await api.disconnect();
  }
});
