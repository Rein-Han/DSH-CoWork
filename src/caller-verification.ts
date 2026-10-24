/** Shared bounded observation for explicit SDK smoke checks, not native UI acceptance. */
export type VerificationCall = (name: string, args: Record<string, unknown>) => Promise<Record<string, any>>;
const terminal = new Set(["turn_completed", "failed", "canceled", "interrupted"]);

export async function observeVerification(
  call: VerificationCall, taskId: string, targetStartAfterCursor: number,
  timeoutMs = 180_000, now: () => number = () => performance.now(),
): Promise<{ execution: string; finalMessage: string | null; release: unknown }> {
  if (!Number.isSafeInteger(targetStartAfterCursor) || targetStartAfterCursor < 0) throw new Error("a verified receipt target is required; do not guess the current run");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("timeout must be positive");
  const deadline = now() + timeoutMs;
  let sinceCursor = targetStartAfterCursor;
  while (now() < deadline) {
    const waited = await call("dsh_wait", { taskId, targetStartAfterCursor, sinceCursor,
      timeoutSec: Math.max(0, Math.min(30, Math.floor((deadline - now()) / 1000))), until: "terminal", responseMode: "compact" });
    if (typeof waited.nextCursor !== "number" || waited.nextCursor < sinceCursor) throw new Error(`invalid wait cursor; preserve task ${taskId}`);
    sinceCursor = waited.nextCursor;
    if (waited.availability !== "connected" || waited.wakeReason === "observation_error") throw new Error(`observation unavailable; preserve task ${taskId} and its receipt`);
    if (waited.execution?.startsWith("awaiting_") || waited.pendingInteractions?.length) throw new Error(`DSH Desktop needs user interaction; resume task ${taskId}`);
    if (!terminal.has(waited.execution)) {
      if (deadline - now() < 1000) break; // No timeout=0 busy loop at the budget boundary.
      continue;
    }
    let finalMessage: string | null = null;
    if (waited.execution === "turn_completed") {
      const status = await call("dsh_status", { taskId });
      const pointer = waited.finalMessagePointer;
      if (!pointer || pointer.sessionId !== status.finalMessagePointer?.sessionId || pointer.seq !== status.finalMessagePointer?.seq ||
          status.execution !== "turn_completed" || status.contentUnavailable || typeof status.finalMessage !== "string") {
        throw new Error(`complete result is unavailable or another run is current; inspect the receipt target and dsh_tail before releasing task ${taskId}`);
      }
      finalMessage = status.finalMessage;
    }
    // The real release guard continues to refuse busy/unknown tasks.
    const release = await call("dsh_release_workspace", { taskId });
    return { execution: waited.execution, finalMessage, release };
  }
  throw new Error(`observation budget expired; task ${taskId} remains live; resume with the saved receipt, do not delegate again`);
}
