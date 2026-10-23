/**
 * Wire contract of the installed Desktop Host's browser-session API, transcribed
 * from the installed release rather than guessed.
 *
 * Evidence (0.2.0-rc.2, host protocol 4):
 * - `@deepseek-ai/dsh-client-connection/lib/index.js` — `TOKEN_QUERY = 'token'`,
 *   `authorizeIndex` mints an authority-bound `dsh-auth-*` cookie on `GET /`
 *   with `?token=`, answers 303 with `location: './'`, and rejects everything
 *   else with 401. There is no `/connect` endpoint in this release.
 * - `@deepseek-ai/dsh-client-connection/lib/client.js` — unary RPC posts
 *   `{type:'client-request', rpcId, method, payload}` to `<channel>/<endpoint>`
 *   (`channel` is `/api`) and expects `{type:'server-response', rpcId, result}`.
 * - `@deepseek-ai/dsh-api-gateway/lib/types/stream-protocol.js` — the logical
 *   stream mux lives at `/api/remote.mux` and frames are `open`/`item`/`cancel`/
 *   `end` upstream and `item`/`end`/`error` downstream.
 * - `@deepseek-ai/dsh-api-session-controller/lib/typert.remote-client.js` — the
 *   generated descriptor table names every endpoint and its wire parameter.
 *
 * @module host-adapters/desktop-paired/protocol
 */

import { z } from "zod";

/** Exact WebSocket route carrying every logical Remote stream. */
export const REMOTE_STREAM_MUX_PATH = "/api/remote.mux";
/** Query parameter that exchanges the process launch token for a session cookie. */
export const TOKEN_QUERY = "token";
/** Shared HTTP channel every Typert Remote method is posted to. */
export const API_CHANNEL = "/api";

/** Endpoints this adapter implements, by `namespace/method`. */
export const ENDPOINTS = {
  sessionList: "session/list",
  sessionCreate: "session/create",
  sessionPrompt: "session/prompt",
  sessionPage: "session/page",
  sessionFollow: "session/follow",
  sessionCancel: "session/cancel",
  sessionProjections: "session/projections",
  jobList: "job/list",
  sessionRename: "session/rename",
  sessionUpdateQueue: "session/updateQueue",
  sessionModelCatalog: "session/modelCatalog",
  sessionWorkspacePathApplications: "session/workspacePathApplications",
  sessionCanOpenWorkspacePath: "session/canOpenWorkspacePath",
} as const;

export const rpcErrorBodySchema = z
  .object({ code: z.string().min(1), message: z.string(), details: z.unknown() })
  .passthrough();

export const serverResponseSchema = z
  .object({
    type: z.literal("server-response"),
    rpcId: z.string().min(1),
    result: z.union([
      z.object({ ok: z.literal(true), value: z.unknown() }).passthrough(),
      z.object({ ok: z.literal(false), error: rpcErrorBodySchema }).passthrough(),
    ]),
  })
  .passthrough();

export type ServerResponse = z.infer<typeof serverResponseSchema>;

const streamIdSchema = z.string().min(1);

export const streamServerFrameSchema = z.union([
  z.object({ type: z.literal("item"), streamId: streamIdSchema, value: z.unknown().optional() }).passthrough(),
  z.object({ type: z.literal("end"), streamId: streamIdSchema }).passthrough(),
  z
    .object({ type: z.literal("error"), streamId: streamIdSchema, error: rpcErrorBodySchema })
    .passthrough(),
]);

export type StreamServerFrame = z.infer<typeof streamServerFrameSchema>;

export function parseStreamServerFrame(text: string): StreamServerFrame {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch (error) {
    throw new Error("desktop-paired: stream frame is not JSON", { cause: error });
  }
  const parsed = streamServerFrameSchema.safeParse(decoded);
  if (!parsed.success) throw new Error("desktop-paired: invalid stream frame");
  return parsed.data;
}

/** One session event as it appears in a journal record. */
export const sessionEventSchema = z
  .object({
    type: z.string().min(1),
    seq: z.number(),
    time: z.number(),
    data: z.unknown(),
    sourceEventSeqs: z.array(z.number()).optional(),
    surfaceOp: z.unknown().optional(),
    ignorable: z.literal(true).optional(),
  })
  .passthrough();

export type SessionEvent = z.infer<typeof sessionEventSchema>;

const pageRecordSchema = z
  .object({ type: z.literal("event"), event: sessionEventSchema })
  .passthrough();

export const sessionPageResultSchema = z
  .object({ records: z.array(pageRecordSchema), hasMore: z.boolean() })
  .passthrough();

export const sessionFollowFrameSchema = z.union([
  z.object({ type: z.literal("event"), event: sessionEventSchema }).passthrough(),
  z
    .object({
      type: z.literal("snapshot"),
      header: z.object({ id: z.string().min(1) }).passthrough(),
      cursor: z.number(),
      records: z.array(pageRecordSchema),
      hasMore: z.boolean(),
      projections: z.unknown().optional(),
    })
    .passthrough(),
  z.object({ type: z.literal("assistant-stream"), frame: z.unknown() }).passthrough(),
]);

export type SessionFollowFrame = z.infer<typeof sessionFollowFrameSchema>;

export const sessionListResultSchema = z
  .object({
    items: z.array(
      z
        .object({
          sessionId: z.string().min(1),
          updatedAt: z.number(),
          running: z.boolean(),
          blank: z.boolean(),
          parentSessionId: z.string().min(1).optional(),
          origin: z.literal("subagent").optional(),
          cwd: z.string().optional(),
          agentPreset: z.string().optional(),
          agentAvailable: z.boolean().optional(),
          projections: z.unknown().optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export const sessionCreateResultSchema = z
  .object({ sessionId: z.string().min(1), agentPreset: z.string().optional() })
  .passthrough();

export const sessionProjectionsResultSchema = z
  .object({ asOfSeq: z.number(), values: z.unknown() })
  .passthrough();

// Inspected in installed 0.2.1-rc.2: sequenced inbox is authoritative; cached
// or migration-required projections and omitted inbox are not empty queues.
export const workspaceInboxSchema = z.object({
  kind: z.literal("sequenced"),
  asOfSeq: z.number().int().nonnegative(),
  values: z.object({ inbox: z.object({
    "next-turn": z.array(z.unknown()),
    "next-step": z.array(z.unknown()),
  }) }),
});

// job/list opens with a complete rows snapshot (own + unowned jobs).
// Unknown lifecycle values must never be interpreted as terminal.
export const workspaceJobsSchema = z.object({
  type: z.literal("rows"),
  jobs: z.array(z.object({
    id: z.string().min(1),
    status: z.enum(["running", "stopping", "completed", "failed", "killed"]),
  })),
});

/**
 * The `session/page` cursor contract: `throughSeq` is required and the page is
 * read backwards from it.
 */
export interface SessionPageRequest {
  address: { kind: "session"; sessionId: string };
  throughSeq: number;
  beforeSeq?: number;
  maxMessages?: number;
  turnWindow?: { minMessages: number; minTurns: number };
}

export interface SessionFollowRequest {
  address: { kind: "session"; sessionId: string };
  assistantStream?: true;
  maxMessages?: number;
  turnWindow?: { minMessages: number; minTurns: number };
}

/**
 * Build the `session/prompt` request.
 *
 * `requestId` is part of the installed contract and is the only value the Host
 * can use for de-duplication, so the caller supplies a stable id per dispatch
 * attempt instead of generating one inside the transport.
 */
export interface SessionPromptRequest {
  requestId: string;
  sessionId: string;
  mode: "queue" | "steer";
  content: Array<{ type: "text"; text: string }>;
  clientTimeZone?: string;
}

