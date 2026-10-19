import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  applyClaudeEntry,
  applyZcodeEntry,
  applyCodexTable,
  bridgeEnvironment,
  buildPlan,
  applyPlan,
  parseArgs,
  renderCodexBlock,
  SERVER_NAME,
} from "../src/setup-desktop.js";
import { createMcpServer } from "../src/mcp-server.js";
import { loadConfig } from "../src/config.js";

const NODE = "C:\\Program Files\\nodejs\\node.exe";
const ENTRY = "C:\\tools\\dsh-desktop-cowork\\dist\\index.js";
const ENV = bridgeEnvironment("C:\\bridge\\connection.json", "codex");

describe("codex configuration upsert", () => {
  const block = renderCodexBlock(NODE, ENTRY, ENV);

  it("creates the table when the file is empty", () => {
    const result = applyCodexTable("", block);
    assert.match(result, /^\[mcp_servers\.dsh_desktop\]$/mu);
    assert.match(result, /command = "C:\\\\Program Files\\\\nodejs\\\\node\.exe"/u);
    assert.match(result, /DSH_HOST_MODE = "desktop-paired"/u);
  });

  it("is idempotent: applying the same table twice changes nothing", () => {
    const once = applyCodexTable("", block);
    const twice = applyCodexTable(once, block);
    assert.equal(twice.trimEnd(), once.trimEnd());
  });

  it("keeps every other MCP server table intact", () => {
    const existing = [
      "[mcp_servers.other]",
      'command = "other.exe"',
      "",
      "[mcp_servers.dsh_agentlink]",
      'command = "legacy.exe"',
      "",
      "[profiles.default]",
      'model = "x"',
      "",
    ].join("\n");
    const result = applyCodexTable(existing, block);
    assert.match(result, /\[mcp_servers\.other\]\ncommand = "other\.exe"/u);
    assert.match(result, /\[mcp_servers\.dsh_agentlink\]\ncommand = "legacy\.exe"/u);
    assert.match(result, /\[profiles\.default\]\nmodel = "x"/u);
    assert.equal(result.match(/\[mcp_servers\.dsh_desktop\]/gu)?.length, 1);
  });

  it("replaces only its own table when the entry already exists", () => {
    const first = applyCodexTable("[mcp_servers.other]\ncommand = \"a\"\n", block);
    const stale = first.replace(ENTRY, "C:\\old\\index.js");
    const updated = applyCodexTable(stale, block);
    assert.match(updated, /dsh-desktop-cowork/u);
    assert.doesNotMatch(updated, /C:\\\\old\\\\index\.js/u);
    assert.match(updated, /\[mcp_servers\.other\]/u);
  });

  it("removes only its own table on uninstall", () => {
    const installed = applyCodexTable('[mcp_servers.other]\ncommand = "a"\n', block);
    const removed = applyCodexTable(installed, undefined);
    assert.doesNotMatch(removed, /dsh_desktop/u);
    assert.match(removed, /\[mcp_servers\.other\]/u);
  });

  it("never writes a launch token into the configuration", () => {
    assert.doesNotMatch(block, /launchToken|dsh-auth-|\?token=/u);
  });
});

describe("claude configuration upsert", () => {
  const entry = { type: "stdio", command: NODE, args: [ENTRY], env: bridgeEnvironment("C:\\bridge\\connection.json", "claude") };

  it("adds the server next to existing keys and servers", () => {
    const before = JSON.stringify({ numStartups: 3, mcpServers: { other: { command: "a" } } });
    const after = JSON.parse(applyClaudeEntry(before, entry)) as Record<string, unknown>;
    assert.equal(after.numStartups, 3);
    const servers = after.mcpServers as Record<string, unknown>;
    assert.deepEqual(Object.keys(servers).sort(), [SERVER_NAME, "other"].sort());
  });

  it("is idempotent", () => {
    const once = applyClaudeEntry(undefined, entry);
    const twice = applyClaudeEntry(once, entry);
    assert.equal(twice, once);
  });

  it("removes only its own entry on uninstall", () => {
    const installed = applyClaudeEntry(JSON.stringify({ mcpServers: { other: { command: "a" } } }), entry);
    const removed = JSON.parse(applyClaudeEntry(installed, undefined)) as { mcpServers: Record<string, unknown> };
    assert.deepEqual(Object.keys(removed.mcpServers), ["other"]);
  });

  it("refuses a configuration that is not a JSON object", () => {
    assert.throws(() => applyClaudeEntry("[1,2]", entry));
  });

  it("records the caller kind for attribution only", () => {
    const claude = bridgeEnvironment("C:\\bridge\\connection.json", "claude");
    assert.equal(claude.DSH_CALLER_KIND, "claude-code");
    assert.equal(claude.DSH_APPROVAL_MODE, "desktop");
    assert.equal(claude.DSH_MODEL_POLICY, "inherit");
  });
});

describe("zcode configuration upsert", () => {
  const entry = { type: "stdio", command: NODE, args: [ENTRY], env: bridgeEnvironment("C:\\bridge\\connection.json", "zcode") };

  it("preserves settings and sibling servers, and removes only its own entry", () => {
    const existing = { plugins: { enabled: true }, mcp: { enabled: true, servers: { other: { command: "other" } } } };
    const once = applyZcodeEntry(JSON.stringify(existing), entry);
    assert.equal(applyZcodeEntry(once, entry), once);
    const parsed = JSON.parse(once);
    assert.deepEqual(parsed.plugins, existing.plugins);
    assert.equal(parsed.mcp.enabled, true);
    assert.deepEqual(parsed.mcp.servers.other, existing.mcp.servers.other);
    assert.deepEqual(parsed.mcp.servers.dsh_desktop, entry);
    assert.deepEqual(JSON.parse(applyZcodeEntry(once, undefined)), existing);
  });

  it("rejects malformed containers instead of overwriting them", () => {
    for (const content of ["[]", '{"mcp":null}', '{"mcp":{"servers":[]}}']) {
      assert.throws(() => applyZcodeEntry(content, entry));
    }
  });

  it("registers and reinstalls a project-scoped ZCode caller", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dsh-zcode-setup-"));
    const previous = process.env.DSH_CONNECTION_FILE;
    try {
      const connectionFile = join(dir, "connection.json");
      await writeFile(connectionFile, "{}", "utf8");
      process.env.DSH_CONNECTION_FILE = connectionFile;
      const options = parseArgs(["--caller", "zcode", "--scope", "project", "--project", dir, "--apply"]);
      const plan = await buildPlan(options);
      assert.equal(plan.writes.find((write) => write.kind === "mcp-config")?.target, join(dir, ".zcode", "config.json"));
      assert.deepEqual((await applyPlan(plan)).refused, []);
      const config = JSON.parse(await readFile(join(dir, ".zcode", "config.json"), "utf8"));
      assert.equal(config.mcp.servers.dsh_desktop.env.DSH_CALLER_KIND, "zcode");
      assert.equal(loadConfig(config.mcp.servers.dsh_desktop.env).callerKind, "zcode");
      assert.match(await readFile(join(dir, ".zcode", "skills", "zcode-dsh-desktop", "SKILL.md"), "utf8"), /name: zcode-dsh-desktop/u);
      assert.equal((await buildPlan(options)).writes.find((write) => write.kind === "mcp-config")?.before, "identical");
    } finally {
      if (previous === undefined) delete process.env.DSH_CONNECTION_FILE;
      else process.env.DSH_CONNECTION_FILE = previous;
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("setup-desktop plan", () => {
  it("defaults to a dry run and rejects mutually exclusive flags", () => {
    assert.equal(parseArgs([]).dryRun, true);
    assert.equal(parseArgs(["--apply"]).apply, true);
    assert.throws(() => parseArgs(["--dry-run", "--apply"]));
    assert.throws(() => parseArgs(["--caller", "emacs"]));
  });

  it("classifies an absent file, an absent entry and an intact entry differently", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dsh-cowork-setup-"));
    try {
      const connectionFile = join(dir, "connection.json");
      await writeFile(connectionFile, "{}", "utf8");
      process.env.DSH_CONNECTION_FILE = connectionFile;
      const plan = await buildPlan({ caller: "codex", scope: "project", dryRun: true, apply: false, replace: false, uninstall: false, projectDir: dir, entry: ENTRY });
      const config = plan.writes.find((write) => write.kind === "mcp-config");
      assert.equal(config?.before, "absent");
      const applied = await applyPlan({ ...plan, options: { ...plan.options, apply: true } });
      assert.ok(applied.changed.length > 0);

      const second = await buildPlan({ caller: "codex", scope: "project", dryRun: true, apply: false, replace: false, uninstall: false, projectDir: dir, entry: ENTRY });
      assert.equal(second.writes.find((write) => write.kind === "mcp-config")?.before, "identical");

      const written = await readFile(join(dir, ".codex", "config.toml"), "utf8");
      assert.match(written, /\[mcp_servers\.dsh_desktop\]/u);
    } finally {
      delete process.env.DSH_CONNECTION_FILE;
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("desktop MCP surface", () => {
  const stub = {
    hostStatus: async () => ({}),
  } as unknown as Parameters<typeof createMcpServer>[0];

  it("builds for both tool profiles", () => {
    // The desktop profile omits the interaction-answer tools entirely; the
    // legacy profile keeps the upstream surface. Both must construct.
    assert.ok(createMcpServer(stub, { toolProfile: "desktop" }));
    assert.ok(createMcpServer(stub, { toolProfile: "legacy" }));
  });

  it("identifies itself as dsh_desktop, distinct from the legacy dsh_agentlink server", async () => {
    // Read the emitted module: the assertion runs against what ships in dist/.
    const source = await readFile(new URL("../src/mcp-server.js", import.meta.url), "utf8");
    assert.match(source, /name: "dsh_desktop"/u);
    assert.doesNotMatch(source, /name: "dsh-agentlink"/u);
  });
});
