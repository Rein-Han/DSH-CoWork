import { DescriptorProblem, type ConnectionGeneration } from "../../desktop/connection-descriptor.js";
import { resolveConnection } from "../../desktop/connection-resolver.js";
import type { AuthSession } from "../../desktop/auth-session.js";
import type { DshApi, DshMuxFrame, DshServerRequest, DshSubagentAddress, DshSubagentListValue } from "../../dsh-types.js";
import {
  assertCapability,
  type CapabilityName,
  type HostAdapter,
  type HostCapabilities,
} from "../contract.js";
import { DesktopPairedAdapter, SUPPORTED_PROTOCOL_FAMILIES } from "./adapter.js";

export interface PairedHostAdapterOptions {
  readonly connectionFile: string;
  readonly timeoutMs: number;
  /** Set only by tests that do not run the OS-level probes. */
  readonly skipNativeChecks?: boolean;
}

/**
 * A paired Host adapter that re-resolves its connection generation on demand.
 *
 * The bridge keeps one long-lived adapter object, but a Desktop restart changes
 * the instance id and the launch token under the same file path. Each generation
 * therefore gets its own {@link AuthSession} and its own
 * {@link DesktopPairedAdapter}; a generation that reports `auth_required` is
 * discarded whole — socket, cookie, and late frames included — before a new one
 * is read from the descriptor.
 */
export class PairedHostAdapter implements HostAdapter {
  private inner: DesktopPairedAdapter | undefined;
  private session: AuthSession | undefined;
  private generation: ConnectionGeneration | undefined;
  private negotiated: { protocolFamily: string; harnessVersion: string; desktopVersion: string } | undefined;
  private connecting: Promise<DesktopPairedAdapter> | undefined;
  private lastProblem: string | undefined;

  constructor(private readonly options: PairedHostAdapterOptions) {}

  get protocolFamily(): string {
    return this.negotiated?.protocolFamily ?? "unresolved";
  }

  readonly authMode = "browser-session" as const;

  /**
   * Stable error code of the most recent failed connection attempt (for example
   * `connector_missing` or `stale_connection`), or undefined once connected.
   */
  connectionProblem(): string | undefined {
    return this.lastProblem;
  }

  /** The generation this adapter most recently authenticated, if any. */
  currentGeneration(): ConnectionGeneration | undefined {
    return this.generation;
  }

  capabilities(): HostCapabilities {
    const family = this.negotiated?.protocolFamily;
    const table = family === undefined ? undefined : SUPPORTED_PROTOCOL_FAMILIES[family];
    const base: Record<CapabilityName, boolean> = {
      readSessions: false,
      createSession: false,
      prompt: false,
      follow: false,
      historyRecovery: false,
      cancelTurn: false,
      promptDedup: false,
      readModelSelection: false,
      selectModel: false,
      approvalRelay: false,
      questionRelay: false,
    };
    return table === undefined ? Object.freeze(base) : Object.freeze({ ...base, ...table });
  }

  requireCapability(capability: CapabilityName, action: string): void {
    assertCapability(this.capabilities(), this.protocolFamily, capability, action);
  }

  /**
   * Authenticate the descriptor currently on disk, reusing a live generation.
   * @returns the adapter bound to one authenticated generation.
   */
  async connect(): Promise<DesktopPairedAdapter> {
    if (this.inner !== undefined) return this.inner;
    if (this.connecting !== undefined) return this.connecting;
    const pending = (async () => {
      const resolved = await resolveConnection({
        connectionFile: this.options.connectionFile,
        ...(this.generation === undefined ? {} : { previousGeneration: this.generation }),
        ...(this.options.skipNativeChecks === undefined ? {} : { skipNativeChecks: this.options.skipNativeChecks }),
        timeoutMs: this.options.timeoutMs,
      });
      if (this.generation !== undefined && this.session !== undefined) {
        this.session.dispose();
      }
      this.session = resolved.session;
      this.generation = resolved.generation;
      this.negotiated = {
        protocolFamily: resolved.descriptor.protocolFamily,
        harnessVersion: resolved.descriptor.harnessVersion,
        desktopVersion: resolved.descriptor.desktopVersion,
      };
      this.inner = new DesktopPairedAdapter({
        session: resolved.session,
        protocolFamily: resolved.descriptor.protocolFamily,
        harnessVersion: resolved.descriptor.harnessVersion,
        desktopVersion: resolved.descriptor.desktopVersion,
      });
      return this.inner;
    })();
    this.connecting = pending;
    try {
      const connected = await pending;
      this.lastProblem = undefined;
      return connected;
    } catch (error) {
      const code = error !== null && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
      this.lastProblem = typeof code === "string" ? code : "connection_failed";
      throw error;
    } finally {
      if (this.connecting === pending) this.connecting = undefined;
    }
  }

  /** Drop the current generation so the next call re-reads the descriptor. */
  private invalidate(): void {
    this.inner?.disconnect().catch(() => undefined);
    this.inner = undefined;
    this.session = undefined;
  }

  private async run<T>(operation: (adapter: DesktopPairedAdapter) => Promise<T>): Promise<T> {
    const adapter = await this.connect();
    try {
      return await operation(adapter);
    } catch (error) {
      // One retry after a generation-level authentication failure: the Host may
      // have restarted, and a *read* is safe to repeat. Write retries are the
      // bridge's decision, never this layer's.
      if (isGenerationFailure(error)) {
        this.invalidate();
        const fresh = await this.connect();
        return await operation(fresh);
      }
      throw error;
    }
  }

  hostDescribe(signal?: AbortSignal) {
    return this.run((adapter) => adapter.hostDescribe(signal));
  }

  sessionList(signal?: AbortSignal) {
    return this.run((adapter) => adapter.sessionList(signal));
  }

  sessionCreate(payload: { cwd: string; agentPreset?: string; sessionId?: string }, signal?: AbortSignal) {
    return this.run((adapter) => adapter.sessionCreate(payload, signal));
  }

  sessionModels(sessionId: string, signal?: AbortSignal) {
    return this.run((adapter) => adapter.sessionModels(sessionId, signal));
  }

  sessionSelectModel(
    payload: { sessionId: string; provider: string; model: string; reasoningEffort?: string },
    signal?: AbortSignal,
  ) {
    return this.run((adapter) => adapter.sessionSelectModel(payload, signal));
  }

  sessionPrompt(
    payload: {
      sessionId: string;
      mode: "queue" | "steer";
      content: Array<{ type: "text"; text: string }>;
      clientTimeZone?: string;
    },
    signal?: AbortSignal,
  ) {
    return this.run((adapter) => adapter.sessionPrompt(payload, signal));
  }

  sessionRename(sessionId: string, title: string, signal?: AbortSignal) {
    return this.run((adapter) => adapter.sessionRename(sessionId, title, signal));
  }

  sessionHistory(sessionId: string, options?: { beforeSeq?: number; maxMessages?: number }, signal?: AbortSignal) {
    return this.run((adapter) => adapter.sessionHistory(sessionId, options, signal));
  }

  sessionCancel(sessionId: string, signal?: AbortSignal) {
    return this.run((adapter) => adapter.sessionCancel(sessionId, signal));
  }

  sessionWorkspaceState(sessionId: string, signal?: AbortSignal) {
    return this.run((adapter) => adapter.sessionWorkspaceState(sessionId, signal));
  }

  sessionUpdateQueue(sessionId: string, itemId: string, action: { kind: "remove" }, signal?: AbortSignal) {
    return this.run((adapter) => adapter.sessionUpdateQueue(sessionId, itemId, action, signal));
  }

  subagentList(parentSessionId: string, signal?: AbortSignal): Promise<import("../../dsh-types.js").DshUnaryResult<DshSubagentListValue>> {
    return this.run((adapter) => adapter.subagentList(parentSessionId, signal));
  }

  subagentHistory(
    address: DshSubagentAddress,
    options?: { beforeSeq?: number; maxMessages?: number },
    signal?: AbortSignal,
  ) {
    return this.run((adapter) => adapter.subagentHistory(address, options, signal));
  }

  async respond(): Promise<never> {
    this.requireCapability("approvalRelay", "answering a Host interaction");
    throw new CapabilityRefusal("approvalRelay");
  }

  openMux(signal: AbortSignal, onOpen?: () => void): AsyncIterable<DshServerRequest<DshMuxFrame>> {
    return this.mux(signal, onOpen);
  }

  private async *mux(signal: AbortSignal, onOpen?: () => void): AsyncIterable<DshServerRequest<DshMuxFrame>> {
    let announced = false;
    for (;;) {
      if (signal.aborted) return;
      const adapter = await this.connect();
      try {
        for await (const frame of adapter.openMux(signal, () => {
          announced = true;
          onOpen?.();
        })) {
          yield frame;
        }
      } catch (error) {
        if (signal.aborted) return;
        if (isGenerationFailure(error)) {
          this.invalidate();
          continue;
        }
        throw error;
      }
      if (signal.aborted) return;
      // A mux that completed without cancellation means the generation ended.
      void announced;
      this.invalidate();
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }

  async disconnect(): Promise<void> {
    this.invalidate();
  }
}

/** Internal marker for an unreachable refusal arm. */
class CapabilityRefusal extends Error {
  constructor(capability: string) {
    super(`capability ${capability} is unavailable`);
    this.name = "CapabilityRefusal";
  }
}

/**
 * Whether an error means the whole connection generation is gone.
 * @param error - a thrown value.
 * @returns true when the caller must re-read the descriptor.
 */
function isGenerationFailure(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  if (code === "auth_required" || code === "stale_connection" || code === "connection_file_insecure" || code === "host_identity_mismatch" || code === "desktop_not_running") {
    return true;
  }
  return false;
}

/** Re-exported so callers can distinguish "no connector" from "connector inactive". */
export { DescriptorProblem };
export type { DshApi };
