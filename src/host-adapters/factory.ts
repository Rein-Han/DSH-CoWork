import type { BridgeConfig } from "../config.js";
import { DshClient } from "../dsh-client.js";
import { createHostEndpointResolver } from "../host-endpoint.js";
import type { HostAdapter } from "./contract.js";
import { PairedHostAdapter } from "./desktop-paired/index.js";
import { LegacyRc6Adapter } from "./legacy-rc6.js";

export interface AdapterSelection {
  adapter: HostAdapter;
  /** One-line, non-secret description used by doctor and host_status. */
  summary: string;
}

/**
 * Build the adapter a configuration selects, and authenticate it when the mode
 * requires it.
 *
 * `desktop-paired` never falls back to a configured URL, automatic discovery, or
 * an anonymous request: a configuration conflict is a startup failure.
 *
 * @param config - validated bridge configuration.
 * @returns the adapter plus a sanitized description.
 */
/** The stable error code a connection failure carries, if any. Never the message. */
function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

export async function createHostAdapter(config: BridgeConfig): Promise<AdapterSelection> {
  if (config.hostMode === "desktop-paired") {
    if (config.connectionFile === undefined) {
      throw new Error("desktop-paired mode requires DSH_CONNECTION_FILE");
    }
    const adapter = new PairedHostAdapter({ connectionFile: config.connectionFile, timeoutMs: config.requestTimeoutMs });
    // Desktop may be closed or the connector may not have published yet. The MCP
    // server must still start so dsh_host_status can report the exact reason;
    // every adapter call connects on demand and the connection manager retries.
    try {
      await adapter.connect();
    } catch (error) {
      const code = errorCode(error);
      return {
        adapter,
        summary: `DSH Desktop (paired, not connected yet${code === undefined ? "" : `: ${code}`})`,
      };
    }
    const generation = adapter.currentGeneration();
    return {
      adapter,
      summary: `DSH Desktop (paired, protocol family ${adapter.protocolFamily}, host ${generation?.hostId.slice(0, 8) ?? "?"})`,
    };
  }
  const client = new DshClient(createHostEndpointResolver(config), config.requestTimeoutMs);
  return {
    adapter: new LegacyRc6Adapter(client),
    summary: config.hostMode === "desktop-auto" ? "DSH Web Host (legacy RC6, automatic loopback discovery)" : config.hostUrl,
  };
}
