#!/usr/bin/env node
/**
 * `doctor --desktop [--json]` — layered diagnostics for the paired path.
 *
 * Without `--desktop` this delegates to the upstream doctor, which still knows
 * how to describe a static or auto-discovered Web Host.
 */

import { inspectDesktopHost, judge } from "./desktop/doctor-desktop.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (!args.includes("--desktop")) {
    console.error("doctor: this entry point reports the paired Desktop path only; pass --desktop [--json]");
    console.error("for a static or auto-discovered Web Host, run the upstream doctor: dsh-cowork-legacy-doctor");
    process.exitCode = 1;
    return;
  }
  const json = args.includes("--json");
  const facts = await inspectDesktopHost();
  const layers = judge(facts);
  if (json) {
    console.log(JSON.stringify({ facts, layers }, null, 2));
  } else {
    console.log("dsh-desktop-cowork doctor --desktop");
    console.log(`  platform     ${facts.platform} (node ${facts.nodeVersion})`);
    console.log(`  desktop      ${facts.desktopVersion ?? "unknown"}${facts.runtimeNode === undefined ? "" : ` (bundled node ${facts.runtimeNode}, pnpm ${facts.runtimePnpm ?? "?"})`}`);
    console.log(`  dsh home     ${facts.dshHome ?? "?"}`);
    console.log(`  profile      ${facts.profileDir ?? "?"} (${facts.profileKind ?? "?"})`);
    console.log(`  connector    registered=${String(facts.connectorRegistered)} resolvable=${String(facts.connectorResolvable)}`);
    console.log(`  connections  ${facts.connectionsRoot}`);
    if (facts.connectionFile !== undefined) console.log(`  descriptor   ${facts.connectionFile}`);
    for (const layer of layers) {
      console.log(`  [${layer.status}] ${layer.layer}: ${layer.detail}`);
    }
    for (const problem of facts.problems) console.log(`  problem: ${problem}`);
  }
  if (layers.some((layer) => layer.status === "blocked")) process.exitCode = 2;
}

void main().catch((error: unknown) => {
  console.error(`doctor --desktop: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
