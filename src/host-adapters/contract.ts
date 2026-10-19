import type { DshApi } from "../dsh-types.js";

/**
 * The Host boundary the bridge programs against.
 *
 * `BridgeService` and `DshConnectionManager` call this interface instead of any
 * particular wire format, so the legacy RC6 HTTP/mux client and the Desktop's
 * browser-session/Typert-Gateway client are interchangeable — but never silently
 * equivalent, because {@link HostCapabilities} states what a given adapter can
 * actually do before any write is attempted.
 *
 * @module host-adapters/contract
 */

export type CapabilityName =
  | "readSessions"
  | "createSession"
  | "prompt"
  | "follow"
  | "historyRecovery"
  | "cancelTurn"
  | "promptDedup"
  | "readModelSelection"
  | "selectModel"
  | "approvalRelay"
  | "questionRelay";

export type HostCapabilities = Readonly<Record<CapabilityName, boolean>>;

/** Every capability an adapter may declare. */
export const CAPABILITY_NAMES: readonly CapabilityName[] = [
  "readSessions",
  "createSession",
  "prompt",
  "follow",
  "historyRecovery",
  "cancelTurn",
  "promptDedup",
  "readModelSelection",
  "selectModel",
  "approvalRelay",
  "questionRelay",
];

/** The stable error code returned when a capability the caller needs is absent. */
export class CapabilityUnavailableError extends Error {
  readonly code = "capability_unavailable" as const;
  constructor(
    readonly capability: CapabilityName,
    readonly action: string,
    readonly protocolFamily: string,
  ) {
    super(
      `${action} requires the ${capability} capability, which this Host adapter does not provide (protocol family ${protocolFamily}). Nothing was sent to the Host.`,
    );
    this.name = "CapabilityUnavailableError";
  }
}

/** A Host-facing adapter the bridge can drive. */
export interface HostAdapter extends DshApi {
  /** Installed protocol family this adapter was selected for. */
  readonly protocolFamily: string;
  /** Handshake family the adapter uses to authenticate. */
  readonly authMode: "api-connect" | "browser-session" | "none";
  /** What this adapter can do; computed from the verified version table. */
  capabilities(): HostCapabilities;
  /**
   * Refuse an action whose capability is missing, before any request is sent.
   * @param capability - capability the caller needs.
   * @param action - human description used in the refusal.
   */
  requireCapability(capability: CapabilityName, action: string): void;
  /** Release sockets and cookies owned by this adapter. */
  disconnect(): Promise<void>;
}

/**
 * Build the all-true capability record used by the legacy adapter and by fakes.
 * @returns a mutable copy of the full capability set.
 */
export function fullCapabilities(): Record<CapabilityName, boolean> {
  return {
    readSessions: true,
    createSession: true,
    prompt: true,
    follow: true,
    historyRecovery: true,
    cancelTurn: true,
    promptDedup: false,
    readModelSelection: true,
    selectModel: true,
    approvalRelay: true,
    questionRelay: true,
  };
}

/**
 * Enforce one capability.
 * @param capabilities - adapter capability record.
 * @param protocolFamily - adapter family, for the refusal message.
 * @param capability - required capability.
 * @param action - the action being refused.
 */
export function assertCapability(
  capabilities: HostCapabilities,
  protocolFamily: string,
  capability: CapabilityName,
  action: string,
): void {
  if (capabilities[capability] === true) return;
  throw new CapabilityUnavailableError(capability, action, protocolFamily);
}

