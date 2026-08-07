/**
 * Cloud Agent Registry client — HTTP API aligned with 注册中心-README.md
 * Base: http://121.37.53.35:8000
 */

import type { PeerAuthConfig, PeerConfig } from "./types.js";

export interface RegistryConfig {
  enabled: boolean;
  baseUrl: string;
  dataset: string;
  /** Local service id on the registry (usually tunnel.deviceId). */
  serviceId: string;
  registerOnStart: boolean;
  discoverIntervalMs: number;
  /** Static peers win on name collision when true. */
  mergeWithStatic: boolean;
  /** Optional bearer for registry HTTP (center currently anonymous). */
  authToken?: string;
  /** Default auth applied to discovered tunnel peers. */
  defaultPeerAuth?: PeerAuthConfig;
}

export type RegistryLogFn = (
  level: "info" | "warn" | "error",
  msg: string,
  details?: Record<string, unknown>,
) => void;

export interface RegistryServiceEntry {
  service_id?: string;
  /** List API uses `id` instead of `service_id`. */
  id?: string;
  dataset?: string;
  status?: string;
  agent_card?: Record<string, unknown>;
  /** Center stores the Agent Card under `metadata` on list/get. */
  metadata?: Record<string, unknown>;
  name?: string;
  [key: string]: unknown;
}

/** Normalized registry row for chat / gateway list responses. */
export interface RegistryServiceDetail {
  serviceId: string;
  tunnelDeviceId: string;
  isSelf: boolean;
  status?: string;
  agentCard: Record<string, unknown>;
}

function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${b}${p}`;
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export class RegistryClient {
  private readonly config: RegistryConfig;
  private readonly log: RegistryLogFn;
  private discovered: PeerConfig[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(config: RegistryConfig, log: RegistryLogFn) {
    this.config = config;
    this.log = log;
  }

  getDiscoveredPeers(): PeerConfig[] {
    return [...this.discovered];
  }

  toPeerConfigs(): PeerConfig[] {
    return this.getDiscoveredPeers();
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  getDataset(): string {
    return this.config.dataset;
  }

  getSelfServiceId(): string {
    return this.config.serviceId;
  }

  /** Extract Agent Card from a center list/get entry (agent_card or metadata). */
  static extractAgentCard(entry: RegistryServiceEntry): Record<string, unknown> {
    if (entry.agent_card && typeof entry.agent_card === "object" && !Array.isArray(entry.agent_card)) {
      return entry.agent_card;
    }
    if (entry.metadata && typeof entry.metadata === "object" && !Array.isArray(entry.metadata)) {
      const meta = entry.metadata;
      // Full card often stored as metadata; prefer nested agent_card if present
      if (meta.agent_card && typeof meta.agent_card === "object" && !Array.isArray(meta.agent_card)) {
        return meta.agent_card as Record<string, unknown>;
      }
      // Heuristic: looks like an Agent Card
      if (typeof meta.name === "string" || typeof meta.url === "string" || meta.skills || meta.protocolVersion) {
        return meta;
      }
    }
    return {};
  }

  static extractTunnelDeviceId(card: Record<string, unknown>, fallbackId: string): string {
    const meta =
      card.metadata && typeof card.metadata === "object" && !Array.isArray(card.metadata)
        ? (card.metadata as Record<string, unknown>)
        : {};
    if (typeof meta.tunnelDeviceId === "string" && meta.tunnelDeviceId.trim()) {
      return meta.tunnelDeviceId.trim();
    }
    if (typeof meta.tunnel_device_id === "string" && meta.tunnel_device_id.trim()) {
      return meta.tunnel_device_id.trim();
    }
    // Some centers flatten tunnel id onto the card root
    if (typeof card.tunnelDeviceId === "string" && (card.tunnelDeviceId as string).trim()) {
      return (card.tunnelDeviceId as string).trim();
    }
    return fallbackId;
  }

  formatServiceEntry(entry: RegistryServiceEntry): RegistryServiceDetail | null {
    const serviceId = String(entry.service_id || entry.id || "").trim();
    if (!serviceId) return null;
    const agentCard = RegistryClient.extractAgentCard(entry);
    const tunnelDeviceId = RegistryClient.extractTunnelDeviceId(agentCard, serviceId);
    const status = typeof entry.status === "string" ? entry.status : undefined;
    return {
      serviceId,
      tunnelDeviceId,
      isSelf: serviceId === this.config.serviceId,
      status,
      agentCard,
    };
  }

  /** List all services in the configured dataset, including self. */
  async listServicesDetailed(): Promise<RegistryServiceDetail[]> {
    const services = await this.listServices();
    const out: RegistryServiceDetail[] = [];
    for (const svc of services) {
      const row = this.formatServiceEntry(svc);
      if (row) out.push(row);
    }
    // Stable order for chat/CLI: self first, then serviceId ascending
    out.sort((a, b) => {
      if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1;
      return a.serviceId.localeCompare(b.serviceId);
    });
    return out;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
    if (this.config.authToken) {
      h.authorization = `Bearer ${this.config.authToken}`;
    }
    return h;
  }

  async warmup(): Promise<unknown> {
    const res = await fetch(joinUrl(this.config.baseUrl, "/api/warmup-status"), {
      headers: this.headers(),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await readJson(res);
    if (!res.ok) {
      throw new Error(`registry warmup HTTP ${res.status}: ${JSON.stringify(body)}`);
    }
    return body;
  }

  async ensureDataset(): Promise<void> {
    const res = await fetch(joinUrl(this.config.baseUrl, "/api/datasets"), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ name: this.config.dataset }),
      signal: AbortSignal.timeout(15_000),
    });
    // 200/201 ok; 409 already exists also fine
    if (res.ok || res.status === 409) {
      this.log("info", "a2a-registry: dataset ready", { dataset: this.config.dataset, status: res.status });
      return;
    }
    const body = await readJson(res);
    // Some centers return 400 if exists — treat as ok if message hints
    const msg = JSON.stringify(body);
    if (res.status === 400 && /exist|already|冲突/i.test(msg)) {
      this.log("info", "a2a-registry: dataset already present", { dataset: this.config.dataset });
      return;
    }
    throw new Error(`registry create dataset HTTP ${res.status}: ${msg}`);
  }

  async registerA2a(agentCard: Record<string, unknown>, persistent = true): Promise<unknown> {
    const url = joinUrl(
      this.config.baseUrl,
      `/api/datasets/${encodeURIComponent(this.config.dataset)}/services/a2a`,
    );
    const res = await fetch(url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        service_id: this.config.serviceId,
        agent_card: agentCard,
        persistent,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = await readJson(res);
    if (!res.ok) {
      throw new Error(`registry register HTTP ${res.status}: ${JSON.stringify(body)}`);
    }
    this.log("info", "a2a-registry: registered", {
      dataset: this.config.dataset,
      serviceId: this.config.serviceId,
    });
    return body;
  }

  async listServices(): Promise<RegistryServiceEntry[]> {
    const url =
      joinUrl(
        this.config.baseUrl,
        `/api/datasets/${encodeURIComponent(this.config.dataset)}/services`,
      ) + "?fields=detail";
    const res = await fetch(url, {
      headers: this.headers(),
      signal: AbortSignal.timeout(20_000),
    });
    const body = await readJson(res);
    if (!res.ok) {
      throw new Error(`registry list HTTP ${res.status}: ${JSON.stringify(body)}`);
    }
    return normalizeServiceList(body);
  }

  /** Convert registry services → PeerConfig (skip self). */
  servicesToPeers(services: RegistryServiceEntry[]): PeerConfig[] {
    const peers: PeerConfig[] = [];
    for (const svc of services) {
      const row = this.formatServiceEntry(svc);
      if (!row || row.isSelf) continue;

      const peer: PeerConfig = {
        name: row.serviceId,
        // Host ignored when tunnelDeviceId is set; keep valid A2A path.
        agentCardUrl: "http://127.0.0.1:18800/.well-known/agent-card.json",
        tunnelDeviceId: row.tunnelDeviceId,
      };
      if (this.config.defaultPeerAuth) {
        peer.auth = { ...this.config.defaultPeerAuth };
      }
      peers.push(peer);
    }
    return peers;
  }

  async refresh(): Promise<PeerConfig[]> {
    const services = await this.listServices();
    this.discovered = this.servicesToPeers(services);
    this.log("info", "a2a-registry: discovered peers", {
      count: this.discovered.length,
      names: this.discovered.map((p) => p.name),
    });
    return this.getDiscoveredPeers();
  }

  start(): void {
    if (!this.config.enabled || this.running) return;
    this.running = true;
    this.log("info", "a2a-registry: discovery started", {
      baseUrl: this.config.baseUrl,
      dataset: this.config.dataset,
      intervalMs: this.config.discoverIntervalMs,
    });
    void this.refresh().catch((err) => {
      this.log(
        "warn",
        `a2a-registry: initial discover failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    this.timer = setInterval(() => {
      void this.refresh().catch((err) => {
        this.log(
          "warn",
          `a2a-registry: discover failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }, this.config.discoverIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.discovered = [];
    this.running = false;
    this.log("info", "a2a-registry: discovery stopped");
  }
}

function normalizeServiceList(body: unknown): RegistryServiceEntry[] {
  if (Array.isArray(body)) {
    return body.filter((x) => x && typeof x === "object").map((v) => {
      const e = v as RegistryServiceEntry;
      if (!e.service_id && typeof e.id === "string") {
        return { ...e, service_id: e.id };
      }
      return e;
    });
  }
  if (body && typeof body === "object") {
    const obj = body as Record<string, unknown>;
    for (const key of ["services", "items", "data", "results"]) {
      if (Array.isArray(obj[key])) {
        return normalizeServiceList(obj[key]);
      }
    }
    // map keyed by service_id
    const values = Object.values(obj);
    if (values.length > 0 && values.every((v) => v && typeof v === "object")) {
      return values.map((v) => {
        const e = v as RegistryServiceEntry;
        if (!e.service_id && typeof e.id === "string") {
          return { ...e, service_id: e.id };
        }
        return e;
      });
    }
  }
  return [];
}

export function parseRegistryConfig(
  raw: Record<string, unknown> | undefined,
  defaults?: { serviceId?: string; peerAuth?: PeerAuthConfig },
): RegistryConfig | undefined {
  if (!raw) return undefined;
  const enabled = Boolean(raw.enabled);
  if (!enabled) {
    return {
      enabled: false,
      baseUrl: "",
      dataset: "openclaw_devices",
      serviceId: defaults?.serviceId || "",
      registerOnStart: false,
      discoverIntervalMs: 30_000,
      mergeWithStatic: true,
    };
  }
  const baseUrl = typeof raw.baseUrl === "string" ? raw.baseUrl.trim() : "";
  const dataset = typeof raw.dataset === "string" && raw.dataset.trim() ? raw.dataset.trim() : "openclaw_devices";
  const serviceId =
    typeof raw.serviceId === "string" && raw.serviceId.trim()
      ? raw.serviceId.trim()
      : defaults?.serviceId || "";
  if (!baseUrl) {
    throw new Error("a2a-gateway: registry.enabled requires registry.baseUrl");
  }
  if (!serviceId) {
    throw new Error("a2a-gateway: registry.enabled requires registry.serviceId or tunnel.deviceId");
  }
  return {
    enabled: true,
    baseUrl: baseUrl.replace(/\/+$/, ""),
    dataset,
    serviceId,
    registerOnStart: raw.registerOnStart !== false,
    discoverIntervalMs: Math.max(
      5_000,
      typeof raw.discoverIntervalMs === "number" ? raw.discoverIntervalMs : 30_000,
    ),
    mergeWithStatic: raw.mergeWithStatic !== false,
    authToken: typeof raw.authToken === "string" && raw.authToken ? raw.authToken : undefined,
    defaultPeerAuth: defaults?.peerAuth,
  };
}

/** Merge static + registry-discovered peers (static wins on name). */
export function mergeRegistryPeers(staticPeers: PeerConfig[], discovered: PeerConfig[]): PeerConfig[] {
  const names = new Set(staticPeers.map((p) => p.name));
  const merged = [...staticPeers];
  for (const p of discovered) {
    if (!names.has(p.name)) merged.push(p);
  }
  return merged;
}
