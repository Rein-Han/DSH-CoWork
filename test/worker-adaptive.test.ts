import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EventLedger, type LedgerRecord } from "../src/event-ledger.js";
import { applyCodexTable, renderCodexBlock } from "../src/setup-desktop.js";
import { WaitEvidenceIndex } from "../src/wait-evidence.js";
import { compactWait, waitWithPolicy, type WaitView } from "../src/wait-policy.js";
import { adaptiveBudget, maxWaitSeconds } from "../src/wait-schedule.js";

const TASK_ID = "dsh_000000000013";
const NOW = Date.UTC(2026, 9, 27, 4, 0, 0);
const NODE = "C:\\Program Files\\nodejs\\node.exe";
const ENTRY = "C:\\tools\\dsh-desktop-cowork\\dist\\index.js";
const adaptiveBlock = renderCodexBlock(NODE, ENTRY, {
  DSH_WAIT_PROFILE: "adaptive",
  DSH_HOST_MODE: "desktop-paired",
});

const waitView = (cursor: number, patch: Record<string, unknown> = {}): WaitView => ({
  taskId: TASK_ID,
  rootSessionId: "root",
  cursor,
  availability: "connected",
  execution: "running",
  pendingInteractions: [],
  connection: { revision: cursor },
  recovery: { state: "reconciled" },
  ...patch,
}) as WaitView;

const evidenceTime = (cursor: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + cursor * 1000).toISOString();
// Read through a function so `assert.equal(..., undefined)` cannot narrow the
// mutable property for the rest of the test.
const currentIssue = (index: WaitEvidenceIndex) => index.issue;

const sessionRecord = (
  cursor: number,
  event: Record<string, unknown>,
  session = "root",
  origin: "root" | "subagent" = "root",
): LedgerRecord => ({
  cursor,
  mergeIndex: cursor,
  observedAt: evidenceTime(cursor),
  sourceSessionId: session,
  origin,
  type: "session/event",
  coordination: { type: "session/event", sessionId: session, event },
});

const resultRecord = (cursor: number, error: boolean, session = "root") =>
  sessionRecord(cursor, { type: "tool/result", data: { error } }, session);

const turnStartRecord = (cursor: number, session = "root", origin: "root" | "subagent" = "root") =>
  sessionRecord(cursor, { type: "turn/start" }, session, origin);

test("adaptive schedule: exact 5/10/15-minute run-age boundaries pick 60/120/180/300 seconds", () => {
  const turnAt = (ageMs: number) => ({ startedAt: new Date(NOW - ageMs).toISOString() });
  const cases: Array<[ageMs: number, timeoutSec: number]> = [
    [0, 60],
    [299_999, 60],
    [300_000, 120],
    [300_001, 120],
    [599_999, 120],
    [600_000, 180],
    [600_001, 180],
    [899_999, 180],
    [900_000, 300],
    [900_001, 300],
    [3_600_000, 300],
  ];
  for (const [ageMs, timeoutSec] of cases) {
    const budget = adaptiveBudget(turnAt(ageMs), NOW);
    assert.equal(budget.timeoutSec, timeoutSec, `age ${ageMs}ms`);
    assert.equal(budget.runAgeSec, Math.floor(ageMs / 1000), `age ${ageMs}ms`);
    assert.equal(budget.basis, "observed_turn_start", `age ${ageMs}ms`);
    assert.ok(budget.timeoutSec <= maxWaitSeconds("adaptive"));
  }
  assert.equal(maxWaitSeconds(), 30);
  assert.equal(maxWaitSeconds("bounded"), 30);
  assert.equal(maxWaitSeconds("adaptive"), 300);
  assert.equal(maxWaitSeconds("long"), 900);
});

test("adaptive schedule: unknown, malformed and future turn starts get the short budget", () => {
  const short = { timeoutSec: 60, runAgeSec: null, basis: "unknown_run_age" };
  const turns: unknown[] = [
    undefined,
    null,
    {},
    { startedAt: undefined },
    { startedAt: 123 },
    { startedAt: "not-a-timestamp" },
    { startedAt: new Date(NOW + 1).toISOString() },
    { startedAt: new Date(NOW + 3_600_000).toISOString() },
  ];
  for (const turn of turns) assert.deepEqual(adaptiveBudget(turn, NOW), short);
});

test("adaptive schedule: a steer inside two minutes wins; exactly two minutes old is not recent", () => {
  const oldRun = { startedAt: new Date(NOW - 20 * 60_000).toISOString() };
  assert.deepEqual(adaptiveBudget(oldRun, NOW, new Date(NOW - 119_999).toISOString()), {
    timeoutSec: 60,
    runAgeSec: 1200,
    basis: "recent_steer",
  });
  assert.deepEqual(adaptiveBudget(oldRun, NOW, new Date(NOW - 120_000).toISOString()), {
    timeoutSec: 300,
    runAgeSec: 1200,
    basis: "observed_turn_start",
  });
  assert.equal(adaptiveBudget(oldRun, NOW, new Date(NOW + 5_000).toISOString()).basis, "observed_turn_start");
  assert.equal(adaptiveBudget(oldRun, NOW, "invalid").basis, "observed_turn_start");
  for (const ageMs of [10_000, 310_000, 610_000, 910_000]) {
    const budget = adaptiveBudget({ startedAt: new Date(NOW - ageMs).toISOString() }, NOW, new Date(NOW - 1_000).toISOString());
    assert.equal(budget.timeoutSec, 60);
    assert.equal(budget.basis, "recent_steer");
  }
});

test("adaptive wait: ordinary events never extend the selected 60s deadline", async (t) => {
  let now = 0;
  let events = 0;
  let reads = 0;
  t.mock.method(performance, "now", () => now);
  const result = await waitWithPolicy({
    timeoutSec: 300,
    options: { until: "terminal" },
    selectTimeout: () => 60,
    read: async () => {
      reads++;
      return waitView(events);
    },
    wait: async () => {
      events++;
      now += 600;
    },
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.wakeReason, "timeout");
  assert.equal(now, 60_000, "the selected deadline is monotonic");
  assert.equal(events, 100, "only the events inside the selected window were consumed");
  assert.ok(reads >= 100 && reads <= 101, `bounded reads, got ${reads}`);
});

test("adaptive wait: important events interrupt an otherwise 300s window", async (t) => {
  let now = 0;
  let events = 0;
  t.mock.method(performance, "now", () => now);
  const cases: Array<{ name: string; patch: Record<string, unknown>; reason: string; keyed: boolean; supervise?: boolean }> = [
    { name: "interaction", patch: { pendingInteractions: [{ requestId: "q-1" }] }, reason: "interaction", keyed: true },
    { name: "availability", patch: { availability: "host_unreachable" }, reason: "availability", keyed: true },
    { name: "observation error", patch: { recovery: { state: "gap" } }, reason: "observation_error", keyed: true },
    { name: "terminal", patch: { execution: "turn_completed" }, reason: "terminal", keyed: false },
    {
      name: "supervision issue",
      patch: { observationIssue: { kind: "consecutive_tool_failures", cursor: 41, sourceSessionId: "root", count: 3 } },
      reason: "supervision",
      keyed: true,
      supervise: true,
    },
  ];
  for (const entry of cases) {
    now = 0;
    events = 0;
    const result = await waitWithPolicy({
      timeoutSec: 300,
      options: { until: "terminal", ...(entry.supervise === true ? { supervise: true } : {}) },
      selectTimeout: () => 300,
      read: async () => (events < 42 ? waitView(events) : waitView(events, entry.patch)),
      wait: async () => {
        events++;
        now += 1_000;
      },
    });
    assert.equal(result.timedOut, false, entry.name);
    assert.equal(result.wakeReason, entry.reason, entry.name);
    assert.equal(now, 42_000, `${entry.name}: observed at 42s, not deferred to the 300s deadline`);
    if (entry.keyed) assert.match(result.wakeKey ?? "", /^[a-f0-9]{24}$/u, entry.name);
    else assert.equal(result.wakeKey, undefined, entry.name);
    if (entry.name === "interaction") {
      assert.deepEqual(compactWait(result).pendingInteractions, [{ requestId: "q-1" }]);
    }
    if (entry.name === "supervision issue") {
      const issue = compactWait(result).observationIssue as { kind?: string } | undefined;
      assert.equal(issue?.kind, "consecutive_tool_failures");
    }
  }
});

test("failure evidence: one alert per consecutive-failure streak, not one per retry", () => {
  const index = new WaitEvidenceIndex();
  const records = [resultRecord(1, true), resultRecord(2, true), resultRecord(3, true)];
  index.update(records);
  const issue = index.issue;
  assert.ok(issue);
  assert.equal(issue.kind, "consecutive_tool_failures");
  assert.equal(issue.cursor, 3);
  assert.equal(issue.count, 3);
  assert.equal(issue.sourceSessionId, "root");
  assert.match(issue.details, /dsh_tail/u);
  records.push(resultRecord(4, true), resultRecord(5, true));
  index.update(records);
  assert.equal(index.issue?.cursor, 3, "later failures do not replace the one emitted alert");
  assert.equal(index.issue?.count, 3);
});

test("failure evidence: success resets the streak and a later third failure alerts again", () => {
  const index = new WaitEvidenceIndex();
  const records = [
    resultRecord(1, true),
    resultRecord(2, true),
    resultRecord(3, false),
    resultRecord(4, true),
    resultRecord(5, true),
  ];
  index.update(records);
  assert.equal(currentIssue(index), undefined, "two failures, then success, then two more is not a streak of three");
  records.push(resultRecord(6, true));
  index.update(records);
  assert.equal(currentIssue(index)?.cursor, 6);
  records.push(resultRecord(7, false), resultRecord(8, true), resultRecord(9, true), resultRecord(10, true));
  index.update(records);
  assert.equal(currentIssue(index)?.cursor, 10, "success at cursor 7 starts a fresh streak");
  assert.equal(currentIssue(index)?.count, 3);
});

test("failure evidence: a new root run clears the streak and issue; a subagent start does not", () => {
  const index = new WaitEvidenceIndex();
  const records = [resultRecord(1, true), resultRecord(2, true), resultRecord(3, true)];
  index.update(records);
  assert.equal(index.issue?.cursor, 3);
  records.push(turnStartRecord(4));
  index.update(records);
  assert.equal(currentIssue(index), undefined, "the old streak is no longer evidence for the new run");
  records.push(resultRecord(5, true), resultRecord(6, true));
  index.update(records);
  assert.equal(currentIssue(index), undefined);
  records.push(resultRecord(7, true));
  index.update(records);
  assert.equal(currentIssue(index)?.cursor, 7);

  const subagent = new WaitEvidenceIndex();
  const subagentRecords = [
    resultRecord(1, true),
    resultRecord(2, true),
    turnStartRecord(3, "sub", "subagent"),
    resultRecord(4, true),
  ];
  subagent.update(subagentRecords);
  assert.equal(currentIssue(subagent)?.cursor, 4, "an unrelated subagent turn start must not erase the root streak");
  assert.equal(currentIssue(subagent)?.sourceSessionId, "root");
});

test("failure evidence: restart rebuilds the same streak from persisted sanitized records", async () => {
  const home = await mkdtemp(join(tmpdir(), "dsh-worker-adaptive-"));
  try {
    const ledgerEvent = (seq: number, type: string, data: Record<string, unknown> = {}) => ({
      sourceSessionId: "root",
      sourceSeq: seq,
      origin: "root" as const,
      type: "session/event",
      raw: { type: "session/event", sessionId: "root", event: { type, seq, time: seq, data } },
    });
    const writer = new EventLedger(home);
    await writer.append(TASK_ID, ledgerEvent(1, "turn/start", { turn: 1 }));
    await writer.append(TASK_ID, ledgerEvent(2, "tool/result", { error: true }));
    await writer.append(TASK_ID, ledgerEvent(3, "tool/result", { error: true }));

    const restarted = new EventLedger(home);
    assert.equal((await restarted.observationEvidence(TASK_ID)).issue, undefined, "two failures are below the threshold");
    await restarted.append(TASK_ID, ledgerEvent(4, "tool/result", { error: true }));
    const afterThirdFailure = await restarted.observationEvidence(TASK_ID);
    assert.equal(afterThirdFailure.issue?.cursor, 4);
    assert.equal(afterThirdFailure.issue?.count, 3);

    const fresh = new EventLedger(home);
    const rebuilt = await fresh.observationEvidence(TASK_ID);
    assert.equal(rebuilt.issue?.cursor, 4, "a new process rebuilds the alert from the log");
    assert.equal(rebuilt.issue?.count, 3);
    assert.match(rebuilt.issue?.details ?? "", /dsh_tail/u);
    assert.equal((await fresh.observationEvidence(TASK_ID, 4)).issue, undefined, "an acknowledged cursor suppresses the old alert");

    const steer = await fresh.append(TASK_ID, {
      sourceSessionId: "root",
      sourceSeq: 5,
      origin: "root",
      type: "bridge/prompt-issued",
      raw: { type: "bridge/prompt-issued", sessionId: "root", mode: "steer", issuedRpcId: "steer-1" },
    });
    assert.ok(steer);
    assert.equal((await fresh.observationEvidence(TASK_ID)).lastSteerAt, steer.observedAt);
    await fresh.append(TASK_ID, ledgerEvent(6, "turn/start", { turn: 2 }));
    const reset = await fresh.observationEvidence(TASK_ID);
    assert.equal(reset.issue, undefined);
    assert.equal(reset.lastSteerAt, undefined);

    await fresh.append(TASK_ID, ledgerEvent(7, "tool/result", { error: true }));
    await fresh.append(TASK_ID, ledgerEvent(8, "tool/result", { error: true }));
    await fresh.append(TASK_ID, ledgerEvent(9, "tool/result", { error: false }));
    const afterSuccessRestart = new EventLedger(home);
    assert.equal((await afterSuccessRestart.observationEvidence(TASK_ID)).issue, undefined, "the success bit survives restart");
    for (const seq of [10, 11, 12]) await afterSuccessRestart.append(TASK_ID, ledgerEvent(seq, "tool/result", { error: true }));
    const renewed = await afterSuccessRestart.observationEvidence(TASK_ID);
    assert.equal(renewed.issue?.cursor, 12);
    assert.equal(renewed.issue?.count, 3);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("codex TOML apply: preserves siblings, custom fields, env and quoted keys, and is idempotent", () => {
  const before = [
    "# top comment",
    "[mcp_servers.other]",
    'command = "other"',
    'env = { KEEP = "yes" }',
    "",
    '[mcp_servers."dsh_desktop"]',
    'command = "old"',
    'args = ["old.js"]',
    "enabled = false # user custom",
    "startup_timeout_sec = 45",
    "tool_timeout_sec = 180 # keep",
    'env = { DSH_WAIT_PROFILE = "bounded", CUSTOM = "keep # not comment", "CUSTOM.DOT" = "keep2" }',
    "",
    "[profiles.default]",
    'model = "x"',
    "",
  ].join("\n");
  const once = applyCodexTable(before, adaptiveBlock);
  assert.ok(once.includes('[mcp_servers."dsh_desktop"]'), "quoted header is updated in place");
  assert.equal((once.match(/\[mcp_servers\.[^\]]*dsh_desktop[^\]]*\]/gu) ?? []).length, 1, "no duplicate dsh table");
  assert.ok(once.includes(`command = ${JSON.stringify(NODE)}`));
  assert.ok(once.includes(`args = [${JSON.stringify(ENTRY)}]`));
  assert.ok(once.includes("enabled = false # user custom"), "custom field and comment are untouched");
  assert.ok(once.includes("startup_timeout_sec = 45"), "existing startup setting is user-owned");
  assert.ok(once.includes("tool_timeout_sec = 360"), "adaptive raises the margin to 360s");
  assert.match(once, /"?CUSTOM"? = "keep # not comment"/u, "# inside a quoted value is not a comment");
  assert.ok(once.includes('"CUSTOM.DOT" = "keep2"'), "quoted environment key survives verbatim");
  assert.match(once, /"?DSH_WAIT_PROFILE"? = "adaptive"/u);
  assert.match(once, /"?DSH_HOST_MODE"? = "desktop-paired"/u);
  assert.ok(once.includes('[mcp_servers.other]\ncommand = "other"'));
  assert.ok(once.includes('[profiles.default]\nmodel = "x"'));
  assert.equal(applyCodexTable(once, adaptiveBlock), once, "second apply is byte-identical");
});

test("codex TOML apply: inline refusal is scoped to the root mcp_servers definition", () => {
  const refused = [
    'mcp_servers = { dsh_desktop = { command = "node" } }\n',
    'mcp_servers = { other = { command = "node" } }\n',
    '"mcp_servers" = { other = { command = "node" } }\n',
    'mcp_servers.dsh_desktop = { command = "node" }\n',
    'mcp_servers.dsh_desktop.command = "node"\n',
    '[mcp_servers]\ndsh_desktop = { command = "node" }\n',
  ];
  for (const content of refused) {
    assert.throws(() => applyCodexTable(content, adaptiveBlock), /inline\/dotted MCP configuration/u, content);
  }
  const allowed: Array<[content: string, sentinel: string]> = [
    ["[proxy]\nmcp_servers = { nested = true }\n", "mcp_servers = { nested = true }"],
    ['[proxy]\nmcp_servers.dsh_desktop = "not ours"\n', 'mcp_servers.dsh_desktop = "not ours"'],
    ['[other]\ndsh_desktop = { command = "not ours" }\n', 'dsh_desktop = { command = "not ours" }'],
    ['[mcp_servers]\nother = { command = "other" }\n', 'other = { command = "other" }'],
    ['mcp_servers.other.command = "other"\n', 'mcp_servers.other.command = "other"'],
  ];
  for (const [content, sentinel] of allowed) {
    const once = applyCodexTable(content, adaptiveBlock);
    assert.ok(once.includes(sentinel), sentinel);
    assert.equal((once.match(/\[mcp_servers\.[^\]]*dsh_desktop[^\]]*\]/gu) ?? []).length, 1);
    assert.equal(applyCodexTable(once, adaptiveBlock), once);
  }
});

test("codex TOML apply: escaped quoted keys do not duplicate and remain idempotent", () => {
  const escapedHeader = '[mcp_servers."dsh\\u005fdesktop"]\ncommand = "old"\n';
  const once = applyCodexTable(escapedHeader, adaptiveBlock);
  assert.ok(once.includes('[mcp_servers."dsh\\u005fdesktop"]'), "the user's escaped header is kept");
  assert.equal((once.match(/^\[mcp_servers\./gmu) ?? []).length, 1, "no second table is appended for the same decoded key");
  assert.ok(once.includes(`command = ${JSON.stringify(NODE)}`));
  assert.equal(applyCodexTable(once, adaptiveBlock), once);

  const duplicateHeader = '[mcp_servers.dsh_desktop]\ncommand = "a"\n\n[mcp_servers."dsh\\u005fdesktop"]\ncommand = "b"\n';
  assert.throws(() => applyCodexTable(duplicateHeader, adaptiveBlock), /duplicate MCP table/u);
  const duplicateEnv = '[mcp_servers.dsh_desktop]\nenv = { DSH_WAIT_PROFILE = "bounded", "DSH\\u005fWAIT_PROFILE" = "long" }\n';
  assert.throws(() => applyCodexTable(duplicateEnv, adaptiveBlock), /duplicate environment key/u);
});
