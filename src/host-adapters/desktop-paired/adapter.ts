import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

import type { AuthSession } from "../../desktop/auth-session.js";
import { attachDshUnaryMetadata } from "../../dsh-types.js";
import type {
  DshApi,
  DshHostDescription,
  DshMuxFrame,
  DshServerRequest,
  DshSessionHistory,
  DshSessionModels,
  DshSessionSummary,
  DshSubagentAddress,
  DshSubagentListValue,
  DshUnaryResult,
  DshWorkspaceState,
} from "../../dsh-types.js";
import {
  assertCapability,
  type CapabilityName,
  type HostAdapter,
  type HostCapabilities,
} from "../contract.js";
import {
  ENDPOINTS,
  sessionCreateResultSchema,
  sessionFollowFrameSchema,
  sessionListResultSchema,
  sessionPageResultSchema,
  sessionProjectionsResultSchema,
  workspaceInboxSchema,
  workspaceJobsSchema,
  workspaceCreateResultSchema,
} from "./protocol.js";
import type { SessionEvent } from "./protocol.js";

/**
 * Version table of Desktop Host releases this bridge implements.
 *
 * A family is listed only after its generated endpoint table and wire frames
 * were read from the installed release. An unlisted family is refused rather
 * than attempted: a plausible-looking port number is not compatibility.
 */
export const SUPPORTED_PROTOCOL_FAMILIES: Readonly<Record<string, Partial<HostCapabilities>>> = {
  "dsh-host-0.2": {
    readSessions: true,
    createSession: true,
    prompt: true,
    follow: true,
    historyRecovery: true,
    cancelTurn: true,
    // `session/prompt` carries a caller-supplied requestId, so a retry after a
    // lost response can reuse the identical id instead of launching a second turn.
    promptDedup: true,
    readModelSelection: true,
    // The private build never selects a model or reasoning effort.
    selectModel: false,
    // interactions=none: approvals and DSH questions stay in the Desktop UI.
    approvalRelay: false,
    questionRelay: false,
  },
};

const DISCOVERY_INTERVAL_MS = 5_000;
const MAX_FOLLOWED_SESSIONS = 24;

export class UnsupportedHostVersionError extends Error {
  readonly code = "unsupported_host_version" as const;
  constructor(readonly protocolFamily: string, readonly harnessVersion: string) {
    super(
      `DSH Desktop ${harnessVersion} speaks protocol family ${protocolFamily}, which this bridge does not implement; refusing to send anything to the Host`,
    );
    this.name = "UnsupportedHostVersionError";
  }
}

export interface DesktopPairedAdapterOptions {
  readonly session: AuthSession;
  readonly protocolFamily: string;
  readonly harnessVersion: string;
  readonly desktopVersion: string;
  /** Cadence of the session-discovery loop that drives observation. */
  readonly discoveryIntervalMs?: number;
}

/**
 * HostAdapter over the installed Desktop Host's browser-session API.
 *
 * One instance is bound to one authenticated connection generation. Every
 * unary call is a `POST /api/<namespace>/<method>` on that generation, and live
 * observation is one `session/follow` logical stream per session multiplexed
 * into the single physical socket the generation owns.
 */
export class DesktopPairedAdapter implements HostAdapter, DshApi {
  readonly protocolFamily: string;
  readonly authMode = "browser-session" as const;
  private readonly capabilitiesValue: HostCapabilities;
  private readonly discoveryIntervalMs: number;
  private closed = false;
  /** requestId used for the most recent dispatch per session, for honest recovery. */
  private readonly lastPromptRequestIds = new Map<string, string>();
  private readonly subscriptions = new Map<string, AbortController>();

  constructor(private readonly options: DesktopPairedAdapterOptions) {
    this.protocolFamily = options.protocolFamily;
    const table = SUPPORTED_PROTOCOL_FAMILIES[options.protocolFamily];
    if (table === undefined) throw new UnsupportedHostVersionError(options.protocolFamily, options.harnessVersion);
    this.capabilitiesValue = {
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
      ...table,
    };
    this.discoveryIntervalMs = options.discoveryIntervalMs ?? DISCOVERY_INTERVAL_MS;
  }

  capabilities(): HostCapabilities {
    return this.capabilitiesValue;
  }

  /** Sanitized endpoint facts for status output: the origin only, never the token. */
  endpointSnapshot(): {
    mode: "desktop-paired";
    resolvedBaseUrl: string;
    source: "paired-connection-file";
    resolutionEpoch: number;
  } {
    return {
      mode: "desktop-paired",
      resolvedBaseUrl: this.options.session.origin,
      source: "paired-connection-file",
      resolutionEpoch: 1,
    };
  }

  requireCapability(capability: CapabilityName, action: string): void {
    assertCapability(this.capabilitiesValue, this.protocolFamily, capability, action);
  }

  /** The requestId the last dispatch to this session used, when one was sent. */
  lastPromptRequestId(sessionId: string): string | undefined {
    return this.lastPromptRequestIds.get(sessionId);
  }

  private async callRaw(endpoint: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (this.closed) throw new Error("desktop-paired: adapter is disconnected");
    return await this.options.session.call(endpoint, args, signal);
  }

  private async call<T extends object>(
    endpoint: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<DshUnaryResult<T>> {
    const value = (await this.callRaw(endpoint, args, signal)) as T;
    return attachDshUnaryMetadata(value, { issuedRpcId: endpoint, method: endpoint });
  }

  async hostDescribe(signal?: AbortSignal): Promise<DshUnaryResult<DshHostDescription>> {
    const list = await this.sessionList(signal);
    const description: DshHostDescription = {
      version: this.options.desktopVersion,
      // The Host never exposes its own working directory over this API, and the
      // bridge install directory is not a project directory, so it stays empty.
      cwd: "",
      attachedSessions: list.items.length,
      canOpenPath: false,
    };
    return attachDshUnaryMetadata(description, { issuedRpcId: ENDPOINTS.sessionList, method: ENDPOINTS.sessionList });
  }

  async sessionList(signal?: AbortSignal): Promise<DshUnaryResult<{ items: DshSessionSummary[] }>> {
    this.requireCapability("readSessions", "listing sessions");
    const value = await this.call<{ items: DshSessionSummary[] }>(ENDPOINTS.sessionList, { _request: {} }, signal);
    return value;
  }

  async sessionCreate(
    payload: { cwd: string; agentPreset?: string; sessionId?: string },
    signal?: AbortSignal,
  ): Promise<DshUnaryResult<{ sessionId: string; agentPreset?: string }>> {
    this.requireCapability("createSession", "creating a session");
    const { workspace } = workspaceCreateResultSchema.parse(
      await this.callRaw(ENDPOINTS.workspaceCreate, { request: { path: payload.cwd } }, signal),
    );
    const canonical = async (path: string) => {
      const value = await realpath(path).catch(() => resolve(path));
      return process.platform === "win32" ? value.toLowerCase() : value;
    };
    if (await canonical(workspace.path) !== await canonical(payload.cwd)) {
      throw new Error("workspace/create returned a different directory; refusing to create or prompt a session against the wrong workspace");
    }
    const result = await this.call<{ sessionId: string }>(ENDPOINTS.sessionCreate, {
      request: {
        workspaceId: workspace.workspaceId,
        ...(payload.sessionId === undefined ? {} : { sessionId: payload.sessionId }),
        ...(payload.agentPreset === undefined ? {} : { agentPreset: payload.agentPreset }),
      },
    }, signal);
    const parsed = sessionCreateResultSchema.parse(result);
    return attachDshUnaryMetadata(
      { sessionId: parsed.sessionId, ...(parsed.agentPreset === undefined ? {} : { agentPreset: parsed.agentPreset }) },
      { issuedRpcId: ENDPOINTS.sessionCreate, method: ENDPOINTS.sessionCreate },
    );
  }

  async sessionModels(sessionId: string, signal?: AbortSignal): Promise<DshUnaryResult<DshSessionModels>> {
    this.requireCapability("readModelSelection", "reading the model selection");
    const catalog = (await this.call<{
      default?: { provider: string; model: string; reasoningEffort?: string };
      routableProviders?: string[];
      groups?: Array<{ id: string; name: string; models: Array<{ id: string; name: string; description?: string }> }>;
    }>(ENDPOINTS.sessionModelCatalog, {}, signal)) as {
      default?: { provider: string; model: string; reasoningEffort?: string };
      routableProviders?: string[];
      groups?: Array<{ id: string; name: string; models: Array<{ id: string; name: string; description?: string }> }>;
    };
    const current = catalog.default ?? { provider: "unknown", model: "unknown" };
    const models: DshSessionModels = {
      current,
      routable: (catalog.routableProviders?.length ?? 0) > 0,
      groups: (catalog.groups ?? []).map((group) => ({
        id: group.id,
        name: group.name,
        models: group.models.map((model) => ({ id: model.id, name: model.name, ...(model.description === undefined ? {} : { description: model.description }) })),
      })),
      failures: [],
    };
    void sessionId;
    return attachDshUnaryMetadata(models, {
      issuedRpcId: ENDPOINTS.sessionModelCatalog,
      method: ENDPOINTS.sessionModelCatalog,
    });
  }

  async sessionSelectModel(
    payload: { sessionId: string; provider: string; model: string; reasoningEffort?: string },
    _signal?: AbortSignal,
  ): Promise<DshUnaryResult<{ selected: { provider: string; model: string; reasoningEffort?: string } }>> {
    void payload;
    // The private build never changes the user's model, effort, or preset: the
    // setting belongs in the Desktop UI, and a refusal is the honest answer.
    this.requireCapability("selectModel", "selecting a model over the bridge");
    throw new Error("unreachable");
  }

  async sessionPrompt(
    payload: {
      sessionId: string;
      mode: "queue" | "steer";
      content: Array<{ type: "text"; text: string }>;
      clientTimeZone?: string;
      requestId?: string;
    },
    signal?: AbortSignal,
  ): Promise<DshUnaryResult<{ accepted: true }>> {
    this.requireCapability("prompt", "sending a prompt");
    const requestId = payload.requestId ?? randomUUID();
    this.lastPromptRequestIds.set(payload.sessionId, requestId);
    const result = await this.call<{ accepted: true }>(ENDPOINTS.sessionPrompt, {
      request: {
        requestId,
        sessionId: payload.sessionId,
        mode: payload.mode,
        content: payload.content,
        ...(payload.clientTimeZone === undefined ? {} : { clientTimeZone: payload.clientTimeZone }),
      },
    }, signal);
    return attachDshUnaryMetadata(result, { issuedRpcId: requestId, method: ENDPOINTS.sessionPrompt });
  }

  async sessionRename(
    sessionId: string,
    title: string,
    signal?: AbortSignal,
  ): Promise<DshUnaryResult<{ title: string; seq: number }>> {
    const result = await this.call<{ title: string; seq: number }>(ENDPOINTS.sessionRename, {
      request: { sessionId, title },
    }, signal);
    return result;
  }

  async sessionHistory(
    sessionId: string,
    options: { beforeSeq?: number; maxMessages?: number } = {},
    signal?: AbortSignal,
  ): Promise<DshUnaryResult<DshSessionHistory>> {
    this.requireCapability("historyRecovery", "reading session history");
    const projections = await this.callRaw(ENDPOINTS.sessionProjections, {
      request: { sessionId },
    }, signal);
    const parsedProjections = sessionProjectionsResultSchema.nullable().safeParse(projections);
    const throughSeq = parsedProjections.success && parsedProjections.data !== null ? parsedProjections.data.asOfSeq : 0;
    if (throughSeq === 0) {
      return attachDshUnaryMetadata({ events: [], hasMore: false }, {
        issuedRpcId: ENDPOINTS.sessionPage,
        method: ENDPOINTS.sessionPage,
      });
    }
    const page = await this.call<{ records: Array<{ event: SessionEvent }>; hasMore: boolean }>(
      ENDPOINTS.sessionPage,
      {
        request: {
          address: { kind: "session", sessionId },
          throughSeq,
          ...(options.beforeSeq === undefined ? {} : { beforeSeq: options.beforeSeq }),
          ...(options.maxMessages === undefined ? {} : { maxMessages: options.maxMessages }),
        },
      },
      signal,
    );
    const parsed = sessionPageResultSchema.parse(page);
    const history: DshSessionHistory = {
      events: parsed.records.map((record) => ({ event: record.event })),
      hasMore: parsed.hasMore,
    };
    return attachDshUnaryMetadata(history, { issuedRpcId: ENDPOINTS.sessionPage, method: ENDPOINTS.sessionPage });
  }

  async sessionCancel(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<DshUnaryResult<{ accepted: true }>> {
    this.requireCapability("cancelTurn", "cancelling a turn");
    const result = await this.call<{ accepted: true }>(ENDPOINTS.sessionCancel, { request: { sessionId } }, signal);
    return attachDshUnaryMetadata(result, { issuedRpcId: ENDPOINTS.sessionCancel, method: ENDPOINTS.sessionCancel });
  }

  async sessionWorkspaceState(sessionId: string, signal?: AbortSignal): Promise<DshWorkspaceState> {
    // On demand, never on each ordinary event. No output/log bodies are fetched.
    const deadline = AbortSignal.timeout(10_000);
    const bounded = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const queue = workspaceInboxSchema.safeParse(await this.callRaw(
      ENDPOINTS.sessionProjections, { request: { sessionId } }, bounded,
    ));
    let jobs: DshWorkspaceState["jobs"] = { known: false, active: 0 };
    for await (const frame of this.options.session.openStream(ENDPOINTS.jobList, { request: { sessionId } }, bounded)) {
      if (frame.type !== "item") break;
      const parsed = workspaceJobsSchema.safeParse(frame.value);
      if (parsed.success) jobs = {
        known: true,
        active: parsed.data.jobs.filter(job => job.status === "running" || job.status === "stopping").length,
      };
      break; // closes the read-only stream in AuthSession's finally block
    }
    bounded.throwIfAborted();
    return {
      queue: queue.success ? {
        known: true, asOfSeq: queue.data.asOfSeq,
        pending: queue.data.values.inbox["next-turn"].length + queue.data.values.inbox["next-step"].length,
      } : { known: false, pending: 0 },
      jobs,
    };
  }

  async sessionUpdateQueue(
    sessionId: string,
    itemId: string,
    action: { kind: "remove" },
    signal?: AbortSignal,
  ): Promise<DshUnaryResult<{ accepted: true }>> {
    this.requireCapability("cancelTurn", "removing a queued prompt");
    const result = await this.call<{ accepted: true }>(ENDPOINTS.sessionUpdateQueue, {
      request: { sessionId, itemId, action },
    }, signal);
    return attachDshUnaryMetadata(result, {
      issuedRpcId: ENDPOINTS.sessionUpdateQueue,
      method: ENDPOINTS.sessionUpdateQueue,
    });
  }

  async subagentList(parentSessionId: string, signal?: AbortSignal): Promise<DshUnaryResult<DshSubagentListValue>> {
    const list = await this.sessionList(signal);
    const entries = list.items
      .filter((item) => item.parentSessionId === parentSessionId && item.origin === "subagent")
      .map((item) => ({
        kind: "child" as const,
        id: item.sessionId,
        mode: "one-shot" as const,
        activity: item.running ? ("running" as const) : ("inactive" as const),
        hasChildren: list.items.some((candidate) => candidate.parentSessionId === item.sessionId),
      }));
    const value: DshSubagentListValue = { entries, parentAvailable: true };
    return attachDshUnaryMetadata(value, { issuedRpcId: ENDPOINTS.sessionList, method: ENDPOINTS.sessionList });
  }

  async subagentHistory(
    address: DshSubagentAddress,
    options: { beforeSeq?: number; maxMessages?: number } = {},
    signal?: AbortSignal,
  ): Promise<DshUnaryResult<DshSessionHistory>> {
    // A subagent session is addressable as an ordinary session on this protocol.
    return this.sessionHistory(address.childSessionId, options, signal);
  }

  respond(): never {
    // interactions=none: the Host holds no interaction for this Peer to answer.
    this.requireCapability("approvalRelay", "answering a Host interaction");
    throw new Error("unreachable");
  }

  /**
   * Observe every non-blank session by following each one.
   *
   * The installed protocol has no single "all sessions" event stream that a
   * non-browser Peer may open, so observation is one logical stream per session,
   * multiplexed onto this generation's single physical socket. A stream that
   * ends only removes its own subscription; the mux keeps running.
   *
   * @param signal - mux lifetime.
   * @param onOpen - called once, when the first session subscription is live.
   * @returns the normalized frame stream the bridge already knows.
   */
  openMux(signal: AbortSignal, onOpen?: () => void): AsyncIterable<DshServerRequest<DshMuxFrame>> {
    return this.mux(signal, onOpen);
  }

  private async *mux(
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncIterable<DshServerRequest<DshMuxFrame>> {
    this.requireCapability("follow", "following sessions");
    const queue: DshServerRequest<DshMuxFrame>[] = [];
    let wake: (() => void) | undefined;
    let announced = false;
    const push = (frame: DshMuxFrame) => {
      queue.push({ type: "server-request", rpcId: randomUUID(), method: frame.type, payload: frame });
      wake?.();
      wake = undefined;
      if (!announced) {
        announced = true;
        onOpen?.();
      }
    };
    const pump = (sessionId: string) => {
      if (this.subscriptions.has(sessionId) || this.subscriptions.size >= MAX_FOLLOWED_SESSIONS) return;
      const controller = new AbortController();
      this.subscriptions.set(sessionId, controller);
      void (async () => {
        try {
          for await (const frame of this.options.session.openStream(
            ENDPOINTS.sessionFollow,
            { request: { address: { kind: "session", sessionId }, assistantStream: true } },
            AbortSignal.any([controller.signal, signal]),
          )) {
            if (frame.type !== "item") continue;
            const parsed = sessionFollowFrameSchema.safeParse(frame.value);
            if (!parsed.success) continue;
            if (parsed.data.type === "snapshot") {
              push({ type: "session/subscribed", sessionId, lastSeq: parsed.data.cursor });
              for (const record of parsed.data.records) pushEvent(push, sessionId, record.event);
            } else if (parsed.data.type === "event") {
              pushEvent(push, sessionId, parsed.data.event);
            }
          }
        } catch {
          // A per-session stream failure is not a mux failure.
        } finally {
          this.subscriptions.delete(sessionId);
        }
      })();
    };

    try {
      while (!signal.aborted) {
        try {
          const list = await this.sessionList(signal);
          const candidates = list.items
            .filter((item) => item.blank !== true && item.origin !== "subagent")
            .sort((left, right) => right.updatedAt - left.updatedAt);
          for (const item of candidates) pump(item.sessionId);
        } catch {
          // Keep the mux alive; the bridge reports availability separately.
        }
        const deadline = Date.now() + this.discoveryIntervalMs;
        while (!signal.aborted) {
          if (queue.length > 0) break;
          const remaining = deadline - Date.now();
          if (remaining <= 0) break;
          await new Promise<void>((resolve) => {
            wake = resolve;
            setTimeout(resolve, Math.min(remaining, 250));
          });
        }
        while (queue.length > 0) {
          const frame = queue.shift();
          if (frame !== undefined) yield frame;
        }
      }
    } finally {
      for (const controller of this.subscriptions.values()) controller.abort();
      this.subscriptions.clear();
    }
  }

  async disconnect(): Promise<void> {
    this.closed = true;
    for (const controller of this.subscriptions.values()) controller.abort();
    this.subscriptions.clear();
    this.options.session.dispose();
  }
}

/** Map one session event onto the bridge's frame set. */
function pushEvent(
  push: (frame: DshMuxFrame) => void,
  sessionId: string,
  event: SessionEvent,
): void {
  push({ type: "session/event", sessionId, event });
  if (event.type === "approval/asked") {
    const data = event.data as { id?: unknown; toolName?: unknown; callId?: unknown; reason?: unknown } | null;
    const approvalId = typeof data?.id === "string" ? data.id : undefined;
    if (approvalId !== undefined) {
      push({
        type: "approval/requested",
        sessionId,
        approvalId,
        toolName: typeof data?.toolName === "string" ? data.toolName : "unknown",
        ...(typeof data?.callId === "string" ? { callId: data.callId } : {}),
        ...(typeof data?.reason === "string" ? { reason: data.reason } : {}),
      });
    }
  }
}
