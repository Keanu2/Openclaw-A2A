/**
 * mDNS responder — advertise this gateway on the local network.
 *
 * Publishes SRV + TXT records for `_a2a._tcp.local` so that other A2A
 * gateways running the DNS-SD resolver can discover this instance
 * automatically. Uses the `multicast-dns` package for UDP multicast.
 *
 * Complements the resolver in `dns-discovery.ts` to create symmetric,
 * bidirectional peer discovery.
 */

// @ts-expect-error — multicast-dns has no bundled type declarations
import mdns from "multicast-dns";
import os from "node:os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MdnsAdvertiseConfig {
  enabled: boolean;
  /** Instance name used in the SRV record. Derived from agentCard.name. */
  instanceName: string;
  /** DNS-SD service type. Default: "_a2a._tcp.local" */
  serviceName: string;
  /** Hostname announced in the SRV record. */
  hostname: string;
  /** Port announced in the SRV record. */
  port: number;
  /** TTL in seconds for all published records. Default: 120. */
  ttl: number;
  /** Key-value pairs published as TXT record (name, protocol, path, auth_type, auth_token). */
  txt: Record<string, string>;
}

export type MdnsLogFn = (
  level: "info" | "warn" | "error",
  msg: string,
  details?: Record<string, unknown>,
) => void;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Sanitize a name for use as an mDNS instance name (RFC 6763 §4.1.1). */
export function sanitizeInstanceName(name: string): string {
  // Instance names can be up to 63 UTF-8 bytes. Strip control chars and trim.
  return name.replace(/[\x00-\x1f]/g, "").trim().slice(0, 63) || "a2a-gateway";
}

/**
 * Resolve the hostname to advertise.
 *
 * When the server listens on 0.0.0.0, pick the first non-internal IPv4
 * address. Falls back to `os.hostname()`.
 */
export function resolveAdvertiseHostname(serverHost: string): string {
  if (serverHost !== "0.0.0.0" && serverHost !== "::") {
    return serverHost;
  }

  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    if (!entries) continue;
    for (const entry of entries) {
      if (entry.family === "IPv4" && !entry.internal) {
        return entry.address;
      }
    }
  }

  return os.hostname();
}

/**
 * Encode key-value pairs into DNS TXT record buffers.
 *
 * Each entry becomes `key=value` encoded as a Buffer. Empty values are
 * omitted to keep the record compact.
 */
export function encodeTxtData(txt: Record<string, string>): Buffer[] {
  const buffers: Buffer[] = [];
  for (const [key, value] of Object.entries(txt)) {
    if (value.length > 0) {
      buffers.push(Buffer.from(`${key}=${value}`));
    }
  }
  return buffers;
}

// ---------------------------------------------------------------------------
// Responder
// ---------------------------------------------------------------------------

export class MdnsResponder {
  private readonly config: MdnsAdvertiseConfig;
  private readonly log: MdnsLogFn;
  private mdnsInstance: ReturnType<typeof mdns> | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: MdnsAdvertiseConfig, log: MdnsLogFn) {
    this.config = config;
    this.log = log;
  }

  /** Start advertising this gateway via mDNS. */
  start(): void {
    if (!this.config.enabled || this.mdnsInstance) return;

    try {
      this.mdnsInstance = mdns({ loopback: true });
    } catch (err) {
      this.log("error", "mdns-responder.start-failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    // Handle incoming queries for our service type
    this.mdnsInstance.on("query", (query: { questions?: Array<{ name: string; type: string }> }) => {
      const questions = query.questions || [];
      const isForUs = questions.some(
        (q) =>
          q.name === this.config.serviceName ||
          q.name === this.instanceFullName(),
      );
      if (isForUs) {
        this.advertise();
      }
    });

    this.mdnsInstance.on("error", (err: Error) => {
      this.log("warn", "mdns-responder.error", {
        error: err.message,
      });
    });

    // Announce immediately
    this.advertise();

    // Re-announce periodically (before TTL expires)
    const reannounceMs = Math.max(this.config.ttl * 1000 * 0.75, 5_000);
    this.refreshTimer = setInterval(() => this.advertise(), reannounceMs);

    this.log("info", "mdns-responder.started", {
      instanceName: this.config.instanceName,
      hostname: this.config.hostname,
      port: this.config.port,
      ttl: this.config.ttl,
      serviceName: this.config.serviceName,
    });
  }

  /** Stop advertising and release the mDNS socket. */
  stop(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }

    if (this.mdnsInstance) {
      // Send a goodbye packet (TTL=0) to tell peers we're leaving
      this.sendGoodbye();
      this.mdnsInstance.destroy();
      this.mdnsInstance = null;
    }

    this.log("info", "mdns-responder.stopped", {
      instanceName: this.config.instanceName,
    });
  }

  /** Build the full instance name: `<instance>._a2a._tcp.local` */
  private instanceFullName(): string {
    return `${this.config.instanceName}.${this.config.serviceName}`;
  }

  /** Send an mDNS response advertising this gateway. */
  private advertise(): void {
    if (!this.mdnsInstance) return;

    const fullName = this.instanceFullName();

    this.mdnsInstance.respond({
      answers: [
        // PTR: service type → instance
        {
          name: this.config.serviceName,
          type: "PTR",
          ttl: this.config.ttl,
          data: fullName,
        },
        // SRV: instance → hostname + port
        {
          name: fullName,
          type: "SRV",
          ttl: this.config.ttl,
          data: {
            priority: 0,
            weight: 0,
            port: this.config.port,
            target: this.config.hostname,
          },
        },
        // TXT: instance → metadata
        {
          name: fullName,
          type: "TXT",
          ttl: this.config.ttl,
          data: encodeTxtData(this.config.txt),
        },
      ],
    });
  }

  /** Send a goodbye packet (TTL=0) to notify peers we're leaving. */
  private sendGoodbye(): void {
    if (!this.mdnsInstance) return;

    const fullName = this.instanceFullName();

    try {
      this.mdnsInstance.respond({
        answers: [
          {
            name: this.config.serviceName,
            type: "PTR",
            ttl: 0,
            data: fullName,
          },
          {
            name: fullName,
            type: "SRV",
            ttl: 0,
            data: {
              priority: 0,
              weight: 0,
              port: this.config.port,
              target: this.config.hostname,
            },
          },
        ],
      });
    } catch {
      // Best-effort; socket may already be closing
    }
  }
}

// ---------------------------------------------------------------------------
// Config builder
// ---------------------------------------------------------------------------

export interface MdnsAdvertiseInput {
  agentCardName: string;
  serverHost: string;
  serverPort: number;
  inboundAuth: string;
  token?: string;
  /** Raw config from plugin JSON. */
  raw?: Record<string, unknown>;
}

export const MDNS_ADVERTISE_DEFAULTS = {
  enabled: false,
  serviceName: "_a2a._tcp.local",
  ttl: 120,
};

export function buildMdnsAdvertiseConfig(input: MdnsAdvertiseInput): MdnsAdvertiseConfig {
  const raw = input.raw || {};

  const enabled = typeof raw.enabled === "boolean" ? raw.enabled : MDNS_ADVERTISE_DEFAULTS.enabled;
  const serviceName = typeof raw.serviceName === "string" && raw.serviceName.trim()
    ? raw.serviceName.trim()
    : MDNS_ADVERTISE_DEFAULTS.serviceName;
  const ttl = typeof raw.ttl === "number" && Number.isFinite(raw.ttl) && raw.ttl >= 10
    ? raw.ttl
    : MDNS_ADVERTISE_DEFAULTS.ttl;

  const hostname = resolveAdvertiseHostname(input.serverHost);

  const txt: Record<string, string> = {
    name: input.agentCardName,
    protocol: "jsonrpc",
    path: "/.well-known/agent-card.json",
  };

  if (input.inboundAuth === "bearer" && input.token) {
    txt.auth_type = "bearer";
    txt.auth_token = input.token;
  }

  return {
    enabled,
    instanceName: sanitizeInstanceName(input.agentCardName),
    serviceName,
    hostname,
    port: input.serverPort,
    ttl,
    txt,
  };
}
