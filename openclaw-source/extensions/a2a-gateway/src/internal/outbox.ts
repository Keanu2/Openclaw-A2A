/**
 * A2A Gateway Plugin — Outbox Pattern
 *
 * OpenClaw gateway-internal module — NOT part of the A2A spec.
 * Reliable at-least-once delivery via an in-memory outbox with
 * exponential back-off retry and dead-letter handling.
 */

import { randomUUID } from "node:crypto";
import type { OutboxEntry, OutboxStatus } from "./types-internal.js";

export interface OutboxConfig {
  pollIntervalMs: number;
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export class Outbox {
  private store = new Map<string, OutboxEntry>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private isFlushing = false;
  private config: OutboxConfig;

  constructor(config: OutboxConfig) {
    this.config = config;
  }

  /** Add a message to the outbox. Returns the generated entry id. */
  enqueue(
    entry: Omit<
      OutboxEntry,
      "id" | "status" | "retry_count" | "next_retry_at" | "created_at"
    >
  ): string {
    const id = randomUUID();
    const now = Date.now();
    const full: OutboxEntry = {
      ...entry,
      id,
      status: "pending",
      retry_count: 0,
      next_retry_at: now,
      created_at: now,
    };
    this.store.set(id, full);
    return id;
  }

  /** Return all entries eligible for sending (pending + due). */
  getPending(): OutboxEntry[] {
    const now = Date.now();
    const entries: OutboxEntry[] = [];
    for (const entry of this.store.values()) {
      if (entry.status === "pending" && entry.next_retry_at <= now) {
        entries.push(entry);
      }
    }
    entries.sort((a, b) => a.created_at - b.created_at);
    return entries;
  }

  markSending(id: string): void {
    const entry = this.store.get(id);
    if (entry) entry.status = "sending";
  }

  markSent(id: string): void {
    const entry = this.store.get(id);
    if (entry) entry.status = "sent";
  }

  /**
   * Record a failed delivery attempt.
   * Applies exponential back-off with jitter. Moves to 'dead' after max retries.
   */
  markFailed(id: string, error: string): void {
    const entry = this.store.get(id);
    if (!entry) return;

    entry.retry_count += 1;
    entry.last_error = error;

    if (entry.retry_count >= this.config.maxRetries) {
      entry.status = "dead";
      return;
    }

    const { baseDelayMs, maxDelayMs } = this.config;
    const expDelay = baseDelayMs * Math.pow(2, entry.retry_count);
    const jitter = Math.random() * baseDelayMs;
    const delay = Math.min(expDelay + jitter, maxDelayMs);

    entry.status = "pending";
    entry.next_retry_at = Date.now() + delay;
  }

  /** Return all dead-letter entries. */
  getDeadLetters(): OutboxEntry[] {
    const result: OutboxEntry[] = [];
    for (const entry of this.store.values()) {
      if (entry.status === "dead") result.push(entry);
    }
    return result;
  }

  /** Return aggregate counts by status. */
  getStats(): Record<"pending" | "sending" | "sent" | "failed" | "dead", number> {
    const stats = { pending: 0, sending: 0, sent: 0, failed: 0, dead: 0 };
    for (const entry of this.store.values()) {
      stats[entry.status] += 1;
    }
    return stats;
  }

  /** Remove a single entry by id. */
  remove(id: string): void {
    this.store.delete(id);
  }

  /** Remove 'sent' entries older than maxAgeMs. */
  cleanup(maxAgeMs: number): void {
    const cutoff = Date.now() - maxAgeMs;
    for (const [id, entry] of this.store) {
      if (entry.status === "sent" && entry.created_at < cutoff) {
        this.store.delete(id);
      }
    }
  }

  /**
   * Start the relay polling loop.
   * For each pending entry, calls `sendFn`. On success (true) marks sent,
   * on failure (false or thrown error) marks failed.
   */
  startRelay(sendFn: (entry: OutboxEntry) => Promise<boolean>): void {
    if (this.timer) return;
    this.timer = setInterval(async () => {
      if (this.isFlushing) return;
      this.isFlushing = true;
      try {
        const pending = this.getPending();
        for (const entry of pending) {
          this.markSending(entry.id);
          try {
            const ok = await sendFn(entry);
            if (ok) {
              this.markSent(entry.id);
            } else {
              this.markFailed(entry.id, "sendFn returned false");
            }
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            this.markFailed(entry.id, msg);
          }
        }
      } finally {
        this.isFlushing = false;
      }
    }, this.config.pollIntervalMs);
  }

  /** Stop the relay polling loop. */
  stopRelay(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
