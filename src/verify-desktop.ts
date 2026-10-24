#!/usr/bin/env node
/**
 * `verify-desktop` — one real end-to-end round trip against the already-running
 * Desktop Host, in a dedicated acceptance directory.
 *
 * It creates a session in the given project directory, sends one harmless
 * prompt, follows the session until its turn ends, and reports the final
 * assistant text plus the exact session id so the operator can compare it with
 * what the Desktop UI shows. Nothing is cleaned up silently: the session stays
 * in the user's Desktop as evidence.
 *
 * Usage:
 *   verify-desktop --project <dedicated-acceptance-dir> [--timeout <seconds>] [--json]
 */

import { resolve } from "node:path";

import { configuredConnectionFile, inspectDesktopHost } from "./desktop/doctor-desktop.js";
import { resolveConnection } from "./desktop/connection-resolver.js";
import { DesktopPairedAdapter } from "./host-adapters/desktop-paired/adapter.js";

const PROMPT =
  "This is a bridge acceptance check. Do not modify any file. Reply with one short line that states the working directory you were started in and then say OK.";

export interface VerifyResult {
  status: "PASS" | "BLOCKED" | "FAIL";
  connectionFile?: string;
  origin?: string;
  protocolFamily?: string;
  sessionId?: string;
  turnEnded?: boolean;
  finalText?: string | undefined;
  steps: Array<{ step: string; ok: boolean; detail: string }>;
}

function parseArgs(argv: readonly string[]): { project: string; timeoutMs: number; json: boolean } {
  let project = "";
  let timeoutMs = 180_000;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--project") {
      project = argv[index + 1] ?? "";
      index += 1;
    } else if (arg === "--timeout") {
      const value = Number(argv[index + 1]);
      if (Number.isFinite(value) && value > 0) timeoutMs = value * 1000;
      index += 1;
    } else if (arg === "--json") {
      json = true;
    }
  }
  if (project === "") throw new Error("--project <dedicated-acceptance-dir> is required");
  return { project: resolve(project), timeoutMs, json };
}

/** Extract the last assistant message text from a session event. */
export function assistantTextOf(event: { type: string; data: unknown }): string | undefined {
  if (event.type !== "assistant/message") return undefined;
  const data = event.data as { message?: { content?: unknown } } | null;
  const content = data?.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  return content
    .map((part) => (typeof part === "object" && part !== null && "text" in part ? String((part as { text: unknown }).text) : ""))
    .join("")
    .trim();
}

/**
 * Run the acceptance round trip.
 * @param project - absolute acceptance directory.
 * @param timeoutMs - upper bound for one turn.
 * @returns the structured result.
 */
export async function verifyDesktop(project: string, timeoutMs: number): Promise<VerifyResult> {
  const steps: VerifyResult["steps"] = [];
  const facts = await inspectDesktopHost();
  steps.push({
    step: "desktop-facts",
    ok: facts.desktopVersion !== undefined,
    detail: `Desktop ${facts.desktopVersion ?? "unknown"}, profile ${facts.profileKind ?? "unknown"}, connector registered ${String(facts.connectorRegistered)}`,
  });
  const connectionFile = facts.connectionFile ?? (await configuredConnectionFile());
  if (connectionFile === undefined) {
    steps.push({ step: "connection-file", ok: false, detail: facts.problems.join("; ") });
    return { status: "BLOCKED", steps };
  }

  let resolved;
  try {
    resolved = await resolveConnection({ connectionFile });
  } catch (error) {
    steps.push({
      step: "connection-file",
      ok: false,
      detail: error instanceof Error ? `${(error as { code?: string }).code ?? "error"}: ${error.message}` : String(error),
    });
    return { status: "BLOCKED", connectionFile, steps };
  }
  steps.push({
    step: "connection-file",
    ok: true,
    detail: `authenticated ${resolved.origin} (family ${resolved.descriptor.protocolFamily}, age ${String(Math.round(resolved.ageMs / 1000))}s)`,
  });

  const adapter = new DesktopPairedAdapter({
    session: resolved.session,
    protocolFamily: resolved.descriptor.protocolFamily,
    harnessVersion: resolved.descriptor.harnessVersion,
    desktopVersion: resolved.descriptor.desktopVersion,
  });
  const base: VerifyResult = {
    status: "FAIL",
    connectionFile,
    origin: resolved.origin,
    protocolFamily: resolved.descriptor.protocolFamily,
    steps,
  };

  const deadline = Date.now() + timeoutMs;
  try {
    const created = await adapter.sessionCreate({ cwd: project, projectRoot: project });
    const workspace = created.desktopWorkspace;
    steps.push({
      step: "session-create",
      ok: workspace.sessionCwd === workspace.path && workspace.requestedCwd === workspace.path,
      detail: `created ${created.sessionId} in ${workspace.path} (${workspace.resolution}, created=${String(workspace.created)})`,
    });
    base.sessionId = created.sessionId;

    await adapter.sessionPrompt({ sessionId: created.sessionId, mode: "queue", content: [{ type: "text", text: PROMPT }] });
    steps.push({ step: "session-prompt", ok: true, detail: "prompt accepted" });

    let finalText: string | undefined;
    let turnEnded = false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1_000, deadline - Date.now()));
    try {
      for await (const frame of resolved.session.openStream(
        "session/follow",
        { request: { address: { kind: "session", sessionId: created.sessionId }, assistantStream: true } },
        controller.signal,
      )) {
        if (frame.type !== "item") continue;
        const value = frame.value as { type?: string; event?: { type: string; data: unknown }; records?: Array<{ event: { type: string; data: unknown } }> };
        const events =
          value.type === "snapshot"
            ? (value.records ?? []).map((record) => record.event)
            : value.type === "event" && value.event !== undefined
              ? [value.event]
              : [];
        for (const event of events) {
          const text = assistantTextOf(event);
          if (text !== undefined && text !== "") finalText = text;
          if (event.type === "turn/end") turnEnded = true;
        }
        if (turnEnded) break;
      }
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
    base.turnEnded = turnEnded;
    base.finalText = finalText;
    steps.push({ step: "turn-end", ok: turnEnded, detail: turnEnded ? "the Host reported turn/end" : "the turn did not end before the timeout" });
    steps.push({ step: "final-text", ok: (finalText ?? "") !== "", detail: finalText === undefined ? "no assistant text was observed" : finalText.slice(0, 400) });
    base.status = turnEnded && (finalText ?? "") !== "" ? "PASS" : "FAIL";
    return base;
  } catch (error) {
    steps.push({
      step: "round-trip",
      ok: false,
      detail: error instanceof Error ? `${(error as { code?: string }).code ?? error.name}: ${error.message}` : String(error),
    });
    base.status = "FAIL";
    return base;
  } finally {
    await adapter.disconnect();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const result = await verifyDesktop(args.project, args.timeoutMs);
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`verify-desktop: ${result.status}`);
    for (const step of result.steps) console.log(`  ${step.ok ? "ok  " : "FAIL"} ${step.step}: ${step.detail}`);
    if (result.sessionId !== undefined) console.log(`session: ${result.sessionId}`);
  }
  if (result.status !== "PASS") process.exitCode = 2;
}

if (process.argv[1] !== undefined) {
  void main().catch((error: unknown) => {
    console.error(`verify-desktop: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

