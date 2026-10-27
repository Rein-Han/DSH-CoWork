/** Read-only scheduling; no task control or model calls. */
export type WaitProfile = "bounded" | "adaptive" | "long";
export function maxWaitSeconds(profile: WaitProfile = "bounded"): number {
  return profile === "long" ? 900 : profile === "adaptive" ? 300 : 30;
}

export function adaptiveBudget(turn: unknown, nowMs = Date.now(), lastSteerAt?: string) {
  const startedAt = turn && typeof turn === "object" && "startedAt" in turn ? turn.startedAt : undefined;
  const start = typeof startedAt === "string" ? Date.parse(startedAt) : NaN;
  const age = nowMs - start;
  const trusted = Number.isFinite(age) && age >= 0;
  const steerAge = lastSteerAt === undefined ? NaN : nowMs - Date.parse(lastSteerAt);
  const afterSteer = Number.isFinite(steerAge) && steerAge >= 0 && steerAge < 120_000;
  const timeoutSec = !trusted || afterSteer || age < 300_000 ? 60 : age < 600_000 ? 120 : age < 900_000 ? 180 : 300;
  return { timeoutSec, runAgeSec: trusted ? Math.floor(age / 1000) : null,
    basis: afterSteer ? "recent_steer" : trusted ? "observed_turn_start" : "unknown_run_age" };
}
