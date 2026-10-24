import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import { loadConfig, BridgeConfigError } from "../src/config.js";
import {
  aclViolations as probeAcl,
  parseIcacls,
  parseWhoamiUser,
  processFactsScript,
  readProcessFacts,
  sameProcessStart,
} from "../src/desktop/windows-security.js";
import {
  assertFresh,
  assertLocalOrigin,
  connectionDescriptorSchema,
  DescriptorProblem,
  generationChanged,
} from "../src/desktop/connection-descriptor.js";
import { parseStreamServerFrame, sessionFollowFrameSchema } from "../src/host-adapters/desktop-paired/protocol.js";
import {
  DesktopPairedAdapter,
  UnsupportedHostVersionError,
} from "../src/host-adapters/desktop-paired/adapter.js";
import { CapabilityUnavailableError } from "../src/host-adapters/contract.js";
import type { AuthSession } from "../src/desktop/auth-session.js";

const ROOT = new URL("../", import.meta.url);

function descriptor(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    hostId: "11111111-1111-4111-8111-111111111111",
    instanceId: "22222222-2222-4222-8222-222222222222",
    profileKind: "desktop",
    profileFingerprint: "a".repeat(64),
    desktopVersion: "0.2.0-rc.2",
    harnessVersion: "0.2.0-rc.2",
    origin: "http://127.0.0.1:19387",
    hostPid: 4242,
    hostStartedAt: Date.now() - 60_000,
    publishedAt: new Date().toISOString(),
    authMode: "browser-session",
    protocolFamily: "dsh-host-0.2",
    launchToken: "token-that-must-never-leak",
    ...overrides,
  };
}

describe("connection descriptor", () => {
  it("accepts the documented schema version 1 shape", () => {
    assert.equal(connectionDescriptorSchema.safeParse(descriptor()).success, true);
  });

  it("rejects a descriptor from another schema version", () => {
    assert.equal(connectionDescriptorSchema.safeParse(descriptor({ schemaVersion: 2 })).success, false);
  });

  it("rejects a descriptor missing the launch token rather than connecting anonymously", () => {
    const { launchToken: _omitted, ...withoutToken } = descriptor();
    assert.equal(connectionDescriptorSchema.safeParse(withoutToken).success, false);
  });

  it("accepts loopback origins and refuses remote hosts, credentials, paths and queries", () => {
    assert.equal(assertLocalOrigin("http://127.0.0.1:19387"), "http://127.0.0.1:19387");
    assert.equal(assertLocalOrigin("http://[::1]:19387"), "http://[::1]:19387");
    for (const origin of [
      "https://example.com:443",
      "http://user:pass@127.0.0.1:19387",
      "http://127.0.0.1:19387/?token=abc",
      "http://127.0.0.1:19387/ui",
      "file:///C:/tmp/connection.json",
    ]) {
      assert.throws(() => assertLocalOrigin(origin), DescriptorProblem, origin);
    }
  });

  it("treats a publication older than the refresh contract as stale", () => {
    const stale = descriptor({ publishedAt: new Date(Date.now() - 31_000).toISOString() });
    assert.throws(() => assertFresh(connectionDescriptorSchema.parse(stale)), /stale|not been refreshed/u);
    const fresh = connectionDescriptorSchema.parse(descriptor());
    assert.ok(assertFresh(fresh) < 5_000);
  });

  it("detects a new connection generation across a Desktop restart", () => {
    const first = { hostId: "h1", instanceId: "i1" };
    assert.equal(generationChanged(undefined, first), false);
    assert.equal(generationChanged(first, { hostId: "h1", instanceId: "i1" }), false);
    assert.equal(generationChanged(first, { hostId: "h1", instanceId: "i2" }), true);
    assert.equal(generationChanged(first, { hostId: "h2", instanceId: "i2" }), true);
  });
});

describe("windows ACL verification", () => {
  const sid = "S-1-5-21-1-2-3-1001";

  it("parses icacls rows including the inherited marker", () => {
    const rows = parseIcacls(
      [
        "C:\\private Everyone:(I)(OI)(CI)(F)",
        "                                 NT AUTHORITY\\SYSTEM:(OI)(CI)(F)",
        "                                 BUILTIN\\Administrators:(OI)(CI)(F)",
        "                                 *S-1-5-21-1-2-3-1001:(OI)(CI)(F)",
        "Successfully processed 1 files; Failed processing 0 files",
      ].join("\r\n"),
      "C:\\private",
    );
    assert.equal(rows.length, 4);
    assert.equal(rows[0]?.inherited, true);
    assert.equal(rows[1]?.inherited, false);
  });

  it("refuses a directory that keeps any inherited entry", () => {
    const rows = parseIcacls("C:\\x Everyone:(I)(OI)(CI)(F)", "C:\\x");
    assert.match(aclViolationsText(rows, sid), /inherited entry/u);
  });

  it("refuses broad principals even when they are explicit", () => {
    const rows = parseIcacls("C:\\x Users:(OI)(CI)(RX)", "C:\\x");
    assert.match(aclViolationsText(rows, sid), /broad principal/u);
  });

  it("accepts only the current user, SYSTEM and Administrators", () => {
    const rows = parseIcacls(
      [
        "C:\\x NT AUTHORITY\\SYSTEM:(OI)(CI)(F)",
        "                         BUILTIN\\Administrators:(OI)(CI)(F)",
        "                         *S-1-5-21-1-2-3-1001:(OI)(CI)(F)",
      ].join("\r\n"),
      "C:\\x",
    );
    assert.deepEqual(probeAcl(rows, sid), []);
  });

  it("accepts the current user when icacls prints DOMAIN\\name instead of the SID", () => {
    // Real icacls output on a normal workstation: names, not *SID.
    const rows = parseIcacls(
      [
        "C:\\x BUILTIN\\Administrators:(OI)(CI)(F)",
        "     NT AUTHORITY\\SYSTEM:(OI)(CI)(F)",
        "     LAPTOP-TEST\\alice:(OI)(CI)(F)",
      ].join("\n"),
      "C:\\x",
    );
    const identity = parseWhoamiUser('"laptop-test\\alice","S-1-5-21-1-2-3-1001"\r\n');
    assert.deepEqual(probeAcl(rows, identity), []);
    // A SID-only identity cannot vouch for a name, and another user is still refused.
    assert.match(aclViolationsText(rows, sid), /unexpected principal/u);
    const other = parseIcacls("C:\\x LAPTOP-TEST\\bob:(OI)(CI)(F)", "C:\\x");
    assert.match(probeAcl(other, identity).join("; "), /unexpected principal/u);
  });

  it("parses whoami /user csv output into name and SID", () => {
    assert.deepEqual(parseWhoamiUser('"laptop-test\\alice","S-1-5-21-1-2-3-1001"\r\n'), {
      name: "laptop-test\\alice",
      sid: "S-1-5-21-1-2-3-1001",
    });
    assert.throws(() => parseWhoamiUser("whoami: extra operand '/user'"), /SID/u);
  });

  it("fails closed for an empty policy", () => {
    assert.match(aclViolationsText([], sid), /no explicit access entry/u);
  });

  it("reads a real process creation time on Windows PowerShell 5.1", { skip: process.platform !== "win32" }, async () => {
    // Regression: `Get-Date -AsUTC` is PowerShell 7-only and made 5.1 return NaN.
    assert.doesNotMatch(processFactsScript(1), /-AsUTC/u);
    const facts = await readProcessFacts(process.pid);
    assert.equal(facts.running, true);
    const startedAt = Date.now() - process.uptime() * 1000;
    assert.ok(Number.isFinite(facts.createdAt), "creation time must parse");
    assert.ok(sameProcessStart(startedAt, facts.createdAt, 5_000), "creation time must match this process");
  });

  it("compares reported and native process creation times with a tolerance", () => {
    assert.equal(sameProcessStart(1_000, 1_000 + 4_000, 5_000), true);
    assert.equal(sameProcessStart(1_000, 1_000 + 6_000, 5_000), false);
    assert.equal(sameProcessStart(1_000, Number.NaN, 5_000), false);
  });
});

function aclViolationsText(rows: ReturnType<typeof parseIcacls>, sid: string): string {
  return probeAcl(rows, sid).join("; ");
}

describe("desktop wire frames", () => {
  it("accepts the documented client and server stream frames", () => {
    assert.equal(parseStreamServerFrame('{"type":"item","streamId":"s1","value":{"a":1}}').type, "item");
    assert.equal(parseStreamServerFrame('{"type":"end","streamId":"s1"}').type, "end");
  });

  it("rejects an unknown frame and a non-JSON frame", () => {
    assert.throws(() => parseStreamServerFrame('{"type":"bogus","streamId":"s1"}'));
    assert.throws(() => parseStreamServerFrame("not json"));
  });

  it("validates the three session/follow frame shapes", () => {
    const event = { type: "turn/end", seq: 4, time: 1, data: { turn: 1, reason: { kind: "done" } } };
    assert.equal(sessionFollowFrameSchema.safeParse({ type: "event", event }).success, true);
    assert.equal(
      sessionFollowFrameSchema.safeParse({
        type: "snapshot",
        header: { id: "session-1" },
        cursor: 4,
        records: [{ type: "event", event }],
        hasMore: false,
      }).success,
      true,
    );
    assert.equal(sessionFollowFrameSchema.safeParse({ type: "assistant-stream", frame: { t: "x" } }).success, true);
    assert.equal(sessionFollowFrameSchema.safeParse({ type: "event" }).success, false);
  });
});

describe("desktop-paired adapter", () => {
  function workspace(workspaceId: string, path: string) {
    return { workspaceId, path, title: path, sessionIds: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };
  }

  function baseline(items: Array<ReturnType<typeof workspace>>) {
    return { type: "baseline", value: { items, archivedSessionIds: [], pinnedSessionIds: [] } };
  }

  /** A fake generation that records every request it is asked to send. */
  function fakeSession(values: Record<string, unknown> = {}) {
    const calls: Array<{ endpoint: string; args: Record<string, unknown> }> = [];
    const session = {
      origin: "http://127.0.0.1:19387",
      calls,
      async call(endpoint: string, args: Record<string, unknown>) {
        calls.push({ endpoint, args });
        const value = values[endpoint];
        if (value instanceof Error) throw value;
        return value ?? {};
      },
      async *openStream(endpoint: string, args: Record<string, unknown>) {
        calls.push({ endpoint, args });
        const value = values[endpoint];
        if (value instanceof Error) throw value;
        if (Array.isArray(value)) {
          for (const item of value) yield { type: "item", streamId: "stream-1", value: item };
        }
      },
      handshake: async () => "",
      dispose: () => undefined,
      authenticated: true,
      generation: { hostId: "h", instanceId: "i" },
    };
    return { session: session as unknown as AuthSession, calls, raw: session };
  }

  function adapter(values: Record<string, unknown> = {}, family = "dsh-host-0.2") {
    const fake = fakeSession(values);
    return {
      fake,
      adapter: new DesktopPairedAdapter({
        session: fake.session,
        protocolFamily: family,
        harnessVersion: "0.2.0-rc.2",
        desktopVersion: "0.2.0-rc.2",
      }),
    };
  }

  it("refuses a protocol family it has not implemented", () => {
    assert.throws(() => adapter({}, "dsh-host-9.9"), UnsupportedHostVersionError);
  });

  it("declares inherit-oriented capabilities for the installed family", () => {
    const { adapter: instance } = adapter();
    const caps = instance.capabilities();
    assert.equal(caps.readSessions, true);
    assert.equal(caps.prompt, true);
    assert.equal(caps.promptDedup, true);
    assert.equal(caps.selectModel, false);
    assert.equal(caps.approvalRelay, false);
  });

  it("refuses model selection before sending anything", async () => {
    const { fake, adapter: instance } = adapter();
    await assert.rejects(
      () => instance.sessionSelectModel({ sessionId: "s", provider: "p", model: "m" }),
      CapabilityUnavailableError,
    );
    assert.deepEqual(fake.calls, []);
  });

  it("sends session/list exactly as the generated descriptor names it", async () => {
    const { fake, adapter: instance } = adapter({ "session/list": { items: [] } });
    const list = await instance.sessionList();
    assert.deepEqual(list.items, []);
    assert.deepEqual(fake.calls[0], { endpoint: "session/list", args: { _request: {} } });
  });

  it("reuses an exact projectRoot without creating a workspace or changing its path casing", async () => {
    const existing = workspace("workspace-1", "C:\\Projects\\Cowork");
    const projectRoot = "c:\\projects\\cowork";
    const cwd = `${projectRoot}\\child`;
    const { fake, adapter: instance } = adapter({
      "workspace/follow": [baseline([existing])],
      "session/create": { sessionId: "session-1", agentPreset: "default" },
    });
    const result = await instance.sessionCreate({ cwd, projectRoot, sessionId: "session-1", agentPreset: "default" });
    assert.deepEqual(result.desktopWorkspace, {
      workspaceId: "workspace-1", path: existing.path, created: false, resolution: "exact",
      requestedCwd: cwd, sessionCwd: existing.path,
    });
    assert.deepEqual(fake.calls, [
      { endpoint: "workspace/follow", args: {} },
      { endpoint: "session/create", args: { request: { workspaceId: "workspace-1", sessionId: "session-1", agentPreset: "default" } } },
    ]);
  });

  it("reuses the nearest existing ancestor without calling workspace/create", async () => {
    const parent = workspace("parent", "C:\\projects");
    const nested = workspace("nested", "C:\\projects\\cowork");
    const cwd = "C:\\projects\\cowork\\child";
    const { fake, adapter: instance } = adapter({
      "workspace/follow": [baseline([parent, nested])],
      "session/create": { sessionId: "session-1" },
    });
    const result = await instance.sessionCreate({ cwd });
    assert.equal(result.desktopWorkspace.workspaceId, "nested");
    assert.equal(result.desktopWorkspace.resolution, "ancestor");
    assert.equal(result.desktopWorkspace.sessionCwd, nested.path);
    assert.equal(result.desktopWorkspace.requestedCwd, cwd);
    assert.deepEqual(fake.calls.map(call => call.endpoint), ["workspace/follow", "session/create"]);
  });

  for (const created of [true, false]) {
    it(`${created ? "creates" : "deduplicates"} only an explicit new project root before session creation`, async () => {
      const projectRoot = "C:\\projects\\cowork\\new-project";
      const cwd = `${projectRoot}\\child`;
      const parent = workspace("parent", "C:\\projects\\cowork");
      const selected = workspace("selected", projectRoot);
      const { fake, adapter: instance } = adapter({
        "workspace/follow": [baseline([parent])],
        "workspace/create": { workspace: selected, created },
        "session/create": { sessionId: "session-1" },
      });
      const result = await instance.sessionCreate({ cwd, projectRoot });
      assert.equal(result.desktopWorkspace.workspaceId, "selected");
      assert.equal(result.desktopWorkspace.created, created);
      assert.equal(result.desktopWorkspace.resolution, created ? "created" : "exact");
      assert.equal(result.desktopWorkspace.sessionCwd, projectRoot);
      assert.equal(result.desktopWorkspace.requestedCwd, cwd);
      assert.deepEqual(fake.calls, [
        { endpoint: "workspace/follow", args: {} },
        { endpoint: "workspace/follow", args: {} },
        { endpoint: "workspace/create", args: { request: { path: projectRoot } } },
        { endpoint: "session/create", args: { request: { workspaceId: "selected" } } },
      ]);
    });
  }

  it("keeps the legacy cwd-only fallback when no ancestor exists", async () => {
    const cwd = "C:\\projects\\new-project";
    const selected = workspace("selected", cwd);
    const { fake, adapter: instance } = adapter({
      "workspace/follow": [baseline([])],
      "workspace/create": { workspace: selected, created: true },
      "session/create": { sessionId: "session-1" },
    });
    const result = await instance.sessionCreate({ cwd });
    assert.equal(result.desktopWorkspace.resolution, "created");
    assert.equal(result.desktopWorkspace.requestedCwd, cwd);
    assert.equal(result.desktopWorkspace.sessionCwd, cwd);
    assert.equal(fake.calls.filter(call => call.endpoint === "workspace/create").length, 1);
  });

  it("rejects an explicit projectRoot that does not contain cwd before any write", async () => {
    const { fake, adapter: instance } = adapter({ "workspace/follow": [baseline([])] });
    await assert.rejects(
      () => instance.sessionCreate({ cwd: "C:\\other\\child", projectRoot: "C:\\projects\\cowork" }),
      /projectRoot must be cwd itself or one of its ancestors/,
    );
    assert.deepEqual(fake.calls.map(call => call.endpoint), ["workspace/follow"]);
  });

  it("rejects duplicate canonical workspace identities before any write", async () => {
    const first = workspace("first", "C:\\Projects\\Cowork");
    const second = workspace("second", "c:\\projects\\cowork");
    const { fake, adapter: instance } = adapter({ "workspace/follow": [baseline([first, second])] });
    await assert.rejects(() => instance.sessionCreate({ cwd: "C:\\projects\\cowork" }), /duplicate workspace id or canonical path/);
    assert.deepEqual(fake.calls.map(call => call.endpoint), ["workspace/follow"]);
  });

  it("fails closed on missing, malformed, or failed workspace baselines", async () => {
    for (const value of [[], [{ type: "upsert", value: {} }], new Error("workspace unavailable")]) {
      const { fake, adapter: instance } = adapter({ "workspace/follow": value });
      await assert.rejects(() => instance.sessionCreate({ cwd: "C:\\projects\\cowork" }));
      assert.deepEqual(fake.calls.map(call => call.endpoint), ["workspace/follow"]);
    }
  });

  it("refuses a created workspace whose canonical project root differs", async () => {
    const wrong = workspace("wrong", "C:\\other");
    const { fake, adapter: instance } = adapter({
      "workspace/follow": [baseline([])],
      "workspace/create": { workspace: wrong, created: true },
    });
    await assert.rejects(() => instance.sessionCreate({ cwd: "C:\\projects\\cowork" }), /different canonical project root/);
    assert.deepEqual(fake.calls.map(call => call.endpoint), ["workspace/follow", "workspace/follow", "workspace/create"]);
  });

  it("passes the prompt requestId through so a retry can be de-duplicated", async () => {
    const { fake, adapter: instance } = adapter({ "session/prompt": { accepted: true } });
    await instance.sessionPrompt({ sessionId: "session-1", mode: "queue", content: [{ type: "text", text: "hi" }] });
    const call = fake.calls[0];
    assert.equal(call?.endpoint, "session/prompt");
    const request = (call?.args as { request: { requestId: string; mode: string } }).request;
    assert.equal(request.mode, "queue");
    assert.match(request.requestId, /^[0-9a-f-]{36}$/u);
    assert.equal(instance.lastPromptRequestId("session-1"), request.requestId);
  });

  it("reads a page offset by the session's own asOfSeq cursor", async () => {
    const { fake, adapter: instance } = adapter({
      "session/projections": { asOfSeq: 12, values: {} },
      "session/page": { records: [{ type: "event", event: { type: "turn/start", seq: 11, time: 1, data: { turn: 1 } } }], hasMore: false },
    });
    const history = await instance.sessionHistory("session-1", { maxMessages: 10 });
    assert.equal(history.events.length, 1);
    const page = fake.calls.find((call) => call.endpoint === "session/page");
    const request = (page?.args as { request: { throughSeq: number; maxMessages?: number } }).request;
    assert.equal(request.throughSeq, 12);
    assert.equal(request.maxMessages, 10);
  });

  it("reports no history for a session that has no projections yet", async () => {
    const { fake, adapter: instance } = adapter({ "session/projections": null });
    const history = await instance.sessionHistory("session-blank");
    assert.deepEqual(history.events, []);
    assert.equal(fake.calls.some((call) => call.endpoint === "session/page"), false);
  });

  it("refuses to answer an interaction instead of faking an approval", async () => {
    const { adapter: instance } = adapter();
    await assert.rejects(async () => await instance.respond(), CapabilityUnavailableError);
  });
});

describe("paired configuration", () => {
  const base = {
    DSH_CONNECTION_FILE: "C:\\bridge\\connection.json",
  };

  it("requires a connection file", () => {
    assert.throws(() => loadConfig({ DSH_HOST_MODE: "desktop-paired" }), BridgeConfigError);
  });

  it("rejects a configured host URL instead of silently becoming static", () => {
    assert.throws(
      () => loadConfig({ ...base, DSH_HOST_MODE: "desktop-paired", DSH_HOST_URL: "http://127.0.0.1:3080" }),
      /DSH_HOST_URL/u,
    );
  });

  it("rejects remote-host permission and model or preset routing overrides", () => {
    for (const extra of [
      { DSH_ALLOW_REMOTE_HOST: "1" },
      { DSH_BRIDGE_AGENT_PRESET: "code" },
      { DSH_MODEL_POLICY: "flash" },
      { DSH_APPROVAL_MODE: "bridge" },
    ]) {
      assert.throws(() => loadConfig({ ...base, DSH_HOST_MODE: "desktop-paired", ...extra }), BridgeConfigError, JSON.stringify(extra));
    }
  });

  it("resolves the paired defaults", () => {
    const config = loadConfig({
      ...base,
      DSH_HOST_MODE: "desktop-paired",
      DSH_CALLER_KIND: "claude-code",
      DSH_MODEL_POLICY: "inherit",
      DSH_BRIDGE_HOME: "C:\\bridge",
    });
    assert.equal(config.hostMode, "desktop-paired");
    assert.equal(config.hostUrl, "");
    assert.equal(config.callerKind, "claude-code");
    assert.equal(config.modelPolicy, "inherit");
    assert.equal(config.approvalMode, "desktop");
    assert.equal(config.allowRemoteHost, false);
  });

  it("keeps the upstream static default untouched", () => {
    const config = loadConfig({});
    assert.equal(config.hostMode, "static");
    assert.equal(config.hostUrl, "http://127.0.0.1:3080");
  });
});

describe("caller skills share one semantics contract", () => {
  const callerSkills = [
    ["skill/codex-dsh-desktop", "codex-dsh-desktop"],
    ["skill/claude-dsh-desktop", "claude-dsh-desktop"],
    ["skill/zcode-dsh-desktop", "zcode-dsh-desktop"],
    ["skill/kimi-code-dsh-desktop", "kimi-code-dsh-desktop"],
    ["skill/kimi-work-dsh-desktop", "kimi-work-dsh-desktop"],
  ] as const;
  const requiredRules = [
    "inherit|沿用|继承",
    "single writer|one writer|一个写入者",
    "30 seconds|30 秒|30s",
    "acceptance|accept|验收",
    "approval|审批",
    "taskId",
    "release_workspace",
    "projectRoot",
    "sessionCwd",
  ];

  it("all caller skills declare their own name and the dsh_desktop server only", async () => {
    for (const [dir, name] of callerSkills) {
      const text = await readFile(new URL(`${dir}/SKILL.md`, ROOT), "utf8");
      assert.match(text, new RegExp(`^---\\nname: ${name}$`, "mu"));
      assert.match(text, /dsh_desktop/u);
      assert.doesNotMatch(text, /dsh_agentlink/u);
    }
  });

  it("neither original skill points at the other skill's files", async () => {
    const codex = await readFile(new URL("skill/codex-dsh-desktop/SKILL.md", ROOT), "utf8");
    const claude = await readFile(new URL("skill/claude-dsh-desktop/SKILL.md", ROOT), "utf8");
    assert.doesNotMatch(codex, /claude-dsh-desktop\//u);
    assert.doesNotMatch(claude, /codex-dsh-desktop\//u);
  });

  it("every skill copy of the semantics page is byte-identical to the canonical page", async () => {
    const canonical = await readFile(new URL("docs/cowork-semantics.md", ROOT), "utf8");
    for (const [dir] of callerSkills) {
      const copy = await readFile(new URL(`${dir}/references/cowork-semantics.md`, ROOT), "utf8");
      assert.equal(copy, canonical, `${dir} copy drifted from docs/cowork-semantics.md`);
    }
  });

  it("all caller skills state every required rule", async () => {
    for (const [dir] of callerSkills) {
      const text = await readFile(new URL(`${dir}/SKILL.md`, ROOT), "utf8");
      for (const rule of requiredRules) {
        assert.match(text, new RegExp(rule, "iu"), `${dir} is missing ${rule}`);
      }
    }
  });
});



