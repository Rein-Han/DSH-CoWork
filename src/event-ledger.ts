import { appendFile, chmod, mkdir, open, stat } from "node:fs/promises";
import { join } from "node:path";

import { withFileLock } from "./file-lock.js";

export type LedgerOrigin = "root" | "subagent";

export type LedgerExecution =
  | "starting"
  | "running"
  | "awaiting_approval"
  | "awaiting_input"
  | "turn_completed"
  | "failed"
  | "canceled"
  | "interrupted";

export interface LedgerRecord {
  cursor: number;
  mergeIndex: number;
  observedAt: string;
  sourceSessionId: string;
  sourceSeq?: number;
  parentSessionId?: string;
  origin: LedgerOrigin;
  type: string;
  metadata?: Record<string, unknown>;
  snapshotProjection?: SnapshotProjection;
  coordination: unknown;
}

export interface LedgerAppendInput {
  sourceSessionId?: string;
  sourceSeq?: number;
  parentSessionId?: string;
  origin?: LedgerOrigin;
  type?: string;
  raw: unknown;
}

export interface CurrentTurnSnapshot {
  sessionId: string;
  turn?: number;
  startCursor: number;
  startedAt: string;
  lastAssistantMessagePointer?: LedgerEventPointer;
}

/** Non-sensitive coordination marker for a used ModLens Flash visual fallback. */
export interface VisualFallbackCoordination {
  profile: string;
  approvedRoute?: string;
  approvedRouteAttempts?: number;
  lastFailureClass?: string;
  notice?: string;
}

export interface LedgerSnapshot {
  cursor: number;
  earliestCursor: number;
  watermarks: Record<string, number>;
  execution: LedgerExecution;
  lastKnownExecutionStatus: LedgerExecution;
  finalMessagePointer?: LedgerEventPointer;
  terminalMissingFinal: boolean;
  pendingInteractions: LedgerPendingInteraction[];
  currentTurn?: CurrentTurnSnapshot;
  visualFallback?: VisualFallbackCoordination;
  unrecoverableGap?: unknown;
  logPath: string;
}

export interface LedgerEventPointer {
  sessionId: string;
  seq: number;
}

export interface LedgerPendingInteraction {
  key: string;
  requestId?: string;
  approvalId?: string;
  sessionId: string;
  type: "approval/requested" | "question/requested";
}

export interface TailDigestRecord {
  cursor: number;
  observedAt: string;
  sourceSessionId: string;
  sourceSeq?: number;
  parentSessionId?: string;
  origin: LedgerOrigin;
  type: string;
  digest: unknown;
  protected: boolean;
  exceededMaxBytes?: boolean;
}

export interface TailResult {
  records: TailDigestRecord[];
  nextCursor: number;
  earliestCursor: number;
  hasMore: boolean;
}

export class EventLedgerError extends Error {
  constructor(
    readonly code: "cursor_expired" | "invalid_cursor" | "unrecoverable_gap" | "invalid_record",
    message: string,
    readonly details: Record<string, unknown> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "EventLedgerError";
  }
}

interface PendingInteraction {
  previousExecution: LedgerExecution;
  value: LedgerPendingInteraction;
}

interface FoldState {
  snapshot: LedgerSnapshot;
  pending: Map<string, PendingInteraction>;
  executionBeforePending?: LedgerExecution;
  turnHadAssistant: boolean;
}

interface SnapshotProjection {
  kind: "queue" | "jobs";
  items: ReadonlyArray<Record<string, string>>;
}

interface TaskState {
  loaded: boolean;
  loading?: Promise<void>;
  records: LedgerRecord[];
  seenKeys: Set<string>;
  latestSnapshotProjections: Map<string, string>;
  bridgeIssuedRpcIds: Set<string>;
  fold: FoldState;
  disk?: { size: number; ino: number; dev: number; mtimeMs: number; ctimeMs: number; tail: Buffer };
  target?: { anchor: number; processed: number; starts: number[]; receipts: Array<string | undefined>; sources: Set<string>; steering: Set<string> };
}

interface Waiter {
  afterCursor: number;
  resolve: () => void;
  timer: ReturnType<typeof setTimeout>;
  reject: (error: unknown) => void;
}

const TASK_ID_PATTERN = /^dsh_[a-f0-9]{12}$/;

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function stringField(value: unknown, key: string): string | undefined {
  const field = asObject(value)?.[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

function numberField(value: unknown, key: string): number | undefined {
  const field = asObject(value)?.[key];
  return Number.isInteger(field) ? (field as number) : undefined;
}

function payloadOf(raw: unknown): unknown {
  return asObject(raw)?.payload ?? raw;
}

function eventOf(raw: unknown): unknown {
  const payload = payloadOf(raw);
  return asObject(payload)?.event ?? payload;
}

function rawType(raw: unknown): string | undefined {
  return stringField(payloadOf(raw), "type") ?? stringField(eventOf(raw), "type") ?? stringField(raw, "type");
}

function rawSessionId(raw: unknown): string | undefined {
  return stringField(payloadOf(raw), "sessionId") ?? stringField(raw, "sessionId");
}

function rawParentSessionId(raw: unknown): string | undefined {
  return stringField(payloadOf(raw), "parentSessionId") ?? stringField(raw, "parentSessionId");
}

function rawSourceSeq(raw: unknown): number | undefined {
  return numberField(asObject(payloadOf(raw))?.event, "seq") ?? numberField(payloadOf(raw), "seq") ?? numberField(raw, "seq");
}

function rawRpcId(raw: unknown): string | undefined {
  return stringField(raw, "rpcId");
}

function rawIssuedRpcId(raw: unknown): string | undefined {
  return stringField(raw, "issuedRpcId") ?? stringField(payloadOf(raw), "issuedRpcId");
}

function userMessageSourceRpcId(raw: unknown): string | undefined {
  const event = eventOf(raw);
  if (stringField(event, "type") !== "user/message") return undefined;
  return stringField(asObject(asObject(event)?.data)?.source, "rpcId");
}

function contentText(value: unknown): string | undefined {
  const content = asObject(value)?.content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter((block): block is Record<string, unknown> => asObject(block) !== undefined)
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("");
  return text === "" ? undefined : text;
}

function messageText(event: unknown): string | undefined {
  const eventObject = asObject(event);
  if (eventObject === undefined) return undefined;
  if (eventObject.type === "user/message") return contentText(eventObject.data);
  if (eventObject.type === "assistant/message") return contentText(asObject(eventObject.data)?.message);
  return undefined;
}

function turnEndKind(event: unknown): string | undefined {
  const eventObject = asObject(event);
  const reason = asObject(asObject(eventObject?.data)?.reason);
  const kind = reason?.kind;
  return typeof kind === "string" ? kind : undefined;
}

function safeReason(value: unknown): Record<string, unknown> | undefined {
  const reason = asObject(value);
  const kind = typeof reason?.kind === "string" ? reason.kind : undefined;
  if (kind === undefined) return undefined;
  const nested = reason === undefined ? undefined : asObject(reason.reason);
  const nestedKind = typeof nested?.kind === "string" ? nested.kind : undefined;
  return { kind, ...(nestedKind === undefined ? {} : { reason: { kind: nestedKind } }) };
}

function safeTurnData(event: unknown): Record<string, unknown> | undefined {
  const data = asObject(asObject(event)?.data);
  const turn = numberField(data, "turn");
  const reason = safeReason(data?.reason);
  if (turn === undefined && reason === undefined) return undefined;
  return { ...(turn === undefined ? {} : { turn }), ...(reason === undefined ? {} : { reason }) };
}

function safePayloadFields(raw: unknown): Record<string, unknown> {
  const payload = payloadOf(raw);
  const rawObject = asObject(raw);
  const payloadObject = asObject(payload);
  const rpcId = rawRpcId(raw);
  const requestId = stringField(raw, "requestId");
  const approvalId = stringField(payload, "approvalId") ?? stringField(raw, "approvalId");
  const questionRpcId = stringField(payload, "questionRpcId") ?? stringField(raw, "questionRpcId");
  const issuedRpcId = rawIssuedRpcId(raw);
  const outcome = stringField(payload, "outcome") ?? stringField(raw, "outcome");
  const mode = stringField(payload, "mode") ?? stringField(raw, "mode");
  const interaction = stringField(raw, "interaction");
  const reasonCode = stringField(raw, "reason");
  const connectionEpoch = numberField(raw, "connectionEpoch");
  const sessionId = stringField(payload, "sessionId") ?? stringField(raw, "sessionId");
  const sourceSessionId = stringField(raw, "sourceSessionId");
  const expectedSeq = numberField(raw, "expectedSeq");
  const firstRecoveredSeq = numberField(raw, "firstRecoveredSeq");
  const turnStartCursor = numberField(raw, "turnStartCursor");
  const code = stringField(asObject(payloadObject?.error), "code") ?? stringField(asObject(rawObject?.error), "code");
  return {
    ...(rpcId === undefined ? {} : { rpcId }),
    ...(requestId === undefined ? {} : { requestId }),
    ...(approvalId === undefined ? {} : { approvalId }),
    ...(questionRpcId === undefined ? {} : { questionRpcId }),
    ...(issuedRpcId === undefined ? {} : { issuedRpcId }),
    ...(outcome === undefined ? {} : { outcome }),
    ...(mode === undefined ? {} : { mode }),
    ...(interaction === undefined ? {} : { interaction }),
    ...(reasonCode === undefined ? {} : { reason: reasonCode }),
    ...(connectionEpoch === undefined ? {} : { connectionEpoch }),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(sourceSessionId === undefined ? {} : { sourceSessionId }),
    ...(expectedSeq === undefined ? {} : { expectedSeq }),
    ...(firstRecoveredSeq === undefined ? {} : { firstRecoveredSeq }),
    ...(turnStartCursor === undefined ? {} : { turnStartCursor }),
    ...(code === undefined ? {} : { error: { code } }),
  };
}

function snapshotProjectionKey(recordType: string, sourceSessionId: string): string | undefined {
  if (recordType === "session/queue" || recordType === "session/jobs") return `${recordType}:${sourceSessionId}`;
  return undefined;
}

function snapshotProjection(input: LedgerAppendInput, recordType: string): SnapshotProjection | undefined {
  const payload = payloadOf(input.raw);
  const payloadObject = asObject(payload);
  if (payloadObject === undefined) return undefined;

  if (recordType === "session/queue") {
    const items = payloadObject.items;
    if (!Array.isArray(items)) return undefined;
    const projected = items.map((item): Record<string, string> | undefined => {
      const id = stringField(item, "id");
      const placement = stringField(item, "placement");
      return id === undefined || placement === undefined ? undefined : { id, placement };
    });
    if (projected.some((item) => item === undefined)) return undefined;
    return { kind: "queue", items: projected as Record<string, string>[] };
  }

  if (recordType === "session/jobs") {
    const jobs = payloadObject.jobs;
    if (!Array.isArray(jobs)) return undefined;
    const projected = jobs.map((job): Record<string, string> | undefined => {
      const id = stringField(job, "id");
      if (id === undefined) return undefined;
      const kind = stringField(job, "kind");
      const status = stringField(job, "status");
      const startedAt = stringField(job, "startedAt");
      const finishedAt = stringField(job, "finishedAt");
      return {
        id,
        ...(kind === undefined ? {} : { kind }),
        ...(status === undefined ? {} : { status }),
        ...(startedAt === undefined ? {} : { startedAt }),
        ...(finishedAt === undefined ? {} : { finishedAt }),
      };
    });
    if (projected.some((job) => job === undefined)) return undefined;
    return { kind: "jobs", items: (projected as Record<string, string>[]).sort((left, right) => String(left.id).localeCompare(String(right.id))) };
  }

  return undefined;
}

function projectionSignature(projection: SnapshotProjection): string {
  return JSON.stringify(projection);
}

function parseSnapshotProjection(value: unknown): SnapshotProjection | undefined {
  const object = asObject(value);
  if (object === undefined || (object.kind !== "queue" && object.kind !== "jobs") || !Array.isArray(object.items)) return undefined;
  const items = object.items.map((item): Record<string, string> | undefined => {
    const itemObject = asObject(item);
    if (itemObject === undefined) return undefined;
    const projected: Record<string, string> = {};
    for (const [key, field] of Object.entries(itemObject)) {
      if (typeof field !== "string") return undefined;
      projected[key] = field;
    }
    return projected;
  });
  if (items.some((item) => item === undefined)) return undefined;
  return { kind: object.kind, items: items as Record<string, string>[] };
}

function recordMetadata(recordType: string, input: LedgerAppendInput, state: TaskState): Record<string, unknown> | undefined {
  const issuedRpcId = rawIssuedRpcId(input.raw);
  if (recordType === "bridge/prompt-issued" && issuedRpcId !== undefined) return { issuedRpcId };

  const event = eventOf(input.raw);
  if (recordType === "session/event" && stringField(event, "type") === "user/message") {
    const sourceRpcId = userMessageSourceRpcId(input.raw);
    return {
      initiatedBy: sourceRpcId !== undefined && state.bridgeIssuedRpcIds.has(sourceRpcId) ? "bridge" : "external_or_unknown",
      ...(sourceRpcId === undefined ? {} : { sourceRpcId }),
    };
  }

  return undefined;
}

function sanitizedRaw(input: LedgerAppendInput, recordType: string, sourceSessionId: string, sourceSeq?: number): unknown {
  if (recordType === "bridge/visual-fallback") {
    const rawObject = asObject(input.raw);
    const profile = stringField(rawObject, "profile");
    const approvedRoute = stringField(rawObject, "approvedRoute");
    const approvedRouteAttempts = numberField(rawObject, "approvedRouteAttempts");
    const lastFailureClass = stringField(rawObject, "lastFailureClass");
    const notice = stringField(rawObject, "notice");
    return {
      type: recordType,
      sessionId: sourceSessionId,
      ...(profile === undefined ? {} : { profile }),
      ...(approvedRoute === undefined ? {} : { approvedRoute }),
      ...(approvedRouteAttempts === undefined ? {} : { approvedRouteAttempts }),
      ...(lastFailureClass === undefined ? {} : { lastFailureClass }),
      ...(notice === undefined ? {} : { notice }),
    };
  }
  if (recordType === "session/event") {
    const event = eventOf(input.raw);
    const eventType = stringField(event, "type") ?? recordType;
    const seq = sourceSeq ?? numberField(event, "seq");
    const time = numberField(event, "time");
    const data = safeTurnData(event);
    const parentSessionId = input.parentSessionId ?? rawParentSessionId(input.raw);
    return {
      type: "session/event",
      sessionId: sourceSessionId,
      ...(parentSessionId === undefined ? {} : { parentSessionId }),
      event: {
        type: eventType,
        ...(seq === undefined ? {} : { seq }),
        ...(time === undefined ? {} : { time }),
        ...(data === undefined ? {} : { data }),
      },
    };
  }

  return {
    type: recordType,
    ...safePayloadFields(input.raw),
    sessionId: sourceSessionId,
  };
}

function stableKey(input: LedgerAppendInput, recordType: string, sourceSessionId: string): string | undefined {
  const sourceSeq = input.sourceSeq ?? rawSourceSeq(input.raw);
  if (recordType === "session/event" && sourceSeq !== undefined) return `session-event:${sourceSessionId}:${sourceSeq}`;

  if (recordType === "session/queue") {
    const rpcId = rawRpcId(input.raw);
    if (rpcId !== undefined) return `snapshot-rpc:${recordType}:${sourceSessionId}:${rpcId}`;
  }

  const payload = payloadOf(input.raw);
  if (recordType === "question/resolved") {
    const questionRpcId = stringField(payload, "questionRpcId");
    if (questionRpcId !== undefined) return `question:${recordType}:${sourceSessionId}:${questionRpcId}`;
  }

  if (recordType === "approval/resolved" || recordType === "approval/requested") {
    const approvalId = stringField(payload, "approvalId");
    if (approvalId !== undefined) return `approval:${recordType}:${sourceSessionId}:${approvalId}`;
  }

  const rpcId = rawRpcId(input.raw);
  if (rpcId !== undefined && (recordType.endsWith("/requested") || recordType.endsWith("/resolved"))) {
    return `rpc:${recordType}:${sourceSessionId}:${rpcId}`;
  }
  if (recordType === "respond/accepted" || recordType === "respond/not-pending") {
    const requestId = stringField(input.raw, "requestId");
    if (requestId !== undefined) return `respond:${recordType}:${sourceSessionId}:${requestId}`;
  }
  if (recordType === "bridge/prompt-issued") {
    const issuedRpcId = rawIssuedRpcId(input.raw);
    if (issuedRpcId !== undefined) return `bridge-prompt:${sourceSessionId}:${issuedRpcId}`;
  }
  if (recordType === "bridge/turn-interrupted") {
    const turnStartCursor = numberField(input.raw, "turnStartCursor");
    if (turnStartCursor !== undefined) return `bridge-turn-interrupted:${sourceSessionId}:${turnStartCursor}`;
  }

  return undefined;
}

function pendingKey(record: LedgerRecord): string | undefined {
  const payload = payloadOf(record.coordination);
  if (record.type.startsWith("approval/")) {
    const approvalId = stringField(payload, "approvalId");
    return approvalId === undefined ? undefined : `approval:${record.sourceSessionId}:${approvalId}`;
  }
  if (record.type === "question/resolved") {
    const questionRpcId = stringField(payload, "questionRpcId");
    return questionRpcId === undefined ? undefined : `rpc:${record.sourceSessionId}:${questionRpcId}`;
  }
  const rpcId = rawRpcId(record.coordination);
  if (rpcId !== undefined) return `rpc:${record.sourceSessionId}:${rpcId}`;
  if (
    record.type === "respond/accepted" ||
    record.type === "respond/not-pending" ||
    record.type === "interaction/withdrawn" ||
    record.type === "interaction/replayed"
  ) {
    const approvalId = stringField(record.coordination, "approvalId");
    if (approvalId !== undefined) return `approval:${record.sourceSessionId}:${approvalId}`;
    const requestId = stringField(record.coordination, "requestId");
    return requestId === undefined ? undefined : `rpc:${record.sourceSessionId}:${requestId}`;
  }
  return undefined;
}

function emptyFold(logPath: string): FoldState {
  return {
    snapshot: {
      cursor: 0,
      earliestCursor: 0,
      watermarks: {},
      execution: "starting",
      lastKnownExecutionStatus: "starting",
      terminalMissingFinal: false,
      pendingInteractions: [],
      logPath,
    },
    pending: new Map(),
    turnHadAssistant: false,
  };
}

function assignSnapshot(fold: FoldState, patch: Partial<Omit<LedgerSnapshot, "logPath">>): void {
  fold.snapshot = { ...fold.snapshot, ...patch };
}

function setExecution(fold: FoldState, execution: LedgerExecution): void {
  assignSnapshot(fold, { execution, lastKnownExecutionStatus: execution });
}

function foldRecord(fold: FoldState, record: LedgerRecord): void {
  const firstCursor = fold.snapshot.earliestCursor === 0 ? record.cursor : fold.snapshot.earliestCursor;
  const watermarks = { ...fold.snapshot.watermarks };
  if (record.sourceSeq !== undefined) watermarks[record.sourceSessionId] = Math.max(watermarks[record.sourceSessionId] ?? -1, record.sourceSeq);

  assignSnapshot(fold, {
    cursor: record.cursor,
    earliestCursor: firstCursor,
    watermarks,
  });

  if (record.type === "ledger/gap") {
    assignSnapshot(fold, { unrecoverableGap: record.coordination });
    return;
  }

  if (record.type === "bridge/turn-interrupted") {
    setExecution(fold, "interrupted");
    assignSnapshot(fold, { terminalMissingFinal: fold.snapshot.finalMessagePointer === undefined });
    return;
  }

  if (record.type === "bridge/visual-fallback") {
    const value = asObject(record.coordination);
    const profile = stringField(value, "profile");
    if (profile === "modlens-flash") {
      const approvedRoute = stringField(value, "approvedRoute");
      const approvedRouteAttempts = numberField(value, "approvedRouteAttempts");
      const lastFailureClass = stringField(value, "lastFailureClass");
      const notice = stringField(value, "notice");
      assignSnapshot(fold, {
        visualFallback: {
          profile,
          ...(approvedRoute === undefined ? {} : { approvedRoute }),
          ...(approvedRouteAttempts === undefined ? {} : { approvedRouteAttempts }),
          ...(lastFailureClass === undefined ? {} : { lastFailureClass }),
          ...(notice === undefined ? {} : { notice }),
        },
      });
    }
    return;
  }

  if (
    record.type === "approval/requested" ||
    record.type === "question/requested" ||
    record.type === "interaction/replayed"
  ) {
    const key = pendingKey(record);
    const replayedType = stringField(record.coordination, "interaction");
    const interactionType =
      record.type === "interaction/replayed" &&
      (replayedType === "approval/requested" || replayedType === "question/requested")
        ? replayedType
        : record.type;
    if (key !== undefined && !fold.pending.has(key)) {
      if (fold.pending.size === 0) fold.executionBeforePending = fold.snapshot.execution;
      const requestId = rawRpcId(record.coordination) ?? stringField(record.coordination, "requestId");
      const approvalId = stringField(payloadOf(record.coordination), "approvalId");
      fold.pending.set(key, {
        previousExecution: fold.snapshot.execution,
        value: {
          key,
          ...(requestId === undefined ? {} : { requestId }),
          ...(approvalId === undefined ? {} : { approvalId }),
          sessionId: record.sourceSessionId,
          type: interactionType as "approval/requested" | "question/requested",
        },
      });
    }
    assignSnapshot(fold, { pendingInteractions: [...fold.pending.values()].map((pending) => pending.value) });
    setExecution(fold, interactionType === "approval/requested" ? "awaiting_approval" : "awaiting_input");
    return;
  }

  if (
    record.type === "approval/resolved" ||
    record.type === "question/resolved" ||
    record.type === "respond/accepted" ||
    record.type === "respond/not-pending" ||
    record.type === "interaction/withdrawn"
  ) {
    const key = pendingKey(record);
    if (key === undefined || !fold.pending.has(key)) return;
    if (key !== undefined) fold.pending.delete(key);
    assignSnapshot(fold, { pendingInteractions: [...fold.pending.values()].map((pending) => pending.value) });
    if ([...fold.pending.keys()].some((candidate) => candidate.startsWith("approval:"))) {
      setExecution(fold, "awaiting_approval");
    } else if (fold.pending.size > 0) {
      setExecution(fold, "awaiting_input");
    } else {
      setExecution(fold, fold.executionBeforePending ?? "running");
      delete fold.executionBeforePending;
    }
    return;
  }

  const event = eventOf(record.coordination);
  const eventType = stringField(event, "type");
  if (record.type !== "session/event" && eventType === undefined) return;

  if (record.origin !== "root") return;

  if (eventType === "turn/start") {
    delete fold.snapshot.finalMessagePointer;
    fold.turnHadAssistant = false;
    setExecution(fold, "running");
    const turn = numberField(asObject(event)?.data, "turn");
    assignSnapshot(fold, {
      currentTurn: {
        sessionId: record.sourceSessionId,
        ...(turn === undefined ? {} : { turn }),
        startCursor: record.cursor,
        startedAt: record.observedAt,
      },
      terminalMissingFinal: false,
    });
    return;
  }

  if (eventType === "user/message") {
    return;
  }

  if (eventType === "assistant/message") {
    const seq = record.sourceSeq ?? numberField(event, "seq");
    fold.turnHadAssistant = true;
    if (seq !== undefined && fold.snapshot.currentTurn !== undefined) {
      assignSnapshot(fold, {
        currentTurn: {
          ...fold.snapshot.currentTurn,
          lastAssistantMessagePointer: { sessionId: record.sourceSessionId, seq },
        },
      });
    }
    return;
  }

  if (eventType !== "turn/end") return;

  const reason = turnEndKind(event);
  const abortCause = stringField(asObject(asObject(asObject(event)?.data)?.reason)?.reason, "kind");
  const execution =
    reason === "completed"
      ? "turn_completed"
      : reason === "aborted"
        ? abortCause === "user"
          ? "canceled"
          : "interrupted"
        : reason === "interrupted"
          ? "interrupted"
          : "failed";
  const finalMessagePointer = fold.snapshot.currentTurn?.lastAssistantMessagePointer;
  const missingFinal = !fold.turnHadAssistant;
  setExecution(fold, execution);
  fold.snapshot = {
    cursor: fold.snapshot.cursor,
    earliestCursor: fold.snapshot.earliestCursor,
    watermarks: fold.snapshot.watermarks,
    execution: fold.snapshot.execution,
    lastKnownExecutionStatus: fold.snapshot.lastKnownExecutionStatus,
    pendingInteractions: fold.snapshot.pendingInteractions,
    ...(finalMessagePointer === undefined ? {} : { finalMessagePointer }),
    terminalMissingFinal: missingFinal,
    ...(fold.snapshot.unrecoverableGap === undefined ? {} : { unrecoverableGap: fold.snapshot.unrecoverableGap }),
    logPath: fold.snapshot.logPath,
  };
}

function parseRecord(line: string, logPath: string): LedgerRecord {
  const value = JSON.parse(line) as unknown;
  const object = asObject(value);
  const cursor = object?.cursor;
  const parsedSnapshotProjection = parseSnapshotProjection(object?.snapshotProjection);
  if (
    object === undefined ||
    !Number.isInteger(cursor) ||
    (cursor as number) < 1 ||
    object.mergeIndex !== cursor ||
    typeof object.observedAt !== "string" ||
    typeof object.sourceSessionId !== "string" ||
    (object.sourceSeq !== undefined && !Number.isInteger(object.sourceSeq)) ||
    (object.parentSessionId !== undefined && typeof object.parentSessionId !== "string") ||
    (object.origin !== "root" && object.origin !== "subagent") ||
    typeof object.type !== "string" ||
    !("coordination" in object)
  ) {
    throw new EventLedgerError("invalid_record", `invalid event ledger record in ${logPath}`);
  }
  return {
    cursor: cursor as number,
    mergeIndex: object.mergeIndex as number,
    observedAt: object.observedAt as string,
    sourceSessionId: object.sourceSessionId as string,
    ...("sourceSeq" in object ? { sourceSeq: object.sourceSeq as number } : {}),
    ...("parentSessionId" in object ? { parentSessionId: object.parentSessionId as string } : {}),
    origin: object.origin as LedgerOrigin,
    type: object.type as string,
    ...(asObject(object.metadata) === undefined ? {} : { metadata: object.metadata as Record<string, unknown> }),
    ...(parsedSnapshotProjection === undefined ? {} : { snapshotProjection: parsedSnapshotProjection }),
    coordination: object.coordination,
  };
}

function requireTaskId(taskId: string): void {
  if (!TASK_ID_PATTERN.test(taskId)) throw new EventLedgerError("invalid_record", `invalid task id ${JSON.stringify(taskId)}`);
}

function protectedDigest(record: LedgerRecord, digest: unknown): TailDigestRecord {
  return {
    cursor: record.cursor,
    observedAt: record.observedAt,
    sourceSessionId: record.sourceSessionId,
    ...("sourceSeq" in record ? { sourceSeq: record.sourceSeq } : {}),
    ...("parentSessionId" in record ? { parentSessionId: record.parentSessionId } : {}),
    origin: record.origin,
    type: record.type,
    digest,
    protected: true,
  };
}

function normalDigest(record: LedgerRecord, digest: unknown): TailDigestRecord {
  return {
    cursor: record.cursor,
    observedAt: record.observedAt,
    sourceSessionId: record.sourceSessionId,
    ...("sourceSeq" in record ? { sourceSeq: record.sourceSeq } : {}),
    ...("parentSessionId" in record ? { parentSessionId: record.parentSessionId } : {}),
    origin: record.origin,
    type: record.type,
    digest,
    protected: false,
  };
}

function digestRecord(record: LedgerRecord): TailDigestRecord {
  if (record.type === "ledger/gap") return protectedDigest(record, { details: record.coordination });
  if (record.type === "approval/requested" || record.type === "approval/resolved") return protectedDigest(record, payloadOf(record.coordination));
  if (record.type === "question/requested" || record.type === "question/resolved") return protectedDigest(record, payloadOf(record.coordination));
  if (record.type === "stream/error") return protectedDigest(record, payloadOf(record.coordination));
  if (
    record.type === "respond/accepted" ||
    record.type === "respond/not-pending" ||
    record.type === "interaction/withdrawn" ||
    record.type === "interaction/replayed"
  ) {
    return protectedDigest(record, record.coordination);
  }
  if (record.type === "bridge/turn-interrupted") return protectedDigest(record, record.coordination);
  if (record.type === "bridge/visual-fallback") return protectedDigest(record, record.coordination);

  const event = eventOf(record.coordination);
  const eventObject = asObject(event);
  const eventType = stringField(event, "type");
  const base = {
    eventType,
    seq: numberField(event, "seq"),
    time: numberField(event, "time"),
    ...(record.metadata === undefined ? {} : { coordination: record.metadata }),
  };

  if (eventType === "assistant/message") {
    return protectedDigest(record, { ...base, finalPointer: record.sourceSeq === undefined ? undefined : { sessionId: record.sourceSessionId, seq: record.sourceSeq } });
  }
  if (eventType === "user/message") {
    return protectedDigest(record, base);
  }
  if (eventType === "assistant/message/delta" || eventType === "assistant/delta" || eventType === "assistant/chunk") {
    return normalDigest(record, { ...base, omitted: "assistant_chunk" });
  }
  if (eventType === "tool/result") {
    const data = asObject(eventObject?.data);
    const meta = asObject(data?.meta);
    return normalDigest(record, {
      ...base,
      error: data?.error,
      paths: data?.paths ?? meta?.paths,
      stats: data?.stats ?? meta?.stats,
    });
  }
  if (eventType === "tool/call") {
    const data = asObject(eventObject?.data);
    return normalDigest(record, {
      ...base,
      tool: data?.name,
      arguments: typeof data?.arguments === "string" ? (data.arguments as string).slice(0, 2_000) : data?.arguments,
    });
  }
  if (eventType === "turn/end") return protectedDigest(record, { ...base, reason: turnEndKind(event), data: eventObject?.data });
  if (eventType === "turn/start") return protectedDigest(record, { ...base, data: eventObject?.data });
  return normalDigest(record, base);
}

export class EventLedger {
  private readonly ledgersDir: string;
  private readonly states = new Map<string, TaskState>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly waiters = new Map<string, Set<Waiter>>();
  private readonly pollers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly metrics = { fullScans: 0, incrementalReads: 0, bytesRead: 0, recordsRead: 0, pollChecks: 0 };

  /** Non-content counters for acceptance tests and local diagnostics only. */
  observationDiagnostics() {
    return { ...this.metrics, waiters: [...this.waiters.values()].reduce((n, set) => n + set.size, 0), pollers: this.pollers.size };
  }

  constructor(homeDir: string) {
    this.ledgersDir = join(homeDir, "ledgers");
  }

  async append(taskId: string, input: LedgerAppendInput): Promise<LedgerRecord | undefined> {
    return this.serial(taskId, async () => {
      await this.ensureTaskDir(taskId);
      return withFileLock(this.lockPath(taskId), async () => {
        const state = await this.reloadUnlocked(taskId);
        const sourceSessionId = input.sourceSessionId ?? rawSessionId(input.raw);
        if (sourceSessionId === undefined) throw new EventLedgerError("invalid_record", "ledger input is missing sourceSessionId");
        const recordType = input.type ?? rawType(input.raw);
        if (recordType === undefined) throw new EventLedgerError("invalid_record", "ledger input is missing type");
        const key = stableKey(input, recordType, sourceSessionId);
        if (key !== undefined && state.seenKeys.has(key)) return undefined;
        const projection = snapshotProjection(input, recordType);
        const projectionKey = snapshotProjectionKey(recordType, sourceSessionId);
        const projectionSig = projection === undefined ? undefined : projectionSignature(projection);
        if (projectionKey !== undefined && projectionSig !== undefined && state.latestSnapshotProjections.get(projectionKey) === projectionSig) return undefined;

        const cursor = state.fold.snapshot.cursor + 1;
        const sourceSeq = input.sourceSeq ?? rawSourceSeq(input.raw);
        const parentSessionId = input.parentSessionId ?? rawParentSessionId(input.raw);
        const metadata = recordMetadata(recordType, input, state);
        const record: LedgerRecord = {
          cursor,
          mergeIndex: cursor,
          observedAt: new Date().toISOString(),
          sourceSessionId,
          ...(sourceSeq === undefined ? {} : { sourceSeq }),
          ...(parentSessionId === undefined ? {} : { parentSessionId }),
          origin: input.origin ?? (parentSessionId === undefined ? "root" : "subagent"),
          type: recordType,
          ...(metadata === undefined ? {} : { metadata }),
          ...(projection === undefined ? {} : { snapshotProjection: projection }),
          coordination: sanitizedRaw(input, recordType, sourceSessionId, sourceSeq),
        };

        const line = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
        await appendFile(this.logPath(taskId), line, { mode: 0o600 });
        await chmod(this.logPath(taskId), 0o600);
        state.records.push(record);
        if (key !== undefined) state.seenKeys.add(key);
        this.indexSnapshotProjection(state, record);
        this.indexCoordinationMetadata(state, record);
        foldRecord(state.fold, record);
        const info = await stat(this.logPath(taskId));
        state.disk = { size: info.size, ino: info.ino, dev: info.dev, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs,
          tail: Buffer.from(Buffer.concat([state.disk?.tail ?? Buffer.alloc(0), line]).subarray(-128)) };
        this.states.set(taskId, state);
        this.notify(taskId, record.cursor);
        return record;
      });
    });
  }

  async markGap(taskId: string, details: unknown): Promise<LedgerRecord> {
    const record = await this.append(taskId, {
      sourceSessionId: "__ledger__",
      origin: "root",
      type: "ledger/gap",
      raw: details,
    });
    if (record === undefined) throw new EventLedgerError("invalid_record", "ledger gap was unexpectedly deduplicated");
    return record;
  }

  async snapshot(taskId: string): Promise<LedgerSnapshot> {
    const state = await this.readLocked(taskId);
    return cloneSnapshot(state.fold.snapshot);
  }

  async tail(taskId: string, sinceCursor = 0, maxEvents = 50, maxBytes = 64_000): Promise<TailResult> {
    const state = await this.readLocked(taskId);
    const snapshot = state.fold.snapshot;
    if (snapshot.unrecoverableGap !== undefined) {
      throw new EventLedgerError("unrecoverable_gap", `task ${taskId} ledger has an unrecoverable gap`, {
        earliestCursor: snapshot.earliestCursor,
        gap: snapshot.unrecoverableGap,
      });
    }
    if (!Number.isInteger(sinceCursor) || sinceCursor < 0) {
      throw new EventLedgerError("cursor_expired", `invalid cursor ${sinceCursor}`, {
        earliestCursor: snapshot.earliestCursor,
      });
    }
    if (sinceCursor > snapshot.cursor) {
      throw new EventLedgerError("invalid_cursor", `cursor ${sinceCursor} is ahead of current cursor ${snapshot.cursor}`, {
        currentCursor: snapshot.cursor,
        earliestCursor: snapshot.earliestCursor,
      });
    }
    const earliestAllowed = snapshot.earliestCursor === 0 ? 0 : snapshot.earliestCursor - 1;
    if (sinceCursor < earliestAllowed) {
      throw new EventLedgerError(
        "cursor_expired",
        `cursor ${sinceCursor} is older than earliest cursor ${snapshot.earliestCursor}`,
        { earliestCursor: snapshot.earliestCursor },
      );
    }
    const eventLimit = Math.max(1, maxEvents);
    const byteLimit = Math.max(1, maxBytes);
    const records: TailDigestRecord[] = [];
    let bytes = 0;
    let hasMore = false;

    for (const record of state.records) {
      if (record.cursor <= sinceCursor) continue;
      const digest = digestRecord(record);
      const size = Buffer.byteLength(JSON.stringify(digest), "utf8");
      if (records.length >= eventLimit) {
        hasMore = true;
        break;
      }
      if (bytes + size > byteLimit && records.length > 0 && !digest.protected) {
        hasMore = true;
        break;
      }
      if (bytes + size > byteLimit && records.length === 0 && !digest.protected) {
        records.push({
          ...digest,
          digest: { omitted: "digest_exceeds_maxBytes", type: digest.type },
          exceededMaxBytes: true,
        });
        hasMore = true;
        break;
      }
      if (bytes + size > byteLimit && digest.protected) {
        records.push({ ...digest, exceededMaxBytes: true });
        bytes += size;
        continue;
      }
      records.push(digest);
      bytes += size;
    }

    const nextCursor = records.at(-1)?.cursor ?? sinceCursor;
    if (!hasMore) hasMore = state.records.some((record) => record.cursor > nextCursor);
    return { records, nextCursor, earliestCursor: snapshot.earliestCursor, hasMore };
  }

  async waitForCursor(taskId: string, afterCursor: number, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if ((await this.readLocked(taskId)).fold.snapshot.cursor > afterCursor || timeoutMs <= 0) return;
      await new Promise<void>((resolve, reject) => {
        const finish = () => { signal?.removeEventListener("abort", abort); resolve(); };
        const abort = () => this.settleWaiter(taskId, waiter);
        const waiter: Waiter = {
          afterCursor,
          resolve: finish,
          timer: setTimeout(() => this.settleWaiter(taskId, waiter), timeoutMs),
          reject: (error) => { this.settleWaiter(taskId, waiter, false); signal?.removeEventListener("abort", abort); reject(error); },
        };
        const set = this.waiters.get(taskId) ?? new Set<Waiter>();
        set.add(waiter);
        this.waiters.set(taskId, set);
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
        this.startPolling(taskId);
        // Close registration race for each reader; periodic I/O is task-shared.
        void this.snapshot(taskId).then(s => { if (s.cursor > afterCursor) abort(); }, waiter.reject);
      });
      signal?.throwIfAborted();
  }

  private startPolling(taskId: string): void {
    if (this.pollers.has(taskId) || !this.waiters.has(taskId)) return;
    const timer = setTimeout(() => {
      this.metrics.pollChecks++;
      void this.snapshot(taskId).then(s => this.notify(taskId, s.cursor), error => {
        for (const waiter of [...(this.waiters.get(taskId) ?? [])]) waiter.reject(error);
      }).finally(() => {
        // A new generation may have registered while this read was in flight.
        if (this.pollers.get(taskId) === timer) this.pollers.delete(taskId);
        this.startPolling(taskId);
      });
    }, 1000);
    this.pollers.set(taskId, timer);
  }

  async targetRun(taskId: string, afterCursor: number) {
    const state = await this.readLocked(taskId);
    if (afterCursor < state.fold.snapshot.earliestCursor - 1 || afterCursor > state.fold.snapshot.cursor) {
      throw new EventLedgerError("invalid_cursor", "wait target cursor is outside the retained ledger");
    }
    const target = state.target?.anchor === afterCursor ? state.target :
      { anchor: afterCursor, processed: afterCursor, starts: [] as number[], receipts: [] as Array<string | undefined>, sources: new Set<string>(), steering: new Set<string>() };
    state.target = target;
    for (let i = target.processed; i < state.records.length; i++) {
      const r = state.records[i]!;
      if (r.origin === "root" && stringField(eventOf(r.coordination), "type") === "turn/start") target.starts.push(r.cursor);
      const issued = stringField(r.metadata, "issuedRpcId");
      if (r.type === "bridge/prompt-issued" && stringField(r.coordination, "mode") === "queue") target.receipts.push(issued);
      if (r.type === "bridge/prompt-issued" && stringField(r.coordination, "mode") === "steer" && issued !== undefined) target.steering.add(issued);
      const source = stringField(r.metadata, "sourceRpcId");
      if (r.origin === "root" && source !== undefined) target.sources.add(source);
    }
    target.processed = state.records.length;
    const starts = target.starts;
    if (starts.length > 1) throw Object.assign(new Error("multiple root turns started after the wait target; inspect dsh_tail"), { code: "ambiguous_wait_target" });
    const receipts = target.receipts;
    // An accepted input may precede turn/start. Only this anchor's receipts
    // authorize input; a manual message mixed with the right receipt is still ambiguous.
    const sourceIds = [...target.sources];
    const issued = receipts.length === 1 ? receipts[0] : undefined;
    const attributed = issued !== undefined && sourceIds.includes(issued);
    const steeringIds = target.steering;
    if (receipts.length > 1 || sourceIds.some(id => id !== issued && !steeringIds.has(id))) {
      throw Object.assign(new Error("wait target cannot be uniquely attributed to the queued bridge prompt; inspect dsh_tail"), { code: "ambiguous_wait_target" });
    }
    if (starts.length === 1 && ["turn_completed", "failed", "canceled", "interrupted"].includes(state.fold.snapshot.execution) && !attributed) {
      throw Object.assign(new Error("completed run lacks prompt attribution evidence; inspect dsh_tail before acceptance"), { code: "unverified_wait_target" });
    }
    return { startCursor: starts[0], snapshot: structuredClone(state.fold.snapshot) };
  }

  async messageAfterCursor(taskId: string, pointer: LedgerEventPointer): Promise<number | undefined> {
    const state = await this.readLocked(taskId);
    const record = state.records.find(r => r.sourceSessionId === pointer.sessionId && r.sourceSeq === pointer.seq);
    return record === undefined ? undefined : record.cursor - 1;
  }

  private async serial<T>(taskId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(taskId) ?? Promise.resolve();
    const next = previous.then(work, work);
    // The internal queue is only an ordering barrier. It must never retain the
    // caller-facing rejection: `next.finally(...)` creates a second rejected
    // promise which can become unhandled even after the caller catches `next`.
    const barrier = next.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(taskId, barrier);
    void barrier.then(() => {
      if (this.queues.get(taskId) === barrier) this.queues.delete(taskId);
    });
    return next;
  }

  private async readLocked(taskId: string): Promise<TaskState> {
    await this.ensureTaskDir(taskId);
    return withFileLock(this.lockPath(taskId), () => this.reloadUnlocked(taskId));
  }

  private async reloadUnlocked(taskId: string): Promise<TaskState> {
    requireTaskId(taskId);
    let state: TaskState = this.states.get(taskId) ?? this.emptyState(taskId);
    try {
      const file = await open(this.logPath(taskId), "r");
      try {
        const info = await file.stat();
        const prior = state.disk;
        const identityMatches = prior && info.ino === prior.ino && info.dev === prior.dev;
        if (identityMatches && info.size === prior.size && info.mtimeMs === prior.mtimeMs && info.ctimeMs === prior.ctimeMs) return state;
        let offset = 0;
        if (identityMatches && info.size > prior.size) {
          const boundary = Buffer.alloc(prior.tail.length);
          await file.read(boundary, 0, boundary.length, prior.size - boundary.length);
          this.metrics.bytesRead += boundary.length;
          if (boundary.equals(prior.tail)) offset = prior.size;
        }
        if (offset === 0) { state = this.emptyState(taskId); this.metrics.fullScans++; }
        else this.metrics.incrementalReads++;
        const buffer = Buffer.alloc(info.size - offset);
        let read = 0;
        while (read < buffer.length) {
          const chunk = await file.read(buffer, read, buffer.length - read, offset + read);
          if (chunk.bytesRead === 0) throw new EventLedgerError("unrecoverable_gap", "ledger changed during locked read");
          read += chunk.bytesRead;
        }
        this.metrics.bytesRead += read;
        if (buffer.length && buffer[buffer.length - 1] !== 10) throw new EventLedgerError("unrecoverable_gap", "ledger has an incomplete trailing record");
        this.scanText(taskId, state, buffer.toString("utf8"));
        state.disk = { size: info.size, ino: info.ino, dev: info.dev, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs,
          tail: Buffer.from(Buffer.concat([offset ? prior!.tail : Buffer.alloc(0), buffer]).subarray(-128)) };
      } finally { await file.close(); }
    } catch (error) {
      this.states.delete(taskId); // Never reuse a partially folded or missing file.
      if (errorCode(error) !== "ENOENT") throw error;
      state = this.emptyState(taskId);
    }
    this.states.set(taskId, state);
    return state;
  }

  private emptyState(taskId: string): TaskState {
    return {
      loaded: true,
      records: [],
      seenKeys: new Set(),
      latestSnapshotProjections: new Map(),
      bridgeIssuedRpcIds: new Set(),
      fold: emptyFold(this.logPath(taskId)),
    };
  }

  private scanText(taskId: string, state: TaskState, raw: string): void {
    const lines = raw.split(/\n/).filter((line) => line.length > 0);
    const previousLength = state.records.length;
    let newReceipt = false;
    for (const line of lines) {
      this.metrics.recordsRead++;
      const record = parseRecord(line, this.logPath(taskId));
      newReceipt ||= record.type === "bridge/prompt-issued";
      const expectedCursor = state.records.length + 1;
      if (record.cursor !== expectedCursor) {
        throw new EventLedgerError(
          "unrecoverable_gap",
          `event ledger cursor gap in ${this.logPath(taskId)}: expected ${expectedCursor}, received ${record.cursor}`,
        );
      }
      state.records.push(record);
      const key = stableKey(
        {
          sourceSessionId: record.sourceSessionId,
          ...("sourceSeq" in record ? { sourceSeq: record.sourceSeq } : {}),
          ...("parentSessionId" in record ? { parentSessionId: record.parentSessionId } : {}),
          origin: record.origin,
          type: record.type,
          raw: record.coordination,
        },
        record.type,
        record.sourceSessionId,
      );
      if (key !== undefined) state.seenKeys.add(key);
      this.indexSnapshotProjection(state, record);
      this.indexCoordinationMetadata(state, record);
      foldRecord(state.fold, record);
    }
    // A prompt response can reach the caller after its user/message was already
    // observed on the mux.  Re-evaluate attribution after the full coordination
    // log is indexed so a later bridge/prompt-issued record closes that race.
    for (const record of state.records.slice(newReceipt ? 0 : previousLength)) {
      if (record.type !== "session/event") continue;
      const sourceRpcId = stringField(record.metadata, "sourceRpcId");
      if (sourceRpcId === undefined) continue;
      record.metadata = {
        ...(record.metadata ?? {}),
        initiatedBy: state.bridgeIssuedRpcIds.has(sourceRpcId) ? "bridge" : "external_or_unknown",
      };
    }
  }

  private indexSnapshotProjection(state: TaskState, record: LedgerRecord): void {
    if (record.snapshotProjection === undefined) return;
    const key = snapshotProjectionKey(record.type, record.sourceSessionId);
    if (key !== undefined) state.latestSnapshotProjections.set(key, projectionSignature(record.snapshotProjection));
  }

  private indexCoordinationMetadata(state: TaskState, record: LedgerRecord): void {
    const issuedRpcId = stringField(record.coordination, "issuedRpcId") ?? stringField(record.metadata, "issuedRpcId");
    if (record.type === "bridge/prompt-issued" && issuedRpcId !== undefined) {
      state.bridgeIssuedRpcIds.add(issuedRpcId);
      // The receipt may arrive after its user/message on the mux.
      for (const prior of state.records) {
        if (prior.type === "session/event" && stringField(prior.metadata, "sourceRpcId") === issuedRpcId) {
          prior.metadata = { ...prior.metadata, initiatedBy: "bridge" };
        }
      }
    }
  }

  private async ensureTaskDir(taskId: string): Promise<void> {
    await mkdir(this.ledgersDir, { recursive: true, mode: 0o700 });
    await chmod(this.ledgersDir, 0o700);
    await mkdir(join(this.ledgersDir, taskId), { recursive: true, mode: 0o700 });
    await chmod(join(this.ledgersDir, taskId), 0o700);
  }

  private logPath(taskId: string): string {
    return join(this.ledgersDir, taskId, "events.jsonl");
  }

  private lockPath(taskId: string): string {
    return join(this.ledgersDir, taskId, "events.lock");
  }

  private notify(taskId: string, cursor: number): void {
    const set = this.waiters.get(taskId);
    if (set === undefined) return;
    for (const waiter of [...set]) {
      if (cursor > waiter.afterCursor) this.settleWaiter(taskId, waiter);
    }
  }

  private settleWaiter(taskId: string, waiter: Waiter, resolve = true): void {
    clearTimeout(waiter.timer);
    const set = this.waiters.get(taskId);
    set?.delete(waiter);
    if (set?.size === 0) {
      this.waiters.delete(taskId);
      clearTimeout(this.pollers.get(taskId));
      this.pollers.delete(taskId);
    }
    if (resolve) waiter.resolve();
  }
}

function cloneSnapshot(snapshot: LedgerSnapshot): LedgerSnapshot {
  return {
    cursor: snapshot.cursor,
    earliestCursor: snapshot.earliestCursor,
    watermarks: { ...snapshot.watermarks },
    execution: snapshot.execution,
    lastKnownExecutionStatus: snapshot.lastKnownExecutionStatus,
    ...(snapshot.finalMessagePointer === undefined ? {} : { finalMessagePointer: { ...snapshot.finalMessagePointer } }),
    terminalMissingFinal: snapshot.terminalMissingFinal,
    pendingInteractions: snapshot.pendingInteractions.map((pending) => ({ ...pending })),
    ...(snapshot.currentTurn === undefined ? {} : { currentTurn: { ...snapshot.currentTurn } }),
    ...(snapshot.visualFallback === undefined ? {} : { visualFallback: { ...snapshot.visualFallback } }),
    ...(snapshot.unrecoverableGap === undefined ? {} : { unrecoverableGap: snapshot.unrecoverableGap }),
    logPath: snapshot.logPath,
  };
}
