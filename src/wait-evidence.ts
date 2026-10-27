import type { LedgerRecord } from "./event-ledger.js";

/** Derived, incremental observation index. Rebuilt from persisted sanitized records on restart. */
export class WaitEvidenceIndex {
  processed = 0;
  lastSteerAt?: string;
  issue?: { kind: "consecutive_tool_failures"; cursor: number; sourceSessionId: string; count: number; details: string };
  private failures = new Map<string, number>();

  update(records: readonly LedgerRecord[]) {
    for (let i = this.processed; i < records.length; i++) {
      const r = records[i]!;
      const raw = r.coordination as { mode?: string; event?: { type?: string; data?: { error?: boolean } } };
      if (r.origin === "root" && raw.event?.type === "turn/start") {
        this.failures.clear(); delete this.issue; delete this.lastSteerAt;
      }
      if (r.type === "bridge/prompt-issued" && raw.mode === "steer") this.lastSteerAt = r.observedAt;
      if (raw.event?.type !== "tool/result") continue;
      if (typeof raw.event.data?.error !== "boolean") {
        // Older bridges do not persist the bit; unknown outcomes break a streak.
        this.failures.delete(r.sourceSessionId); continue;
      }
      const count = raw.event.data.error ? (this.failures.get(r.sourceSessionId) ?? 0) + 1 : 0;
      this.failures.set(r.sourceSessionId, count);
      // One alert per failure streak, not a new model wake for every failed retry.
      if (count === 3) this.issue = { kind: "consecutive_tool_failures", cursor: r.cursor,
        sourceSessionId: r.sourceSessionId, count, details: "dsh_tail around cursor; inspect DSH for full tool evidence" };
    }
    this.processed = records.length;
  }
}
