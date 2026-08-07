/**
 * A2A Gateway — HMAC-SHA256 signing, nonce cache, and peer registry
 *
 * OpenClaw gateway-internal module — NOT part of the A2A spec.
 * A2A standard uses OAuth/API Key; this implements custom HMAC-SHA256
 * for gateway-to-gateway communication.
 */

import crypto from "node:crypto";
import type { InternalPeerConfig } from "./types-internal.js";

// ---------------------------------------------------------------------------
// HMAC-SHA256 signing
// ---------------------------------------------------------------------------

export interface SignResult {
  signature: string;
  timestamp: number;
  nonce: string;
}

export interface VerifyResult {
  valid: boolean;
  error?: string;
}

/** Sign a request body using HMAC-SHA256. */
export function signRequest(
  body: string,
  secret: string,
  timestamp?: number,
): SignResult {
  const ts = timestamp ?? Date.now();
  const nonce = crypto.randomUUID();
  const data = `${ts}.${nonce}.${body}`;
  const signature = crypto
    .createHmac("sha256", secret)
    .update(data)
    .digest("hex");
  return { signature, timestamp: ts, nonce };
}

/** Verify a signed request using constant-time comparison. */
export function verifyRequest(
  body: string,
  signature: string,
  timestamp: number,
  nonce: string,
  secret: string,
): VerifyResult {
  const data = `${timestamp}.${nonce}.${body}`;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(data)
    .digest("hex");

  // Constant-time comparison
  const sigBuf = Buffer.from(signature, "utf8");
  const expBuf = Buffer.from(expected, "utf8");

  if (sigBuf.length !== expBuf.length) {
    return { valid: false, error: "Signature length mismatch" };
  }

  if (!crypto.timingSafeEqual(sigBuf, expBuf)) {
    return { valid: false, error: "Signature mismatch" };
  }

  return { valid: true };
}

// ---------------------------------------------------------------------------
// Timestamp check
// ---------------------------------------------------------------------------

/** Check if a timestamp is within the acceptable skew window. */
export function checkTimestamp(
  timestamp: number,
  skewSeconds: number,
): { valid: boolean; error?: string } {
  const now = Date.now();
  const diff = Math.abs(now - timestamp);
  const maxDiff = skewSeconds * 1000;

  if (diff > maxDiff) {
    return {
      valid: false,
      error: `Timestamp skew ${Math.round(diff / 1000)}s exceeds limit ${skewSeconds}s`,
    };
  }

  return { valid: true };
}

// ---------------------------------------------------------------------------
// Nonce cache
// ---------------------------------------------------------------------------

interface NonceEntry {
  expiresAt: number;
}

/** In-memory nonce cache with TTL and automatic cleanup. */
export class NonceCache {
  private cache = new Map<string, NonceEntry>();
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(cleanupIntervalMs: number = 60_000) {
    this.cleanupTimer = setInterval(() => this.cleanup(), cleanupIntervalMs);
    // Allow the process to exit even if the timer is still running
    this.cleanupTimer.unref();
  }

  /** Add a nonce. Returns false if it already exists and is not expired (replay detected). */
  add(nonce: string, ttlMs: number): boolean {
    const existing = this.cache.get(nonce);
    if (existing) {
      if (existing.expiresAt <= Date.now()) {
        // Expired entry — safe to reuse
        this.cache.delete(nonce);
      } else {
        return false;
      }
    }
    this.cache.set(nonce, { expiresAt: Date.now() + ttlMs });
    return true;
  }

  /** Check if a nonce exists in the cache. */
  has(nonce: string): boolean {
    return this.cache.has(nonce);
  }

  /** Remove expired entries. */
  cleanup(): void {
    const now = Date.now();
    for (const [nonce, entry] of this.cache) {
      if (entry.expiresAt <= now) {
        this.cache.delete(nonce);
      }
    }
  }

  /** Stop the automatic cleanup interval. */
  destroy(): void {
    if (this.cleanupTimer !== null) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Peer registry
// ---------------------------------------------------------------------------

/** Manage known peers and their HMAC secrets. */
export class PeerRegistry {
  private peers = new Map<string, InternalPeerConfig>();

  /** Register a peer. */
  addPeer(config: InternalPeerConfig): void {
    this.peers.set(config.gatewayId, config);
  }

  /** Get peer config by gateway ID. */
  getPeer(gatewayId: string): InternalPeerConfig | undefined {
    return this.peers.get(gatewayId);
  }

  /** Check if a peer is registered. */
  isKnown(gatewayId: string): boolean {
    return this.peers.has(gatewayId);
  }

  /** Get the HMAC secret for a peer. */
  getSecret(gatewayId: string): string | undefined {
    return this.peers.get(gatewayId)?.hmacSecret;
  }
}
