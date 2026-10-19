#!/usr/bin/env node
/**
 * `uninstall-desktop` — remove exactly what `setup-desktop` installed.
 *
 * It is the documented command name for `setup-desktop --uninstall`; both entry
 * points run the same plan/apply code, so there is one removal implementation
 * and one set of safety checks.
 *
 * Usage:
 *   uninstall-desktop --dry-run
 *   uninstall-desktop --apply
 */

import { applyPlan, buildPlan, parseArgs } from "./setup-desktop.js";

async function main(): Promise<void> {
  const argv = process.argv.slice(2).filter((arg) => arg !== "--uninstall");
  const options = { ...parseArgs(argv), uninstall: true };
  const plan = await buildPlan(options);
  console.log("# uninstall-desktop");
  for (const write of plan.writes) console.log(`- ${write.caller} ${write.kind} ${write.target} (current: ${write.before})`);
  for (const warning of plan.warnings) console.log(`note: ${warning}`);
  const result = await applyPlan(plan);
  for (const line of result.lines) console.log(line);
  for (const refusal of result.refused) console.log(`refused: ${refusal}`);
  if (!options.apply) console.log("no files were changed; rerun with --apply to remove this build's entries");
  else console.log(`removed or updated ${String(result.changed.length)} paths; DSH sessions, project files and the task ledger are kept`);
}

void main().catch((error: unknown) => {
  console.error(`uninstall-desktop: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
