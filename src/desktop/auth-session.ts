/**
 * The authenticated connection generation to one Desktop Host.
 *
 * One generation owns exactly one launch-token exchange, one in-memory cookie,
 * and one physical WebSocket. Cookies never touch disk; the launch token is
 * consumed once and never stored on this object after the exchange.
 *
 * Redirects are refused rather than followed: the official exchange answers a
 * single 303 to `./`, and anything else means this bridge is not talking to the
 * Host it verified.
 *
 * @module desktop/auth-session
 */

import { randomUUID } from "node:crypto";

import { API_CHANNEL, TOKEN_QUERY, parseStreamServerFrame, serverResponseSchema } from "../host-adapters/desktop-paired/protocol.js";
import type { StreamServerFrame } from "../host-adapters/desktop-paired/protocol.js";
import type { ConnectionGeneration } from "./connection-descriptor.js";

export type FetchLike = typeof fetch;

/** A stable, user-facing failure of the authenticated layer. */
export class AuthSessionError extends Error {
  constructor(
    readonly code:
      | "auth_required"
      | "auth_rejected"
      | "protocol_mismatch"
      | "desktop_not_running"
      | "capability_unavailable",
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AuthSessionError";
  }
}

const AUTH_COOKIE_PREFIX = "dsh-auth-";
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 15_000;

export interface AuthSessionOptions {
  readonly origin: string;
  readonly generation: ConnectionGeneration;
  readonly launchToken: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: FetchLike;
}

/** One authenticated connection generation. */
export class AuthSession {
  private cookie: string | undefined;
  private closed = false;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(private readonly options: AuthSessionOptions) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
  }

  get origin(): string {
    return this.options.origin;
  }

  get generation(): ConnectionGeneration {
    return this.options.generation;
  }

  get authenticated(): boolean {
    return this.cookie !== undefined;
  }

  /**
   * Exchange the process launch token for the authority-bound session cookie.
   *
   * The token is placed in the query exactly as the official exchange expects,
   * the redirect is inspected instead of followed, and only the cookie value is
   * retained — the authenticated URL itself is never stored.
   *
   * @returns the cookie header value to send on this generation's requests.
   */
  async handshake(): Promise<string> {
    if (this.closed) throw new AuthSessionError("auth_rejected", "connection generation is closed");
    if (this.cookie !== undefined) return this.cookie;

    const target = new URL("/", this.options.origin);
    target.searchParams.set(TOKEN_QUERY, this.options.launchToken);

    let response: Response;
    try {
      response = await this.fetchImpl(target, {
        method: "GET",
        redirect: "manual",
        // A redirect target must never be reached with the token attached.
        referrerPolicy: "no-referrer",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new AuthSessionError("desktop_not_running", `cannot reach the DSH Host at ${this.options.origin}: ${detail}`);
    }

    if (response.status === 401) {
      throw new AuthSessionError(
        "auth_rejected",
        "the DSH Host rejected the launch token; it is stale or belongs to a different Host process",
        { status: response.status },
      );
    }
    if (response.status === 303 || response.status === 302 || response.status === 307) {
      const cookies = response.headers.getSetCookie?.() ?? [];
      const session = cookies
        .map((entry) => entry.split(";", 1)[0]?.trim() ?? "")
        .find((entry) => entry.startsWith(AUTH_COOKIE_PREFIX));
      if (session === undefined || session === "") {
        throw new AuthSessionError(
          "auth_rejected",
          "the DSH Host accepted the launch token but issued no browser-session cookie",
          { status: response.status },
        );
      }
      this.cookie = session;
      return session;
    }
    if (response.status === 403) {
      throw new AuthSessionError(
        "auth_rejected",
        "the DSH Host refused the request authority; this build accepts only loopback origins",
        { status: response.status },
      );
    }
    throw new AuthSessionError(
      response.status === 200 ? "protocol_mismatch" : "auth_rejected",
      `unexpected launch-token exchange response ${String(response.status)}; this bridge implements the browser-session exchange observed in the installed release`,
      { status: response.status },
    );
  }

  /**
   * Invoke one unary Remote method on this generation.
   * @param endpoint - `namespace/method`, for example `session/list`.
   * @param args - the method's wire arguments, already keyed by wire name.
   * @param signal - caller cancellation.
   * @returns the method's decoded value.
   */
  async call(endpoint: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const cookie = await this.handshake();
    const rpcId = randomUUID();
    const target = new URL(`${API_CHANNEL}/${endpoint}`, this.options.origin);
    let response: Response;
    try {
      response = await this.fetchImpl(target, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ type: "client-request", rpcId, method: endpoint, payload: { args } }),
        redirect: "manual",
        signal: signal === undefined ? AbortSignal.timeout(this.timeoutMs) : AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new AuthSessionError("desktop_not_running", `the DSH Host dropped ${endpoint}: ${detail}`);
    }
    if (response.status === 401) {
      // The cookie this generation holds is no longer accepted: the Host
      // restarted or was revoked, so the caller must re-read the descriptor.
      this.cookie = undefined;
      throw new AuthSessionError("auth_required", `the DSH Host rejected this connection generation's cookie on ${endpoint}`);
    }
    if (!response.ok) {
      throw new AuthSessionError("protocol_mismatch", `${endpoint} failed with HTTP ${String(response.status)}`);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw new AuthSessionError("protocol_mismatch", `${endpoint} returned non-JSON data`, {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    const envelope = serverResponseSchema.safeParse(body);
    if (!envelope.success) {
      throw new AuthSessionError("protocol_mismatch", `${endpoint} returned an unexpected response envelope`);
    }
    if (envelope.data.rpcId !== rpcId) {
      throw new AuthSessionError("protocol_mismatch", `${endpoint} answered a different rpcId`);
    }
    if (!envelope.data.result.ok) {
      const { code, message, details } = envelope.data.result.error;
      throw new RemoteCallError(code, message, details);
    }
    return envelope.data.result.value;
  }

  /**
   * Open one logical stream over this generation's single physical socket.
   * @param endpoint - stream endpoint, for example `session/follow`.
   * @param args - the method's wire arguments.
   * @param signal - cancellation closing just this logical stream.
   * @returns the frames the Host sends before the stream ends.
   */
  async *openStream(endpoint: string, args: Record<string, unknown>, signal: AbortSignal): AsyncIterable<StreamServerFrame> {
    const cookie = await this.handshake();
    const socket = await openSocket(new URL(REMOTE_MUX_PATH_LOCAL, this.options.origin), cookie, signal);
    const streamId = randomUUID();
    try {
      socket.send(JSON.stringify({ type: "open", streamId, endpoint, payload: { args } }));
      for await (const frame of socket.frames) {
        if (frame.streamId !== streamId) continue;
        if (frame.type === "error") throw new RemoteCallError(frame.error.code, frame.error.message, frame.error.details);
        yield frame;
        if (frame.type === "end") return;
      }
      if (!signal.aborted) throw new AuthSessionError("protocol_mismatch", `${endpoint} stream closed without an end frame`);
    } finally {
      socket.close();
    }
  }

  /** Drop the cookie and mark the generation unusable. */
  dispose(): void {
    this.closed = true;
    this.cookie = undefined;
  }
}

const REMOTE_MUX_PATH_LOCAL = "/api/remote.mux";

/** A Remote call the Host itself rejected, carrying its stable code. */
export class RemoteCallError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: unknown,
  ) {
    super(message);
    this.name = "RemoteCallError";
  }
}

interface SocketHandle {
  send(text: string): void;
  close(): void;
  frames: AsyncIterable<StreamServerFrame>;
}

/**
 * Open the mux socket with the generation cookie attached to the upgrade.
 *
 * The `ws` client is used instead of the global WebSocket because the browser
 * API cannot attach a `Cookie` header to the handshake, and the Host authenticates
 * the upgrade exactly like any other request.
 */
async function openSocket(url: URL, cookie: string, signal: AbortSignal): Promise<SocketHandle> {
  const { WebSocket } = await import("ws");
  const socketUrl = new URL(url);
  socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(socketUrl, { headers: { cookie } });
  const openTimer = setTimeout(() => socket.terminate(), DEFAULT_HANDSHAKE_TIMEOUT_MS);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => {
      clearTimeout(openTimer);
      resolve();
    });
    socket.once("error", (error) => {
      clearTimeout(openTimer);
      reject(new AuthSessionError("desktop_not_running", `mux socket failed: ${(error as Error).message}`));
    });
    socket.once("unexpected-response", (_request, response) => {
      clearTimeout(openTimer);
      reject(
        new AuthSessionError(
          response.statusCode === 401 ? "auth_required" : "protocol_mismatch",
          `mux upgrade rejected with HTTP ${String(response.statusCode)}`,
        ),
      );
    });
  });
  if (signal.aborted) {
    socket.terminate();
    throw new AuthSessionError("auth_required", "stream cancelled before it opened");
  }
  return {
    send: (text) => socket.send(text),
    close: () => {
      if (socket.readyState === socket.OPEN) socket.close();
    },
    frames: (async function* frames(): AsyncIterable<StreamServerFrame> {
      const inbox: Array<StreamServerFrame | Error | "end"> = [];
      let wake: (() => void) | undefined;
      const push = (item: StreamServerFrame | Error | "end") => {
        inbox.push(item);
        wake?.();
        wake = undefined;
      };
      socket.on("message", (data) => {
        try {
          push(parseStreamServerFrame(String(data)));
        } catch (error) {
          push(error instanceof Error ? error : new Error(String(error)));
        }
      });
      socket.on("close", () => push("end"));
      socket.on("error", (error) => push(error as Error));
      const onAbort = () => push("end");
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        while (true) {
          while (inbox.length > 0) {
            const item = inbox.shift();
            if (item === undefined || item === "end") return;
            if (item instanceof Error) throw item;
            yield item;
          }
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    })(),
  };
}
