/**
 * Tunnel protocol types — kept compatible with a2a-relay-2/tunnel-client + relay-server.py
 */

export const MessageType = {
  UNKNOWN: "unknown",
  REGISTER: "register",
  REGISTERED: "registered",
  FORWARD_REQUEST: "forward_request",
  FORWARD_RESPONSE: "forward_response",
  ERROR: "error",
  PING: "ping",
  PONG: "pong",
} as const;

export type MessageTypeName = (typeof MessageType)[keyof typeof MessageType];

export interface TunnelHttpRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface TunnelHttpResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface TunnelLogger {
  debug?(msg: string, data?: unknown): void;
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
}

/** Optional enriched REGISTER fields (registry-aware relays). Old relays ignore extras / may reject. */
export interface TunnelRegisterExtras {
  dataset?: string;
  serviceId?: string;
  agentCard?: Record<string, unknown>;
}

export interface TunnelSessionOptions {
  /** WebSocket URL of relay-server (ws:// or wss://) — same as CLI --remote-server */
  relayUrl: string;
  /** This device's id on the relay — same as CLI --device-id */
  deviceId: string;
  /** Local A2A gateway port for inbound forwards — same as CLI --local-service-port */
  localServicePort: number;
  heartbeatIntervalMs?: number;
  /** If no inbound traffic for this long, force reconnect (half-open detection). Default 45000. */
  heartbeatTimeoutMs?: number;
  requestTimeoutMs?: number;
  reconnectIntervalMs?: number;
  /** Cap for exponential reconnect backoff. Default 60000. */
  maxReconnectIntervalMs?: number;
  /** Max reconnect tries after disconnect. 0 = unlimited (default). */
  maxReconnectAttempts?: number;
  /**
   * When set, REGISTER also sends dataset / service_id / agent_card.
   * On register rejection, session falls back to device_id-only REGISTER.
   */
  registerExtras?: TunnelRegisterExtras;
  logger?: TunnelLogger;
}

/** Hop-by-hop headers stripped during passthrough (same set as tunnel-client). */
export const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "upgrade",
  "proxy-connection",
  "host",
  "content-length",
]);

export function filterHeaders(
  headers: Record<string, string | string[] | undefined> | Headers | undefined,
): Record<string, string | string[]> {
  const filtered: Record<string, string | string[]> = {};
  if (!headers) return filtered;

  const entries =
    typeof (headers as Headers).forEach === "function"
      ? (() => {
          const out: Array<[string, string]> = [];
          (headers as Headers).forEach((value, key) => out.push([key, value]));
          return out;
        })()
      : Object.entries(headers as Record<string, string | string[] | undefined>);

  for (const [key, value] of entries) {
    if (value == null) continue;
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) continue;
    filtered[key] = value;
  }
  return filtered;
}
