/**
 * A2A Gateway — Metrics collector and structured logging
 *
 * OpenClaw gateway-internal module — NOT part of the A2A spec.
 */

import type { A2AMetrics } from "./types-internal.js";

// ---------------------------------------------------------------------------
// Structured log entry
// ---------------------------------------------------------------------------

export interface StructuredLogDetails {
  message_id?: string;
  trace_id?: string;
  source?: string;
  dest?: string;
  status?: string;
  retry_count?: number;
  latency_ms?: number;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Metrics collector
// ---------------------------------------------------------------------------

/** Collects and exposes A2A protocol metrics. */
export class A2AMetricsCollector {
  private metrics: A2AMetrics;

  constructor() {
    this.metrics = this.emptyMetrics();
  }

  private emptyMetrics(): A2AMetrics {
    return {
      messages_sent: 0,
      messages_received: 0,
      acks_sent: 0,
      retries: 0,
      idempotent_hits: 0,
      dead_letters: 0,
      errors: 0,
      security_rejections: 0,
      loop_rejections: 0,
    };
  }

  recordSend(): void {
    this.metrics.messages_sent++;
    this.metrics.last_send_at = new Date().toISOString();
  }

  recordReceive(): void {
    this.metrics.messages_received++;
    this.metrics.last_receive_at = new Date().toISOString();
  }

  recordAck(): void {
    this.metrics.acks_sent++;
  }

  recordRetry(): void {
    this.metrics.retries++;
  }

  recordIdempotentHit(): void {
    this.metrics.idempotent_hits++;
  }

  recordDeadLetter(): void {
    this.metrics.dead_letters++;
  }

  recordError(): void {
    this.metrics.errors++;
  }

  recordSecurityRejection(): void {
    this.metrics.security_rejections++;
  }

  recordLoopRejection(): void {
    this.metrics.loop_rejections++;
  }

  /** Return a snapshot of the current metrics. */
  getMetrics(): A2AMetrics {
    return { ...this.metrics };
  }

  /** Reset all counters to zero. */
  reset(): void {
    this.metrics = this.emptyMetrics();
  }

  /** Output a structured JSON log line to stdout. */
  structuredLog(event: string, details: StructuredLogDetails): void {
    const entry = {
      ts: new Date().toISOString(),
      event,
      message_id: details.message_id,
      trace_id: details.trace_id,
      source: details.source,
      dest: details.dest,
      status: details.status,
      retry_count: details.retry_count,
      latency_ms: details.latency_ms,
      ...details,
    };
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(entry));
  }
}
