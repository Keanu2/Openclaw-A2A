/**
 * Gateway-internal types — NOT part of the A2A spec.
 *
 * These types support the OpenClaw gateway-to-gateway protocol layer
 * (custom envelope format, HMAC signing, routing, outbox, idempotency, metrics).
 * They are separate from the standard A2A types used by the SDK integration.
 */

// ---------------------------------------------------------------------------
// Envelope types (custom "a2a/v1" protocol)
// ---------------------------------------------------------------------------

export interface A2ASource {
  gateway_id: string;
  agent_id?: string;
}

export interface A2ADestination {
  gateway_id?: string;
  agent_id?: string;
  route_key?: string;
}

export type MessageType = "command" | "event" | "response" | "error" | "ack";

export interface A2AEnvelope {
  protocol_version: string;
  message_id: string;
  idempotency_key: string;
  correlation_id?: string;
  timestamp: string;
  ttl_seconds: number;
  trace_id?: string;
  span_id?: string;
  source: A2ASource;
  destination: A2ADestination;
  message_type: MessageType;
  hop_count: number;
  route_path: string[];
  payload: unknown;
}

export interface A2AAck {
  protocol_version: string;
  message_id: string;
  correlation_id: string;
  source: { gateway_id: string };
  message_type: "ack";
  timestamp: string;
  status: "accepted" | "rejected";
  reason?: string;
}

export interface A2AConfig {
  gatewayId: string;
  limits: {
    maxHops: number;
    maxPayloadBytes: number;
  };
}

// ---------------------------------------------------------------------------
// Routing types
// ---------------------------------------------------------------------------

export interface RoutingRule {
  routeKey: string;
  agentId: string;
}

export interface RouteResult {
  agentId: string;
  matched_by: "agent_id" | "route_key" | "default";
}

// ---------------------------------------------------------------------------
// Outbox types
// ---------------------------------------------------------------------------

export type OutboxStatus = "pending" | "sending" | "sent" | "failed" | "dead";

export interface OutboxEntry {
  id: string;
  status: OutboxStatus;
  retry_count: number;
  next_retry_at: number;
  created_at: number;
  last_error?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Idempotency types
// ---------------------------------------------------------------------------

export interface IdempotencyEntry {
  idempotency_key: string;
  payload_fingerprint: string;
  response: string;
  created_at: number;
  expires_at: number;
}

// ---------------------------------------------------------------------------
// Metrics types
// ---------------------------------------------------------------------------

export interface A2AMetrics {
  messages_sent: number;
  messages_received: number;
  acks_sent: number;
  retries: number;
  idempotent_hits: number;
  dead_letters: number;
  errors: number;
  security_rejections: number;
  loop_rejections: number;
  last_send_at?: string;
  last_receive_at?: string;
}

// ---------------------------------------------------------------------------
// Internal peer config (for HMAC-based gateway-to-gateway auth)
// ---------------------------------------------------------------------------

export interface InternalPeerConfig {
  gatewayId: string;
  hmacSecret: string;
}
