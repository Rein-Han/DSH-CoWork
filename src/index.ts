#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { BridgeService } from "./bridge-service.js";
import { loadConfig } from "./config.js";
import { DshConnectionManager } from "./connection-manager.js";
import { EventLedger } from "./event-ledger.js";
import { createHostAdapter } from "./host-adapters/factory.js";
import { createMcpServer } from "./mcp-server.js";
import { TaskStore } from "./task-store.js";

async function main() {
  const config = loadConfig();
  const selection = await createHostAdapter(config);
  const api = selection.adapter;
  const tasks = new TaskStore(config.homeDir);
  const ledger = new EventLedger(config.homeDir);
  const connection = new DshConnectionManager(config, api, tasks, ledger);
  const service = new BridgeService(config, api, tasks, connection, ledger);
  const server = createMcpServer(service, {
    // A paired Desktop bridge answers no Host interaction: the Desktop UI does.
    toolProfile: config.hostMode === "desktop-paired" ? "desktop" : "legacy",
  });
  const transport = new StdioServerTransport();
  let shutdownPromise: Promise<void> | undefined;

  const shutdown = async () => {
    shutdownPromise ??= (async () => {
      await connection.stop().catch(() => undefined);
      await api.disconnect().catch(() => undefined);
      await server.close().catch(() => undefined);
    })();
    await shutdownPromise;
  };

  transport.onclose = () => {
    void shutdown();
  };
  process.stdin.once("end", () => {
    void shutdown();
  });
  process.stdin.once("close", () => {
    void shutdown();
  });
  process.once("SIGINT", () => {
    void shutdown();
  });
  process.once("SIGTERM", () => {
    void shutdown();
  });

  connection.start();
  await server.connect(transport);
  console.error(`[dsh-desktop-cowork] connect-only MCP ready; configured target ${selection.summary}`);
}

void main().catch((error) => {
  console.error(
    `[dsh-desktop-cowork] fatal: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
  );
  process.exitCode = 1;
});
