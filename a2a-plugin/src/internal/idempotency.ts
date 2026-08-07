/**
 * A2A Gateway Plugin — Idempotency Store
 *
 * OpenClaw gateway-internal module — NOT part of the A2A spec.
 * SHA-256 payload fingerprinting and in-memory deduplication
 * with configurable TTL and periodic cleanup.
 */

import { createHash } from "node:crypto";
import type { IdempotencyEntry } from "./types-internal.js";

/** Create a SHA-256 hex fingerprint of the given payload string. */
export function createFingerprint(payload: string): string {
  return createHash("sha256").update(payload).digest("hex");
}

export type CheckResult =
  | { status: "new" }
  | { status: "duplicate"; response: string }
  | { status: "conflict" };

export interface IdempotencyStoreConfig {
  defaultTtlSeconds: number;
}

export class IdempotencyStore {
  private entries = new Map<string, IdempotencyEntry>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private config: IdempotencyStoreConfig;
  private expiredCleaned = 0;

  constructor(config: IdempotencyStoreConfig) {
    this.config = config;
  }

  /**
   * Check whether a key has been seen before.
   * - Not found -> `{ status: 'new' }`
   * - Found with same fingerprint -> `{ status: 'duplicate', response }`
   * - Found with different fingerprint -> `{ status: 'conflict' }`
   */
  check(key: string, payloadFingerprint: string): CheckResult {
    const entry = this.entries.get(key);
    if (!entry) return { status: "new" };

    if (entry.expires_at <= Date.now()) {
      this.entries.delete(key);
      this.expiredCleaned += 1;
      return { status: "new" };
    }

    if (entry.payload_fingerprint === payloadFingerprint) {
      return { status: "duplicate", response: entry.response };
    }

    return { status: "conflict" };
  }

  /** Store a response keyed by idempotency key with optional TTL override. */
  store(
    key: string,
    payloadFingerprint: string,
    response: string,
    ttlSeconds?: number
  ): void {
    const ttl = ttlSeconds ?? this.config.defaultTtlSeconds;
    const now = Date.now();
    const entry: IdempotencyEntry = {
      idempotency_key: key,
      payload_fingerprint: payloadFingerprint,
      response,
      created_at: now,
      expires_at: now + ttl * 1000,
    };
    this.entries.set(key, entry);
  }

  /** Remove all expired entries. */
  cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.expires_at <= now) {
        this.entries.delete(key);
        this.expiredCleaned += 1;
      }
    }
  }

  /** Return summary stats. */
  getStats(): { total: number; expired_cleaned: number } {
    return { total: this.entries.size, expired_cleaned: this.expiredCleaned };
  }

  /** Start periodic cleanup. Default interval is 60 000 ms. */
  startCleanup(intervalMs = 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.cleanup(), intervalMs);
  }

  /** Stop periodic cleanup. */
  stopCleanup(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
