import type { DshClient, HostEndpointSnapshot } from "../dsh-client.js";
import {
  assertCapability,
  fullCapabilities,
  type CapabilityName,
  type HostAdapter,
  type HostCapabilities,
} from "./contract.js";
import type { DshHostDescription, DshSessionModels, DshSessionSummary, DshUnaryResult } from "../dsh-types.js";

/**
 * The upstream RC6 HTTP + `events.mux` client, kept as a regression adapter.
 *
 * It is never selected for a Desktop Host: RC6 has no authentication step, no
 * request ids, and no session/page or session/follow contract, so it cannot
 * carry the guarantees this build promises. It exists so the legacy behaviour
 * the upstream tests cover keeps running.
 */
export class LegacyRc6Adapter implements HostAdapter {
  readonly protocolFamily = "dsh-legacy-rc6";
  readonly authMode = "none" as const;
  private readonly capabilitiesValue: HostCapabilities = Object.freeze({
    ...fullCapabilities(),
    promptDedup: false,
    approvalRelay: true,
    questionRelay: true,
  });

  constructor(private readonly client: DshClient) {}

  capabilities(): HostCapabilities {
    return this.capabilitiesValue;
  }

  requireCapability(capability: CapabilityName, action: string): void {
    assertCapability(this.capabilitiesValue, this.protocolFamily, capability, action);
  }

  endpointSnapshot(): HostEndpointSnapshot {
    return this.client.endpointSnapshot();
  }

  hostDescribe(signal?: AbortSignal): Promise<DshUnaryResult<DshHostDescription>> {
    return this.client.hostDescribe(signal);
  }

  sessionList(signal?: AbortSignal): Promise<DshUnaryResult<{ items: DshSessionSummary[] }>> {
    return this.client.sessionList(signal);
  }

  sessionCreate(payload: { cwd: string; agentPreset?: string; sessionId?: string }, signal?: AbortSignal) {
    return this.client.sessionCreate(payload, signal);
  }

  sessionModels(sessionId: string, signal?: AbortSignal): Promise<DshUnaryResult<DshSessionModels>> {
    return this.client.sessionModels(sessionId, signal);
  }

  sessionSelectModel(
    payload: { sessionId: string; provider: string; model: string; reasoningEffort?: string },
    signal?: AbortSignal,
  ) {
    return this.client.sessionSelectModel(payload, signal);
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
    return this.client.sessionPrompt(payload, signal);
  }

  sessionRename(sessionId: string, title: string, signal?: AbortSignal) {
    return this.client.sessionRename(sessionId, title, signal);
  }

  sessionHistory(sessionId: string, options?: { beforeSeq?: number; maxMessages?: number }, signal?: AbortSignal) {
    return this.client.sessionHistory(sessionId, options, signal);
  }

  sessionCancel(sessionId: string, signal?: AbortSignal) {
    return this.client.sessionCancel(sessionId, signal);
  }

  sessionUpdateQueue(
    sessionId: string,
    itemId: string,
    action: { kind: "remove" },
    signal?: AbortSignal,
  ) {
    return this.client.sessionUpdateQueue(sessionId, itemId, action, signal);
  }

  subagentList(parentSessionId: string, signal?: AbortSignal) {
    return this.client.subagentList(parentSessionId, signal);
  }

  subagentHistory(
    address: { parentSessionId: string; childSessionId: string; mode: "one-shot" | "continuable" },
    options?: { beforeSeq?: number; maxMessages?: number },
    signal?: AbortSignal,
  ) {
    return this.client.subagentHistory(address, options, signal);
  }

  respond(message: Parameters<DshClient["respond"]>[0], signal?: AbortSignal) {
    return this.client.respond(message, signal);
  }

  openMux(signal: AbortSignal, onOpen?: () => void) {
    return this.client.openMux(signal, onOpen);
  }

  async disconnect(): Promise<void> {
    // The legacy client owns no socket between mux openings and no cookie.
  }
}
