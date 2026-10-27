/** Observation policy is independent of the transport and never cancels a DSH task. */
export interface WaitOptions {
  until?: "change" | "terminal";
  responseMode?: "full" | "compact";
  targetStartAfterCursor?: number;
  /** Desktop observation policy only; legacy callers leave these unset. */
  adaptive?: boolean;
  supervise?: boolean;
  acknowledgedWakeKey?: string;
  signal?: AbortSignal;
  /** Internal MCP progress callback, never a model/tool response. */
  progress?: (elapsedSeconds: number) => Promise<void>;
}

export interface WaitView {
  taskId: string;
  rootSessionId: string;
  cursor: number;
  availability: string;
  execution: string;
  pendingInteractions: readonly unknown[];
  connection: { revision: number };
  observationRevision?: number;
  recovery: { state: string };
  observation?: { state: "pending" | "following" | "capacity" | "retrying"; reason?: string };
  snapshotFreshness?: "stale" | "refreshed";
  [key: string]: unknown;
}

const terminal = new Set(["turn_completed", "failed", "canceled", "interrupted"]);
export function meaningfulWake(view: WaitView): string | undefined {
  if (view.availability !== "connected") return "availability";
  if (view.recovery.state !== "reconciled") return "observation_error";
  if (terminal.has(view.execution)) return "terminal";
  if (view.observation?.state === "capacity" || view.observation?.state === "retrying") return "observation_error";
  if (view.pendingInteractions.length > 0 || view.execution.startsWith("awaiting_")) return "interaction";
  return undefined;
}

export async function waitWithPolicy<T extends WaitView>(input: {
  timeoutSec: number;
  sinceCursor?: number;
  options: WaitOptions;
  selectTimeout?: (view: T) => number;
  read(initial: boolean, signal: AbortSignal): Promise<T>;
  wait(cursor: number, revision: number, remainingMs: number, signal: AbortSignal): Promise<unknown>;
}) {
  const controller = new AbortController();
  const abort = () => controller.abort(input.options.signal?.reason);
  input.options.signal?.addEventListener("abort", abort, { once: true });
  if (input.options.signal?.aborted) abort();
  // Monotonic, single deadline: ordinary events do not restart the budget.
  const started = performance.now();
  // Before a run age is known, keep initial synchronization in the short tier.
  let deadline = started + (input.options.adaptive ? Math.min(input.timeoutSec, 60) : input.timeoutSec) * 1000;
  let progressTimer: ReturnType<typeof setTimeout> | undefined;
  let progressStopped = false;
  const stopProgress = () => { progressStopped = true; clearTimeout(progressTimer); };
  const scheduleProgress = () => {
    if (!input.options.progress || progressStopped || controller.signal.aborted || performance.now() >= deadline) return;
    progressTimer = setTimeout(() => {
      if (progressStopped || controller.signal.aborted || performance.now() >= deadline) return;
      // One in flight; transport failure is not a reason to retry a task or to
      // lose its eventual result. Elapsed seconds are not a completion percent.
      void Promise.resolve().then(() => {
        if (!progressStopped && !controller.signal.aborted) return input.options.progress!(Math.max(0, (performance.now() - started) / 1000));
      })
        .then(scheduleProgress, stopProgress);
    }, 30_000);
    progressTimer.unref?.();
  };
  controller.signal.addEventListener("abort", stopProgress, { once: true });
  scheduleProgress();
  const bounded = async <V>(operation: () => Promise<V>): Promise<V> => {
    controller.signal.throwIfAborted();
    if (input.timeoutSec === 0) return operation();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: () => void = () => {};
    try {
      return await Promise.race([operation(), new Promise<never>((_, reject) => {
        abort = () => reject(controller.signal.reason ?? new Error("observation canceled"));
        controller.signal.addEventListener("abort", abort, { once: true });
        timer = setTimeout(() => reject(Object.assign(new Error("observation synchronization exceeded the wait deadline"), { code: "observation_timeout" })), Math.max(0, deadline - performance.now()));
      })]);
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", abort);
    }
  };
  const lastRead = async (): Promise<T | undefined> => {
    const final = new AbortController();
    const cancel = () => final.abort(controller.signal.reason);
    controller.signal.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(() => final.abort(new Error("final observation read timed out")), 150);
    try {
      return await Promise.race([
        input.read(false, final.signal),
        new Promise<undefined>((resolve) => final.signal.addEventListener("abort", () => resolve(undefined), { once: true })),
      ]);
    } catch {
      controller.signal.throwIfAborted();
      return undefined;
    } finally {
      clearTimeout(timer);
      final.abort();
      controller.signal.removeEventListener("abort", cancel);
      controller.signal.throwIfAborted();
    }
  };
  try {
    controller.signal.throwIfAborted();
    let view = await bounded(() => input.read(true, controller.signal));
    if (input.selectTimeout) deadline = started + Math.min(input.timeoutSec, input.selectTimeout(view)) * 1000;
    let cursor = input.sinceCursor ?? view.cursor;
    const observationRevision = (v: T) => v.observationRevision ?? v.connection.revision;
    let revision = observationRevision(view);
    const atDeadline = async () => {
      const latest = await lastRead();
      if (latest !== undefined) {
        return { timedOut: true, wakeReason: "timeout", status: { ...latest, snapshotFreshness: "refreshed" as const }, nextCursor: latest.cursor };
      }
      return { timedOut: true, wakeReason: "timeout", status: { ...view, snapshotFreshness: "stale" as const }, nextCursor: view.cursor };
    };
    for (;;) {
      controller.signal.throwIfAborted();
      const reason = meaningfulWake(view) ?? (input.options.supervise && view.observationIssue ? "supervision" : undefined);
      const wakeKey = reason && reason !== "terminal" ? observationWakeKey(view, reason) : undefined;
      if (reason && (wakeKey === undefined || wakeKey !== input.options.acknowledgedWakeKey)) {
        return { timedOut: false, wakeReason: reason, status: view, nextCursor: view.cursor, ...(wakeKey ? { wakeKey } : {}) };
      }
      if ((input.options.until ?? "change") === "change" && (view.cursor > cursor || observationRevision(view) > revision)) {
        return { timedOut: false, wakeReason: "change", status: view, nextCursor: view.cursor };
      }
      const remaining = deadline - performance.now();
      if (remaining <= 0) return await atDeadline();
      cursor = view.cursor;
      revision = observationRevision(view);
      await input.wait(cursor, revision, remaining, controller.signal);
      controller.signal.throwIfAborted();
      if (performance.now() >= deadline) return await atDeadline();
      try {
        view = await bounded(() => input.read(false, controller.signal));
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "observation_timeout") {
          return await atDeadline();
        }
        throw error;
      }
    }
  } finally {
    stopProgress();
    controller.signal.removeEventListener("abort", stopProgress);
    input.options.signal?.removeEventListener("abort", abort);
    controller.abort();
  }
}

export function compactWait(result: { timedOut: boolean; wakeReason: string; status: WaitView; nextCursor: number; wakeKey?: string }) {
  const s = result.status;
  const summary: Record<string, unknown> = {
    schemaVersion: 1,
    policyVersion: 3,
    taskId: s.taskId, rootSessionId: s.rootSessionId,
    timedOut: result.timedOut, wakeReason: result.wakeReason,
    availability: s.availability, execution: s.execution, nextCursor: result.nextCursor,
    lastKnownExecutionStatus: s.lastKnownExecutionStatus,
    connectionRevision: s.connection.revision,
    finalMessageStatus: s.finalMessageStatus,
    contentUnavailable: s.contentUnavailable,
    recovery: s.recovery, queueDepth: s.queueDepth,
    ...(s.observation === undefined ? {} : { observation: s.observation }),
    ...(s.snapshotFreshness === undefined ? {} : { snapshotFreshness: s.snapshotFreshness }),
    ...(s.observedRunStartCursor === undefined ? {} : { observedRunStartCursor: s.observedRunStartCursor }),
    ...(result.wakeKey === undefined ? {} : { wakeKey: result.wakeKey }),
    ...(s.waitSchedule === undefined ? {} : { waitSchedule: s.waitSchedule }),
    ...(s.observationIssue === undefined ? {} : { observationIssue: s.observationIssue }),
  };
  if (s.visualFallback !== null && s.visualFallback !== undefined) summary.visualFallbackDetails = "dsh_status";
  // Content is retrieved with existing status/tail tools, never silently truncated.
  // This also bounds large questions/answers without dropping their existence.
  if (s.pendingInteractions.length) {
    summary.pendingInteractionCount = s.pendingInteractions.length;
    summary.pendingInteractions = s.pendingInteractions.slice(0, 4).map(interactionSummary);
    summary.pendingInteractionDetails = "dsh_status; Desktop interactions are answered in Desktop UI";
  } else {
    summary.pendingInteractions = [];
  }
  if (s.finalMessageStatus === "available" || s.finalMessageStatus === "pointer_available") {
    summary.finalMessagePointer = s.finalMessagePointer;
    summary.finalMessageAfterCursor = s.finalMessageAfterCursor;
    summary.finalMessageDetails = "dsh_status or dsh_tail";
  }
  if (Buffer.byteLength(JSON.stringify(summary)) > 4096) {
    summary.recovery = { state: s.recovery.state, details: "dsh_status" };
    summary.contentUnavailable = s.contentUnavailable === false ? false : { details: "dsh_status" };
    summary.pendingInteractions = [];
    summary.pendingInteractionDetails = "dsh_status; summaries omitted to keep this response bounded";
  }
  return summary;
}

function interactionSummary(value: unknown) {
  const object = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return Object.fromEntries(["type", "sessionId", "requestId", "approvalId"].flatMap(key => {
    const v = object[key];
    // Never provide a truncated identifier that could be mistaken for a usable ID.
    return typeof v === "string" && v.length <= 160 ? [[key, v]] : [];
  }));
}

import { createHash } from "node:crypto";
function observationWakeKey(view: WaitView, reason: string): string {
  const identity = reason === "supervision" ? view.observationIssue :
    reason === "interaction" ? view.pendingInteractions.map(interactionSummary) :
    { availability: view.availability, recovery: view.recovery.state, observation: view.observation };
  return createHash("sha256").update(JSON.stringify([view.taskId, reason, identity])).digest("hex").slice(0, 24);
}
