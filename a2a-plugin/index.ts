/**
 * A2A Gateway plugin endpoints:
 * - /.well-known/agent.json  (Agent Card discovery)
 * - /a2a/jsonrpc              (JSON-RPC transport)
 * - /a2a/rest                 (REST transport)
 * - gRPC on port+1            (gRPC transport)
 */

import type { Server } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AGENT_CARD_PATH } from "@a2a-js/sdk";
import { DefaultRequestHandler } from "@a2a-js/sdk/server";
import { UserBuilder, agentCardHandler, jsonRpcHandler, restHandler } from "@a2a-js/sdk/server/express";
import { grpcService, A2AService, UserBuilder as GrpcUserBuilder } from "@a2a-js/sdk/server/grpc";
import { Server as GrpcServer, ServerCredentials, status as GrpcStatus } from "@grpc/grpc-js";
import express from "express";

import { buildAgentCard } from "./src/agent-card.js";
import { A2AClient } from "./src/client.js";
import {
  DnsDiscoveryManager,
  mergeWithStaticPeers,
  parseDnsDiscoveryConfig,
} from "./src/dns-discovery.js";
import {
  MdnsResponder,
  buildMdnsAdvertiseConfig,
} from "./src/dns-responder.js";
import { OpenClawAgentExecutor } from "./src/executor.js";
import { QueueingAgentExecutor } from "./src/queueing-executor.js";
import {
  RegistryClient,
  mergeRegistryPeers,
  parseRegistryConfig,
} from "./src/registry-client.js";
import { runTaskCleanup } from "./src/task-cleanup.js";
import { recoverStaleTasks } from "./src/task-recovery.js";
import { FileTaskStore } from "./src/task-store.js";
import { GatewayTelemetry } from "./src/telemetry.js";
import { AuditLogger } from "./src/audit.js";
import { PeerHealthManager } from "./src/peer-health.js";
import { PushNotificationStore } from "./src/push-notifications.js";
import type {
  AgentCardConfig,
  GatewayConfig,
  InboundAuth,
  OpenClawPluginApi,
  PeerConfig,
  TunnelConfig,
} from "./src/types.js";
import { createTunnelSession, type TunnelSession } from "./src/tunnel/index.js";
import {
  validateUri,
  validateMimeType,
  checkFileSize,
  detectMimeType,
} from "./src/file-security.js";
import {
  parseRoutingRules,
  matchRule,
  matchAllRules,
  type AffinityConfig,
} from "./src/routing-rules.js";
import {
  QuorumDiscoveryManager,
  parseQuorumConfig,
} from "./src/quorum-discovery.js";
import {
  computeSaturationDelay,
  parseSaturationConfig,
  type SaturationConfig,
} from "./src/saturation-model.js";

/** Build a JSON-RPC error response. */
function jsonRpcError(id: string | number | null, code: number, message: string) {
  return { jsonrpc: "2.0" as const, id, error: { code, message } };
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    return {};
  }

  return value as Record<string, unknown>;
}

function asString(value: unknown, fallback = ""): string {
  if (typeof value === "string") {
    return value;
  }

  return fallback;
}

function asNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  return fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }

  return fallback;
}

function normalizeHttpPath(value: string, fallback: string): string {
  const trimmed = value.trim() || fallback;
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function resolveConfiguredPath(
  value: unknown,
  fallback: string,
  resolvePath?: (nextPath: string) => string,
): string {
  const configured = asString(value, "").trim() || fallback;
  const resolved = resolvePath ? resolvePath(configured) : configured;
  return path.isAbsolute(resolved) ? resolved : path.resolve(resolved);
}

/** Prefer OpenClaw state/home env so tasks never default under missing /root on HarmonyOS. */
function defaultOpenClawDataDir(...parts: string[]): string {
  const stateDir = process.env.OPENCLAW_STATE_DIR?.trim();
  if (stateDir) {
    return path.join(stateDir, ...parts);
  }
  const home = process.env.OPENCLAW_HOME?.trim() || os.homedir();
  return path.join(home, ".openclaw", ...parts);
}

function parseAgentCard(raw: Record<string, unknown>): AgentCardConfig {
  const skills = Array.isArray(raw.skills) ? raw.skills : [];

  return {
    name: asString(raw.name, "OpenClaw A2A Gateway"),
    description: asString(raw.description, "A2A bridge for OpenClaw agents"),
    url: asString(raw.url, ""),
    skills: skills.map((entry) => {
      if (typeof entry === "string") {
        return entry;
      }
      const skill = asObject(entry);
      return {
        id: asString(skill.id, ""),
        name: asString(skill.name, "unknown"),
        description: asString(skill.description, ""),
      };
    }),
  };
}

function parsePeers(raw: unknown): PeerConfig[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const peers: PeerConfig[] = [];
  for (const entry of raw) {
    const value = asObject(entry);
    const name = asString(value.name, "");
    const agentCardUrl = asString(value.agentCardUrl, "");
    if (!name || !agentCardUrl) {
      continue;
    }

    const authRaw = asObject(value.auth);
    const authTypeRaw = asString(authRaw.type, "");
    const authType = authTypeRaw === "bearer" || authTypeRaw === "apiKey" ? authTypeRaw : "";
    const token = asString(authRaw.token, "");

    peers.push({
      name,
      agentCardUrl,
      auth: authType && token ? { type: authType, token } : undefined,
      tunnelDeviceId: asString(value.tunnelDeviceId, "") || undefined,
    });
  }

  return peers;
}

function parseTunnelConfig(raw: unknown, serverPort: number): TunnelConfig | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const value = asObject(raw);
  const enabled = asBoolean(value.enabled, false);
  if (!enabled) {
    return { enabled: false, relayUrl: "", deviceId: "" };
  }

  const relayUrl = asString(value.relayUrl, "");
  const deviceId = asString(value.deviceId, "");
  if (!relayUrl || !deviceId) {
    throw new Error("a2a-gateway: tunnel.enabled requires tunnel.relayUrl and tunnel.deviceId");
  }
  if (!relayUrl.startsWith("ws://") && !relayUrl.startsWith("wss://")) {
    throw new Error("a2a-gateway: tunnel.relayUrl must start with ws:// or wss://");
  }

  return {
    enabled: true,
    relayUrl,
    deviceId,
    localServicePort: value.localServicePort != null
      ? asNumber(value.localServicePort, serverPort)
      : serverPort,
    heartbeatIntervalMs: value.heartbeatIntervalMs != null
      ? asNumber(value.heartbeatIntervalMs, 15_000)
      : undefined,
    heartbeatTimeoutMs: value.heartbeatTimeoutMs != null
      ? asNumber(value.heartbeatTimeoutMs, 45_000)
      : undefined,
    requestTimeoutMs: value.requestTimeoutMs != null
      ? asNumber(value.requestTimeoutMs, 300_000)
      : undefined,
    reconnectIntervalMs: value.reconnectIntervalMs != null
      ? asNumber(value.reconnectIntervalMs, 5_000)
      : undefined,
    maxReconnectIntervalMs: value.maxReconnectIntervalMs != null
      ? asNumber(value.maxReconnectIntervalMs, 60_000)
      : undefined,
    maxReconnectAttempts: value.maxReconnectAttempts != null
      ? asNumber(value.maxReconnectAttempts, 0)
      : undefined,
  };
}

export function parseConfig(raw: unknown, resolvePath?: (nextPath: string) => string): GatewayConfig {
  const config = asObject(raw);
  const server = asObject(config.server);
  const storage = asObject(config.storage);
  const security = asObject(config.security);
  const routing = asObject(config.routing);
  const limits = asObject(config.limits);
  const observability = asObject(config.observability);
  const timeouts = asObject(config.timeouts);
  const resilience = asObject(config.resilience);
  const healthCheck = asObject(resilience.healthCheck);
  const retry = asObject(resilience.retry);
  const circuitBreaker = asObject(resilience.circuitBreaker);
  const discoveryRaw = config.discovery ? asObject(config.discovery) : undefined;

  const inboundAuth = asString(security.inboundAuth, "none") as InboundAuth;

  const defaultMimeTypes = [
    "image/*", "application/pdf", "text/plain", "text/markdown", "text/csv",
    "application/json", "audio/*", "video/*",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/msword",
    "application/vnd.ms-excel",
    "application/vnd.ms-powerpoint",
  ];
  const rawAllowedMime = Array.isArray(security.allowedMimeTypes) ? security.allowedMimeTypes : [];
  const allowedMimeTypes = rawAllowedMime.length > 0
    ? rawAllowedMime.filter((v: unknown) => typeof v === "string") as string[]
    : defaultMimeTypes;
  const rawUriAllowlist = Array.isArray(security.fileUriAllowlist) ? security.fileUriAllowlist : [];
  const fileUriAllowlist = rawUriAllowlist.filter((v: unknown) => typeof v === "string") as string[];

  return {
    agentCard: parseAgentCard(asObject(config.agentCard)),
    server: {
      host: asString(server.host, "0.0.0.0"),
      port: asNumber(server.port, 18800),
    },
    storage: {
      tasksDir: resolveConfiguredPath(
        storage.tasksDir,
        defaultOpenClawDataDir("a2a-tasks"),
        resolvePath,
      ),
      taskTtlHours: Math.max(1, asNumber(storage.taskTtlHours, 72)),
      cleanupIntervalMinutes: Math.max(1, asNumber(storage.cleanupIntervalMinutes, 60)),
    },
    peers: parsePeers(config.peers),
    security: (() => {
      const singleToken = asString(security.token, "");
      const tokenArray = Array.isArray(security.tokens)
        ? (security.tokens as unknown[]).filter((t): t is string => typeof t === "string" && t.length > 0)
        : [];
      const validTokens = new Set<string>(
        [singleToken, ...tokenArray].filter(t => t.length > 0),
      );
      return {
        inboundAuth: inboundAuth === "bearer" ? "bearer" : "none" as const,
        token: singleToken,
        tokens: tokenArray,
        validTokens,
        allowedMimeTypes,
        maxFileSizeBytes: asNumber(security.maxFileSizeBytes, 52_428_800),
        maxInlineFileSizeBytes: asNumber(security.maxInlineFileSizeBytes, 52_428_800),
        fileUriAllowlist,
      };
    })(),
    routing: {
      defaultAgentId: asString(routing.defaultAgentId, "main"),
      rules: parseRoutingRules(routing.rules),
      ...(routing.affinity != null ? {
        affinity: (() => {
          const aff = asObject(routing.affinity);
          const w = asObject(aff.weights);
          return {
            hillCoefficient: asNumber(aff.hillCoefficient, 1),
            kd: asNumber(aff.kd, 0.5),
            weights: {
              skills: asNumber(w.skills, 0.4),
              tags: asNumber(w.tags, 0.3),
              pattern: asNumber(w.pattern, 0.2),
              successRate: asNumber(w.successRate, 0.1),
            },
          } satisfies import("./src/routing-rules.js").AffinityConfig;
        })(),
      } : {}),
    },
    limits: {
      maxConcurrentTasks: Math.max(1, Math.floor(asNumber(limits.maxConcurrentTasks, 4))),
      maxQueuedTasks: Math.max(0, Math.floor(asNumber(limits.maxQueuedTasks, 100))),
      ...(limits.saturation != null ? {
        saturation: parseSaturationConfig(asObject(limits.saturation)) ?? undefined,
      } : {}),
    },
    observability: {
      structuredLogs: asBoolean(observability.structuredLogs, true),
      exposeMetricsEndpoint: asBoolean(observability.exposeMetricsEndpoint, true),
      metricsPath: normalizeHttpPath(asString(observability.metricsPath, "/a2a/metrics"), "/a2a/metrics"),
      metricsAuth: (asString(observability.metricsAuth, "none") === "bearer" ? "bearer" : "none") as "none" | "bearer",
      auditLogPath: resolveConfiguredPath(
        observability.auditLogPath,
        defaultOpenClawDataDir("a2a-audit.jsonl"),
        resolvePath,
      ),
    },
    timeouts: {
      agentResponseTimeoutMs: asNumber(timeouts.agentResponseTimeoutMs, 300_000),
    },
    resilience: {
      healthCheck: {
        enabled: asBoolean(healthCheck.enabled, true),
        intervalMs: asNumber(healthCheck.intervalMs, 30_000),
        timeoutMs: asNumber(healthCheck.timeoutMs, 5_000),
      },
      retry: {
        maxRetries: Math.max(0, Math.floor(asNumber(retry.maxRetries, 3))),
        baseDelayMs: asNumber(retry.baseDelayMs, 1_000),
        maxDelayMs: asNumber(retry.maxDelayMs, 10_000),
      },
      circuitBreaker: {
        failureThreshold: Math.max(1, Math.floor(asNumber(circuitBreaker.failureThreshold, 5))),
        resetTimeoutMs: asNumber(circuitBreaker.resetTimeoutMs, 30_000),
        ...(circuitBreaker.softThreshold != null ? {
          softThreshold: Math.max(1, Math.floor(asNumber(circuitBreaker.softThreshold, 0))),
        } : {}),
        ...(circuitBreaker.desensitizedCapacity != null ? {
          desensitizedCapacity: Math.max(0, Math.min(1, asNumber(circuitBreaker.desensitizedCapacity, 0.5))),
        } : {}),
        ...(circuitBreaker.recoveryRateConstant != null ? {
          recoveryRateConstant: Math.max(0.01, asNumber(circuitBreaker.recoveryRateConstant, 1.0)),
        } : {}),
      },
    },
    discovery: parseDnsDiscoveryConfig(discoveryRaw),
    quorum: discoveryRaw?.quorum ? parseQuorumConfig(asObject(discoveryRaw.quorum)) ?? undefined : undefined,
    advertise: buildMdnsAdvertiseConfig({
      agentCardName: asString(asObject(config.agentCard).name, "OpenClaw A2A Gateway"),
      serverHost: asString(asObject(config.server).host, "0.0.0.0"),
      serverPort: asNumber(asObject(config.server).port, 18800),
      inboundAuth: asString(asObject(config.security).inboundAuth, "none"),
      token: asString(asObject(config.security).token, "") || undefined,
      raw: config.advertise ? asObject(config.advertise) : undefined,
    }),
    tunnel: parseTunnelConfig(config.tunnel, asNumber(asObject(config.server).port, 18800)),
    registry: (() => {
      const tunnelCfg = parseTunnelConfig(config.tunnel, asNumber(asObject(config.server).port, 18800));
      const peers = parsePeers(config.peers);
      const templateAuth = peers.find((p) => p.auth?.token)?.auth;
      const registryRaw = config.registry ? asObject(config.registry) : undefined;
      let defaultPeerAuth = templateAuth;
      if (registryRaw?.defaultPeerAuth && typeof registryRaw.defaultPeerAuth === "object") {
        const dpa = asObject(registryRaw.defaultPeerAuth);
        const authTypeRaw = asString(dpa.type, "bearer");
        const authType = authTypeRaw === "apiKey" ? "apiKey" : "bearer";
        const token = asString(dpa.token, "");
        if (token) defaultPeerAuth = { type: authType, token };
      }
      return parseRegistryConfig(registryRaw, {
        serviceId: tunnelCfg?.deviceId,
        peerAuth: defaultPeerAuth,
      });
    })(),
    fileStorage: (() => {
      const fsCfg = asObject(config.fileStorage);
      const tempDir = asString(fsCfg.tempDir, "").trim();
      if (!tempDir) return undefined;
      return {
        tempDir: resolveConfiguredPath(tempDir, tempDir, resolvePath),
      };
    })(),
  };
}

function normalizeCardPath(): string {
  if (AGENT_CARD_PATH.startsWith("/")) {
    return AGENT_CARD_PATH;
  }

  return `/${AGENT_CARD_PATH}`;
}

const plugin = {
  id: "a2a-gateway",
  name: "A2A Gateway",
  description: "OpenClaw plugin that serves A2A v0.3.0 endpoints (optional embedded tunnel-client)",

  register(api: OpenClawPluginApi) {
    const config = parseConfig(api.pluginConfig, api.resolvePath?.bind(api));
    const telemetry = new GatewayTelemetry(api.logger, {
      structuredLogs: config.observability.structuredLogs,
    });
    const auditLogger = new AuditLogger(config.observability.auditLogPath);
    const pushStore = new PushNotificationStore();

    const agentCard = buildAgentCard(config);

    let tunnelSession: TunnelSession | null = null;
    if (config.tunnel?.enabled) {
      // When registry is on, try enriched REGISTER (dataset/service_id/agent_card).
      // TunnelSession falls back to device_id-only if the relay rejects extras.
      const registerExtras =
        config.registry?.enabled
          ? {
              dataset: config.registry.dataset,
              serviceId: config.registry.serviceId,
              agentCard: agentCard as unknown as Record<string, unknown>,
            }
          : undefined;
      tunnelSession = createTunnelSession({
        relayUrl: config.tunnel.relayUrl,
        deviceId: config.tunnel.deviceId,
        localServicePort: config.tunnel.localServicePort ?? config.server.port,
        heartbeatIntervalMs: config.tunnel.heartbeatIntervalMs,
        heartbeatTimeoutMs: config.tunnel.heartbeatTimeoutMs,
        requestTimeoutMs: config.tunnel.requestTimeoutMs,
        reconnectIntervalMs: config.tunnel.reconnectIntervalMs,
        maxReconnectIntervalMs: config.tunnel.maxReconnectIntervalMs,
        maxReconnectAttempts: config.tunnel.maxReconnectAttempts,
        registerExtras,
        logger: {
          info: (msg) => api.logger.info(msg),
          warn: (msg) => api.logger.warn(msg),
          error: (msg) => api.logger.error(msg),
        },
      });
    }

    const client = new A2AClient({ tunnel: tunnelSession });

    // Fail fast if peers expect tunnel but tunnel is off
    for (const peer of config.peers) {
      if (peer.tunnelDeviceId && !config.tunnel?.enabled) {
        throw new Error(
          `a2a-gateway: peer "${peer.name}" has tunnelDeviceId but tunnel.enabled is false`,
        );
      }
    }

    let registryClient: RegistryClient | null = null;
    if (config.registry?.enabled) {
      registryClient = new RegistryClient(config.registry, (level, msg, details) => {
        if (level === "error") {
          api.logger.error(details ? `${msg}: ${JSON.stringify(details)}` : msg);
        } else if (level === "warn") {
          api.logger.warn(details ? `${msg}: ${JSON.stringify(details)}` : msg);
        } else {
          api.logger.info(details ? `${msg}: ${JSON.stringify(details)}` : msg);
        }
      });
    }

    const taskStore = new FileTaskStore(config.storage.tasksDir);
    const executor = new QueueingAgentExecutor(
      new OpenClawAgentExecutor(api, config),
      telemetry,
      config.limits,
      config.routing.defaultAgentId,
    );

    // Peer resilience: health check + circuit breaker
    const healthManager = config.peers.length > 0
      ? new PeerHealthManager(
          config.peers,
          config.resilience.healthCheck,
          config.resilience.circuitBreaker,
          async (peer) => {
            try {
              const card = await client.discoverAgentCard(peer, config.resilience.healthCheck.timeoutMs);
              // Cache skills from Agent Card for routing rule matching
              const skills = Array.isArray(card?.skills)
                ? (card.skills as Array<Record<string, unknown>>)
                    .map((s) => (typeof s === "string" ? s : typeof s?.id === "string" ? s.id : ""))
                    .filter((id) => id.length > 0)
                : [];
              healthManager!.updateSkills(peer.name, skills);
              return true;
            } catch {
              return false;
            }
          },
          (level, msg, details) => {
            if (level === "error") {
              api.logger.error(details ? `${msg}: ${JSON.stringify(details)}` : msg);
            } else if (level === "warn") {
              api.logger.warn(details ? `${msg}: ${JSON.stringify(details)}` : msg);
            } else {
              api.logger.info(details ? `${msg}: ${JSON.stringify(details)}` : msg);
            }
          },
        )
      : null;

    // DNS-SD discovery manager (disabled by default)
    const discoveryLog = (level: "info" | "warn" | "error", msg: string, details?: Record<string, unknown>) => {
      if (level === "error") {
        api.logger.error(details ? `${msg}: ${JSON.stringify(details)}` : msg);
      } else if (level === "warn") {
        api.logger.warn(details ? `${msg}: ${JSON.stringify(details)}` : msg);
      } else {
        api.logger.info(details ? `${msg}: ${JSON.stringify(details)}` : msg);
      }
    };
    const dnsManager = config.discovery.enabled
      ? new DnsDiscoveryManager(config.discovery, discoveryLog)
      : null;

    // Bio-inspired Quorum Sensing: when quorum config is present, wrap DNS
    // discovery with density-aware adaptive polling (bacterial QS analogy).
    let quorumManager: QuorumDiscoveryManager | null = null;
    if (dnsManager && config.quorum) {
      quorumManager = new QuorumDiscoveryManager(dnsManager, config.quorum, discoveryLog);
    }
    // Expose the underlying DNS manager for peer lookup regardless of quorum
    const discoveryManager = dnsManager;

    // mDNS responder for self-advertisement (disabled by default)
    const mdnsResponder = config.advertise.enabled
      ? new MdnsResponder(config.advertise, (level, msg, details) => {
          if (level === "error") {
            api.logger.error(details ? `${msg}: ${JSON.stringify(details)}` : msg);
          } else if (level === "warn") {
            api.logger.warn(details ? `${msg}: ${JSON.stringify(details)}` : msg);
          } else {
            api.logger.info(details ? `${msg}: ${JSON.stringify(details)}` : msg);
          }
        })
      : null;

    /**
     * Get the effective peer list: static peers merged with DNS + registry discovery.
     * Static peers always take precedence on name collision.
     */
    const getEffectivePeers = (): PeerConfig[] => {
      let peers = config.peers;

      if (discoveryManager) {
        if (!config.discovery.mergeWithStatic) {
          peers = discoveryManager.toPeerConfigs();
        } else {
          peers = mergeWithStaticPeers(peers, discoveryManager.getDiscoveredPeers());
        }
      }

      if (registryClient && config.registry?.enabled) {
        const discovered = registryClient.getDiscoveredPeers();
        if (!config.registry.mergeWithStatic) {
          peers = discovered;
        } else {
          peers = mergeRegistryPeers(peers, discovered);
        }
      }

      return peers;
    };

    /**
     * Look up a peer by name from the effective peer list.
     */
    const findPeer = (name: string): PeerConfig | undefined => {
      return getEffectivePeers().find((p) => p.name === name);
    };

    // Wire peer state into telemetry snapshot
    if (healthManager) {
      telemetry.setPeerStateProvider(() => healthManager.getAllStates());
    }

    // Wire audit logger + push notifications for inbound task completion
    telemetry.setTaskAuditCallback((taskId, contextId, state, durationMs) => {
      auditLogger.recordInbound(taskId, contextId, state, durationMs);

      // Fire-and-forget push notification for terminal states
      if (pushStore.has(taskId) && (state === "completed" || state === "failed" || state === "canceled")) {
        taskStore.load(taskId).then((task) => {
          if (!task) return;
          // Bio-inspired signal decay: use decay-aware retry so stale
          // notifications are automatically abandoned (cAMP degradation analogy).
          return pushStore.sendWithRetry(taskId, state, task, {
            decayRate: 0.001,
            minImportance: 0.1,
            maxRetries: 3,
            retryBaseDelayMs: 2000,
          });
        }).then((result) => {
          if (result && result.ok) {
            api.logger.info(`a2a-gateway: push notification sent for task ${taskId} (${state})`);
          } else if (result) {
            api.logger.warn(`a2a-gateway: push notification failed for task ${taskId}: ${result.error}`);
          }
        }).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          api.logger.warn(`a2a-gateway: push notification error for task ${taskId}: ${msg}`);
        });
      }
    });

    // SDK expects userBuilder(req) -> Promise<User>
    // When bearer auth is configured, validate the Authorization header.
    const userBuilder = async (req: { headers?: Record<string, string | string[] | undefined> }) => {
      if (config.security.inboundAuth === "bearer" && config.security.validTokens.size > 0) {
        const authHeader = req.headers?.authorization;
        const header = Array.isArray(authHeader) ? authHeader[0] : authHeader;
        const providedToken = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : "";
        if (!providedToken || !config.security.validTokens.has(providedToken)) {
          telemetry.recordSecurityRejection("http", "invalid or missing bearer token");
          auditLogger.recordSecurityEvent("http", "invalid or missing bearer token");
          throw jsonRpcError(null, -32000, "Unauthorized: invalid or missing bearer token");
        }
      }
      return UserBuilder.noAuthentication();
    };

    const requestHandler = new DefaultRequestHandler(agentCard, taskStore, executor);

    const app = express();

    // @a2a-js/sdk's jsonRpcHandler/restHandler parse the request body with
    // express.json() at its default ~100KB limit, which rejects inline base64
    // file parts far below the configured maxInlineFileSizeBytes (e.g. a ~400KB
    // PDF → ~533KB base64). Pre-parse with a limit derived from that config so
    // the SDK's own express.json() becomes a no-op (body-parser skips when
    // req._body is already set). base64 inflates ~4/3; add 1MB envelope headroom.
    const a2aJsonBodyLimit = Math.ceil(config.security.maxInlineFileSizeBytes * 1.4) + 1_048_576;
    const a2aJsonParser = express.json({ limit: a2aJsonBodyLimit });
    app.use(a2aJsonParser);

    const createHttpMetricsMiddleware =
      (route: "jsonrpc" | "rest" | "metrics") =>
      (_req: express.Request, res: express.Response, next: express.NextFunction) => {
        const startedAt = Date.now();
        res.on("finish", () => {
          telemetry.recordInboundHttp(route, res.statusCode, Date.now() - startedAt);
        });
        next();
      };

    const cardPath = normalizeCardPath();
    const cardEndpointHandler = agentCardHandler({ agentCardProvider: requestHandler });

    app.use(cardPath, cardEndpointHandler);
    if (cardPath != "/.well-known/agent.json") {
      app.use("/.well-known/agent.json", cardEndpointHandler);
    }

    app.use(
      "/a2a/jsonrpc",
      createHttpMetricsMiddleware("jsonrpc"),
      jsonRpcHandler({
        requestHandler,
        userBuilder,
      })
    );

    // Ensure errors return JSON-RPC style responses (avoid Express HTML error pages)
    app.use("/a2a/jsonrpc", (err: unknown, _req: unknown, res: any, next: (e?: unknown) => void) => {
      if (err instanceof SyntaxError) {
        res.status(400).json(jsonRpcError(null, -32700, "Parse error"));
        return;
      }

      // Payload too large (body-parser limit): give an actionable message
      // instead of a generic internal error so the size cause is visible.
      if ((err as { type?: string } | undefined)?.type === "entity.too.large") {
        res
          .status(413)
          .json(
            jsonRpcError(
              null,
              -32600,
              "Request payload too large; increase security.maxInlineFileSizeBytes or send the file by URI instead of inline bytes"
            )
          );
        return;
      }

      // Surface A2A-specific errors with proper codes
      const a2aErr = err as { code?: number; message?: string; taskId?: string } | undefined;
      if (a2aErr && typeof a2aErr.code === "number") {
        const status = a2aErr.code === -32601 ? 404 : 400;
        res.status(status).json(jsonRpcError(null, a2aErr.code, a2aErr.message || "Unknown error"));
        return;
      }

      // Generic internal error
      res.status(500).json(jsonRpcError(null, -32603, "Internal error"));
    });

    app.use(
      "/a2a/rest",
      createHttpMetricsMiddleware("rest"),
      restHandler({
        requestHandler,
        userBuilder,
      })
    );

    if (config.observability.exposeMetricsEndpoint) {
      app.get(
        config.observability.metricsPath,
        createHttpMetricsMiddleware("metrics"),
        (req, res, next) => {
          if (config.observability.metricsAuth === "bearer" && config.security.validTokens.size > 0) {
            const authHeader = req.headers.authorization;
            const header = Array.isArray(authHeader) ? authHeader[0] : authHeader;
            const token = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : "";
            if (!token || !config.security.validTokens.has(token)) {
              res.status(401).json({ error: "Unauthorized: invalid or missing bearer token" });
              return;
            }
          }
          next();
        },
        (_req, res) => {
          res.json(telemetry.snapshot());
        },
      );
    }

    // Bearer auth middleware for push notification endpoints
    const pushAuthMiddleware = (req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (config.security.inboundAuth === "bearer" && config.security.validTokens.size > 0) {
        const authHeader = req.headers.authorization;
        const header = Array.isArray(authHeader) ? authHeader[0] : authHeader;
        const token = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : "";
        if (!token || !config.security.validTokens.has(token)) {
          res.status(401).json({ error: "Unauthorized: invalid or missing bearer token" });
          return;
        }
      }
      next();
    };

    // REST endpoints for push notification registration
    app.post("/a2a/push/register", pushAuthMiddleware, express.json(), async (req, res) => {
      const body = asObject(req.body);
      const taskId = asString(body.taskId, "");
      const url = asString(body.url, "");
      if (!taskId || !url) {
        res.status(400).json({ error: "taskId and url are required" });
        return;
      }

      // SSRF validation: reuse file-security's URI validation
      const uriCheck = await validateUri(url, config.security);
      if (!uriCheck.ok) {
        res.status(400).json({ error: `Webhook URL rejected: ${uriCheck.reason}` });
        return;
      }

      const token = asString(body.token, "") || undefined;
      const events = Array.isArray(body.events)
        ? (body.events as unknown[]).filter((e): e is string => typeof e === "string")
        : undefined;
      pushStore.register(taskId, { url, token, events });
      res.json({ taskId, registered: true });
    });

    app.delete("/a2a/push/:taskId", pushAuthMiddleware, (req, res) => {
      const rawTaskId = req.params.taskId;
      const taskId = typeof rawTaskId === "string" ? rawTaskId : "";
      if (!taskId) {
        res.status(400).json({ error: "taskId is required" });
        return;
      }
      const existed = pushStore.has(taskId);
      pushStore.unregister(taskId);
      res.json({ taskId, removed: existed });
    });

    let server: Server | null = null;
    let grpcServer: GrpcServer | null = null;
    let cleanupTimer: ReturnType<typeof setInterval> | null = null;
    const grpcPort = config.server.port + 1;

    api.registerGatewayMethod("a2a.metrics", ({ respond }) => {
      respond(true, {
        metrics: telemetry.snapshot(),
      });
    });

    api.registerGatewayMethod("a2a.audit", ({ params, respond }) => {
      const payload = asObject(params);
      const count = Math.min(Math.max(1, asNumber(payload.count, 50)), 500);
      auditLogger
        .tail(count)
        .then((entries) => respond(true, { entries, count: entries.length }))
        .catch((error) => respond(false, { error: String(error?.message || error) }));
    });

    api.registerGatewayMethod("a2a.pushNotification.register", ({ params, respond }) => {
      const payload = asObject(params);
      const taskId = asString(payload.taskId, "");
      const url = asString(payload.url, "");
      if (!taskId || !url) {
        respond(false, { error: "taskId and url are required" });
        return;
      }

      // SSRF validation on webhook URL
      validateUri(url, config.security).then((uriCheck) => {
        if (!uriCheck.ok) {
          respond(false, { error: `Webhook URL rejected: ${uriCheck.reason}` });
          return;
        }
        const token = asString(payload.token, "") || undefined;
        const events = Array.isArray(payload.events)
          ? (payload.events as unknown[]).filter((e): e is string => typeof e === "string")
          : undefined;
        pushStore.register(taskId, { url, token, events });
        respond(true, { taskId, registered: true });
      }).catch((err) => {
        respond(false, { error: `URI validation failed: ${err instanceof Error ? err.message : String(err)}` });
      });
    });

    api.registerGatewayMethod("a2a.pushNotification.unregister", ({ params, respond }) => {
      const payload = asObject(params);
      const taskId = asString(payload.taskId, "");
      if (!taskId) {
        respond(false, { error: "taskId is required" });
        return;
      }
      const existed = pushStore.has(taskId);
      pushStore.unregister(taskId);
      respond(true, { taskId, removed: existed });
    });

    api.registerGatewayMethod("a2a.send", ({ params, respond }) => {
      const payload = asObject(params);
      let peerName = asString(payload.peer || payload.name, "");
      const message = asObject(payload.message || payload.payload);

      // Rule-based routing: auto-select peer when not explicitly provided
      if (!peerName && config.routing.rules.length > 0) {
        const msgText = typeof message.text === "string" ? message.text
          : typeof message.message === "string" ? message.message : "";
        const msgTags = Array.isArray(message.tags)
          ? (message.tags as unknown[]).filter((t): t is string => typeof t === "string")
          : [];
        const peerSkills = healthManager?.getPeerSkills();
        // Bio-inspired routing: when affinity config is present, use Hill equation
        // scored matching (best match). Otherwise fall back to legacy first-match.
        if (config.routing.affinity) {
          const scored = matchAllRules(
            config.routing.rules,
            { text: msgText, tags: msgTags },
            peerSkills,
            undefined,
            config.routing.affinity,
          );
          if (scored.length > 0) {
            const best = scored[0];
            peerName = best.peer;
            if (best.agentId && !message.agentId) {
              message.agentId = best.agentId;
            }
            api.logger.info(`a2a-gateway: affinity routing → peer="${peerName}" score=${best.score.toFixed(3)}${best.agentId ? ` agentId="${best.agentId}"` : ""}`);
          }
        } else {
          const routeMatch = matchRule(config.routing.rules, { text: msgText, tags: msgTags }, peerSkills);
          if (routeMatch) {
            peerName = routeMatch.peer;
            if (routeMatch.agentId && !message.agentId) {
              message.agentId = routeMatch.agentId;
            }
            api.logger.info(`a2a-gateway: rule-based routing matched → peer="${peerName}"${routeMatch.agentId ? ` agentId="${routeMatch.agentId}"` : ""}`);
          }
        }
      }

      const peer = findPeer(peerName);
      if (!peer) {
        const hint = peerName
          ? `Peer not found: ${peerName}`
          : "No peer specified and no routing rule matched";
        respond(false, { error: hint });
        return;
      }

      const startedAt = Date.now();
      const sendOptions = {
        healthManager: healthManager ?? undefined,
        retryConfig: config.resilience.retry,
        log: (level: "info" | "warn", msg: string, details?: Record<string, unknown>) => {
          if (details?.attempt) {
            telemetry.recordPeerRetry(peer.name, details.attempt as number);
          }
          api.logger[level](details ? `${msg}: ${JSON.stringify(details)}` : msg);
        },
      };
      client
        .sendMessage(peer, message, sendOptions)
        .then((result) => {
          const outDuration = Date.now() - startedAt;
          telemetry.recordOutboundRequest(peer.name, result.ok, result.statusCode, outDuration);
          auditLogger.recordOutbound(peer.name, result.ok, result.statusCode, outDuration);
          if (result.ok) {
            respond(true, {
              statusCode: result.statusCode,
              response: result.response,
            });
            return;
          }

          respond(false, {
            statusCode: result.statusCode,
            response: result.response,
          });
        })
        .catch((error) => {
          const errDuration = Date.now() - startedAt;
          telemetry.recordOutboundRequest(peer.name, false, 500, errDuration);
          auditLogger.recordOutbound(peer.name, false, 500, errDuration);
          respond(false, { error: String(error?.message || error) });
        });
    });

    // ------------------------------------------------------------------
    // Local path → A2A FilePart (gateway method always registered).
    // Avoids CLI ARG_MAX / E2BIG when transferring large files.
    // ------------------------------------------------------------------
    const isAllowedLocalPath = (filePath: string): { ok: true; resolved: string } | { ok: false; reason: string } => {
      if (typeof filePath !== "string" || !filePath.trim()) {
        return { ok: false, reason: "path is required" };
      }
      if (!path.isAbsolute(filePath)) {
        return { ok: false, reason: "path must be absolute" };
      }
      if (filePath.includes("\0")) {
        return { ok: false, reason: "path contains NUL" };
      }
      const resolved = path.resolve(filePath);
      const allowedPrefixes = [
        "/data/local/",
        "/storage/media/",
        "/storage/cloud/",
        "/storage/Users/",
        "/mnt/user/",
        "/mnt/hmdfs/",
        "/home/",
      ];
      // Normalize for HarmonyOS (POSIX) and Windows unit-test hosts (drive letter + backslash).
      const candidates = [filePath, resolved].map((p) =>
        p.replace(/\\/g, "/").replace(/^[A-Za-z]:/, ""),
      );
      const allowed = allowedPrefixes.some((prefix) =>
        candidates.some(
          (c) => c === prefix.slice(0, -1) || c.startsWith(prefix) || c.startsWith(prefix.slice(1)),
        ),
      );
      if (!allowed) {
        return {
          ok: false,
          reason: `path not in allowed roots (${allowedPrefixes.join(", ")})`,
        };
      }
      return { ok: true, resolved };
    };

    const sendLocalFileCore = async (params: {
      peer: string;
      path: string;
      name?: string;
      mimeType?: string;
      text?: string;
      agentId?: string;
    }) => {
      const peer = findPeer(params.peer);
      if (!peer) {
        const available = getEffectivePeers().map((p) => p.name).join(", ") || "(none)";
        return { ok: false as const, error: `Peer not found: "${params.peer}". Available peers: ${available}` };
      }

      const pathCheck = isAllowedLocalPath(params.path);
      if (!pathCheck.ok) {
        return { ok: false as const, error: `Path rejected: ${pathCheck.reason}` };
      }
      const filePath = pathCheck.resolved;

      let st: fs.Stats;
      try {
        st = fs.statSync(filePath);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false as const, error: `Cannot access file: ${msg}` };
      }
      if (!st.isFile()) {
        return { ok: false as const, error: `Not a regular file: ${filePath}` };
      }

      const sizeCheck = checkFileSize(st.size, config.security.maxInlineFileSizeBytes);
      if (!sizeCheck.ok) {
        return { ok: false as const, error: sizeCheck.reason || "file too large" };
      }

      // Wire name MUST follow the real local basename so the peer saves the same name.
      // Do not trust params.name (agents often invent "file.jpg").
      const name = path.basename(filePath);
      const mimeType = (params.mimeType && String(params.mimeType).trim()) || detectMimeType(filePath);
      if (!validateMimeType(mimeType, config.security.allowedMimeTypes)) {
        return { ok: false as const, error: `MIME type rejected: "${mimeType}" is not in the allowed list` };
      }

      let bytes: string;
      try {
        bytes = fs.readFileSync(filePath).toString("base64");
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false as const, error: `Failed to read file: ${msg}` };
      }

      const parts: Array<Record<string, unknown>> = [];
      if (params.text) {
        parts.push({ kind: "text", text: params.text });
      }
      // Put name/mimeType BEFORE bytes so large base64 cannot push metadata
      // past body/parser limits or partial-JSON cutoffs (seen as wire name="file").
      parts.push({
        kind: "file",
        file: { name, mimeType, bytes },
      });

      const message: Record<string, unknown> = { parts };
      if (params.agentId) {
        message.agentId = params.agentId;
      }

      try {
        const result = await client.sendMessage(peer, message, {
          healthManager: healthManager ?? undefined,
          retryConfig: config.resilience.retry,
        });
        if (result.ok) {
          return {
            ok: true as const,
            path: filePath,
            name,
            mimeType,
            sizeBytes: st.size,
            response: result.response,
            statusCode: result.statusCode,
          };
        }
        return {
          ok: false as const,
          error: `Failed to send file to ${params.peer}: ${JSON.stringify(result.response)}`,
          statusCode: result.statusCode,
          response: result.response,
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false as const, error: `Error sending file to ${params.peer}: ${msg}` };
      }
    };

    api.registerGatewayMethod("a2a.send_local_file", ({ params, respond }) => {
      const peerName = typeof params?.peer === "string" ? params.peer : "";
      const filePath = typeof params?.path === "string" ? params.path : "";
      if (!peerName || !filePath) {
        respond(false, { error: 'Required params: "peer" (string), "path" (string)' });
        return;
      }
      void sendLocalFileCore({
        peer: peerName,
        path: filePath,
        name: typeof params?.name === "string" ? params.name : undefined,
        mimeType: typeof params?.mimeType === "string" ? params.mimeType : undefined,
        text: typeof params?.text === "string" ? params.text : undefined,
        agentId: typeof params?.agentId === "string" ? params.agentId : undefined,
      }).then((result) => {
        if (result.ok) {
          respond(true, result);
        } else {
          // OpenClaw WS respond(ok, payload, error) — CLI reads error.message
          respond(false, { error: result.error }, { message: result.error, code: "INVALID_REQUEST" });
        }
      }).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        respond(false, { error: msg }, { message: msg, code: "UNAVAILABLE" });
      });
    });
    api.logger.info("a2a-gateway: registered gateway method a2a.send_local_file");

    // ------------------------------------------------------------------
    // Registry: register / list (chat + CLI)
    // ------------------------------------------------------------------
    const registryDisabledPayload = () => ({
      ok: false,
      error:
        "registry 未启用。请在 plugins.entries.a2a-gateway.config.registry 中设置 enabled=true、baseUrl、serviceId（或 tunnel.deviceId）。",
    });

    const selfTunnelDeviceIdFromCard = (): string => {
      const meta = (agentCard as { metadata?: Record<string, unknown> }).metadata;
      if (meta && typeof meta.tunnelDeviceId === "string" && meta.tunnelDeviceId.trim()) {
        return meta.tunnelDeviceId.trim();
      }
      return config.tunnel?.deviceId || config.registry?.serviceId || "";
    };

    const formatRegistryListText = (payload: {
      dataset: string;
      selfServiceId: string;
      selfTunnelDeviceId: string;
      count: number;
      services: Array<{
        serviceId: string;
        tunnelDeviceId: string;
        isSelf: boolean;
        status?: string;
        agentCard: Record<string, unknown>;
      }>;
    }): string => {
      const skillLabel = (card: Record<string, unknown>): string => {
        const skills = Array.isArray(card.skills) ? card.skills : [];
        const ids = skills
          .map((sk) => {
            if (typeof sk === "string") return sk;
            if (sk && typeof sk === "object") {
              const o = sk as Record<string, unknown>;
              return typeof o.id === "string" ? o.id : typeof o.name === "string" ? o.name : "";
            }
            return "";
          })
          .filter(Boolean);
        return ids.length ? ids.join(", ") : "(无)";
      };

      const lines: string[] = [
        "【注册中心设备列表】",
        `dataset: ${payload.dataset}`,
        `共 ${payload.count} 台`,
        `本机 serviceId: ${payload.selfServiceId}`,
        `本机 tunnelDeviceId: ${payload.selfTunnelDeviceId || "(无)"}`,
        "",
      ];

      if (payload.services.length === 0) {
        lines.push("(当前 dataset 下没有已注册设备)");
        lines.push("");
      } else {
        payload.services.forEach((s, index) => {
          const card = s.agentCard;
          lines.push(`${index + 1}. serviceId: ${s.serviceId}`);
          lines.push(`   tunnelDeviceId: ${s.tunnelDeviceId}`);
          lines.push(`   是否本机: ${s.isSelf ? "是" : "否"}`);
          lines.push(`   status: ${s.status || "(无)"}`);
          lines.push(`   AgentCard.name: ${typeof card.name === "string" ? card.name : "(无)"}`);
          lines.push(
            `   AgentCard.description: ${typeof card.description === "string" ? card.description : "(无)"}`,
          );
          lines.push(`   AgentCard.url: ${typeof card.url === "string" ? card.url : "(无)"}`);
          lines.push(`   AgentCard.skills: ${skillLabel(card)}`);
          lines.push("");
        });
      }

      return lines.join("\n").trimEnd();
    };

    const formatRegistryRegisterText = (details: {
      dataset: string;
      serviceId: string;
      tunnelDeviceId: string;
    }): string => {
      return [
        "【注册中心注册结果】",
        "status: 成功",
        `dataset: ${details.dataset}`,
        `serviceId: ${details.serviceId}`,
        `tunnelDeviceId: ${details.tunnelDeviceId || "(无)"}`,
      ].join("\n");
    };

    const registryAssistantHint =
      "【给助手】请将上一段以【注册中心 开头的结果正文原文原样发给用户；不要改写、不要摘要、不要附带本条说明。";

    api.registerGatewayMethod("a2a.registry.register", ({ respond }) => {
      if (!registryClient || !config.registry?.enabled) {
        const payload = registryDisabledPayload();
        respond(false, payload, { message: payload.error, code: "FAILED_PRECONDITION" });
        return;
      }
      const rc = registryClient;
      void (async () => {
        await rc.ensureDataset();
        const body = await rc.registerA2a(agentCard as unknown as Record<string, unknown>, true);
        const tunnelDeviceId = selfTunnelDeviceIdFromCard();
        respond(true, {
          ok: true,
          dataset: rc.getDataset(),
          serviceId: rc.getSelfServiceId(),
          tunnelDeviceId,
          centerResponse: body,
        });
      })().catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        respond(false, { ok: false, error: msg }, { message: msg, code: "UNAVAILABLE" });
      });
    });
    api.logger.info("a2a-gateway: registered gateway method a2a.registry.register");

    api.registerGatewayMethod("a2a.registry.list", ({ respond }) => {
      if (!registryClient || !config.registry?.enabled) {
        const payload = registryDisabledPayload();
        respond(false, payload, { message: payload.error, code: "FAILED_PRECONDITION" });
        return;
      }
      const rc = registryClient;
      void (async () => {
        const services = await rc.listServicesDetailed();
        // Keep internal discovery cache in sync (peers still skip self)
        try {
          await rc.refresh();
        } catch {
          // list already succeeded; refresh is best-effort
        }
        const payload = {
          ok: true,
          dataset: rc.getDataset(),
          selfServiceId: rc.getSelfServiceId(),
          selfTunnelDeviceId: selfTunnelDeviceIdFromCard(),
          count: services.length,
          services,
        };
        respond(true, payload);
      })().catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        respond(false, { ok: false, error: msg }, { message: msg, code: "UNAVAILABLE" });
      });
    });
    api.logger.info("a2a-gateway: registered gateway method a2a.registry.list");

    // ------------------------------------------------------------------
    // Agent tool: a2a_send_file
    // Lets the agent send a file (by URI) to a peer via A2A FilePart.
    // ------------------------------------------------------------------
    if (api.registerTool) {
      const sendFileParams = {
        type: "object" as const,
        required: ["peer", "uri"],
        properties: {
          peer: { type: "string" as const, description: "Name of the target peer (must match a configured peer name)" },
          uri: { type: "string" as const, description: "Public URL of the file to send" },
          name: { type: "string" as const, description: "Filename (e.g. report.pdf)" },
          mimeType: { type: "string" as const, description: "MIME type (e.g. application/pdf). Auto-detected from extension if omitted." },
          text: { type: "string" as const, description: "Optional text message to include alongside the file" },
          agentId: { type: "string" as const, description: "Route to a specific agentId on the peer (OpenClaw extension). Omit to use the peer's default agent." },
        },
      };

      api.registerTool({
        name: "a2a_send_file",
        description: "Send a file to a peer agent via A2A. The file is referenced by its public URL (URI). " +
          "Use this when you need to transfer a document, image, or any file to another agent.",
        label: "A2A Send File",
        parameters: sendFileParams,
        async execute(toolCallId, params) {
          const peer = findPeer(params.peer);
          if (!peer) {
            const available = getEffectivePeers().map((p) => p.name).join(", ") || "(none)";
            return {
              content: [{ type: "text" as const, text: `Peer not found: "${params.peer}". Available peers: ${available}` }],
              details: { ok: false },
            };
          }

          // Security checks: SSRF, MIME, file size
          const uriCheck = await validateUri(params.uri, config.security);
          if (!uriCheck.ok) {
            return {
              content: [{ type: "text" as const, text: `URI rejected: ${uriCheck.reason}` }],
              details: { ok: false, reason: uriCheck.reason },
            };
          }

          if (params.mimeType && !validateMimeType(params.mimeType, config.security.allowedMimeTypes)) {
            return {
              content: [{ type: "text" as const, text: `MIME type rejected: "${params.mimeType}" is not in the allowed list` }],
              details: { ok: false },
            };
          }

          const parts: Array<Record<string, unknown>> = [];
          if (params.text) {
            parts.push({ kind: "text", text: params.text });
          }
          parts.push({
            kind: "file",
            file: {
              uri: params.uri,
              ...(params.name ? { name: params.name } : {}),
              ...(params.mimeType ? { mimeType: params.mimeType } : {}),
            },
          });

          try {
            const message: Record<string, unknown> = { parts };
            if (params.agentId) {
              message.agentId = params.agentId;
            }
            const result = await client.sendMessage(peer, message, {
              healthManager: healthManager ?? undefined,
              retryConfig: config.resilience.retry,
            });
            if (result.ok) {
              return {
                content: [{
                  type: "text" as const,
                  text:
                    `【A2A 发送完成】\n` +
                    `对端 peer: ${params.peer}\n` +
                    `URI: ${params.uri}\n` +
                    `\n` +
                    `请在聊天窗口用中文明确告知用户：发送完成。`,
                }],
                details: { ok: true, response: result.response },
              };
            }
            return {
              content: [{
                type: "text" as const,
                text: `【A2A 发送失败】${JSON.stringify(result.response)}\n请在聊天窗口告知用户发送失败。`,
              }],
              details: { ok: false, response: result.response },
            };
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return {
              content: [{ type: "text" as const, text: `Error sending file to ${params.peer}: ${msg}` }],
              details: { ok: false, error: msg },
            };
          }
        },
      });

      // Agent tool: a2a_send_local_file (uses sendLocalFileCore defined above)
      api.registerTool({
        name: "a2a_send_local_file",
        description:
          "Send a LOCAL file to a peer via A2A by reading the filesystem path (base64 FilePart). " +
          "Use this for Desktop/Photo/gallery files on this device. Do NOT use a2a_send_file for local paths. " +
          "Does not require SoftBus pairing. Peer names: use configured A2A peers (e.g. HW-PC1 / HW-Phone1). " +
          "After success, tell the user in Chinese that 发送完成, including peer name and filename.",
        label: "A2A Send Local File",
        parameters: {
          type: "object" as const,
          required: ["peer", "path"],
          properties: {
            peer: { type: "string" as const, description: "Name of the target peer (must match a configured peer name)" },
            path: { type: "string" as const, description: "Absolute local file path on this device (e.g. /storage/media/.../Photo/16/IMG.jpg). Wire filename = basename(path)." },
            name: { type: "string" as const, description: "Ignored: transmission filename is always basename(path) so peer saves the same name." },
            mimeType: { type: "string" as const, description: "MIME type override (default: detected from extension)" },
            text: { type: "string" as const, description: "Optional text message to include alongside the file" },
            agentId: { type: "string" as const, description: "Route to a specific agentId on the peer. Omit for default." },
          },
        },
        async execute(_toolCallId, params) {
          const result = await sendLocalFileCore(params);
          if (result.ok) {
            return {
              content: [{
                type: "text" as const,
                text:
                  `【A2A 发送完成】\n` +
                  `对端 peer: ${params.peer}\n` +
                  `本地源路径: ${result.path}\n` +
                  `文件名: ${result.name}\n` +
                  `MIME: ${result.mimeType}\n` +
                  `大小: ${result.sizeBytes} bytes\n` +
                  `\n` +
                  `请在聊天窗口用中文明确告知用户：发送完成（含 peer 名与文件名）。不要贴 base64。`,
              }],
              details: result,
            };
          }
          return {
            content: [{
              type: "text" as const,
              text:
                `【A2A 发送失败】${result.error}\n` +
                `请在聊天窗口用中文告知用户发送失败及原因。`,
            }],
            details: result,
          };
        },
      });

      api.registerTool({
        name: "a2a_registry_register",
        description:
          "Register this device/agent to the cloud Agent Registry (通讯录). " +
          "Use when the user says 注册到注册中心 / 注册本机 / register to registry. " +
          "POSTs the local Agent Card into the configured registry.dataset. " +
          "Returns a FIXED Chinese template; paste the result body verbatim to the user — do not reformat.",
        label: "A2A Registry Register",
        parameters: { type: "object" as const, properties: {} },
        async execute() {
          if (!registryClient || !config.registry?.enabled) {
            const payload = registryDisabledPayload();
            return {
              content: [
                {
                  type: "text" as const,
                  text: ["【注册中心注册结果】", "status: 失败", `error: ${payload.error}`].join("\n"),
                },
                { type: "text" as const, text: registryAssistantHint },
              ],
              details: payload,
            };
          }
          try {
            await registryClient.ensureDataset();
            const body = await registryClient.registerA2a(agentCard as unknown as Record<string, unknown>, true);
            const tunnelDeviceId = selfTunnelDeviceIdFromCard();
            const details = {
              ok: true,
              dataset: registryClient.getDataset(),
              serviceId: registryClient.getSelfServiceId(),
              tunnelDeviceId,
              centerResponse: body,
            };
            return {
              content: [
                {
                  type: "text" as const,
                  text: formatRegistryRegisterText({
                    dataset: details.dataset,
                    serviceId: details.serviceId,
                    tunnelDeviceId: details.tunnelDeviceId,
                  }),
                },
                { type: "text" as const, text: registryAssistantHint },
              ],
              details,
            };
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return {
              content: [
                {
                  type: "text" as const,
                  text: ["【注册中心注册结果】", "status: 失败", `error: ${msg}`].join("\n"),
                },
                { type: "text" as const, text: registryAssistantHint },
              ],
              details: { ok: false, error: msg },
            };
          }
        },
      });

      api.registerTool({
        name: "a2a_registry_list",
        description:
          "List agents/devices already registered in the cloud Agent Registry (通讯录). " +
          "Use when the user says 查注册设备 / 列出注册中心 / 谁已注册 / list registry / 注册中心连接设备. " +
          "Returns a FIXED Chinese template with serviceId, tunnelDeviceId, isSelf, status, and AgentCard fields. " +
          "You MUST paste the first result text block (【注册中心设备列表】) verbatim to the user — do not reformat or summarize. " +
          "To message a peer afterward, use that serviceId as the a2a.send peer name.",
        label: "A2A Registry List",
        parameters: { type: "object" as const, properties: {} },
        async execute() {
          if (!registryClient || !config.registry?.enabled) {
            const payload = registryDisabledPayload();
            return {
              content: [
                {
                  type: "text" as const,
                  text: ["【注册中心设备列表】", "status: 失败", `error: ${payload.error}`].join("\n"),
                },
                { type: "text" as const, text: registryAssistantHint },
              ],
              details: payload,
            };
          }
          try {
            const services = await registryClient.listServicesDetailed();
            try {
              await registryClient.refresh();
            } catch {
              // best-effort
            }
            const details = {
              ok: true,
              dataset: registryClient.getDataset(),
              selfServiceId: registryClient.getSelfServiceId(),
              selfTunnelDeviceId: selfTunnelDeviceIdFromCard(),
              count: services.length,
              services,
            };
            return {
              content: [
                { type: "text" as const, text: formatRegistryListText(details) },
                { type: "text" as const, text: registryAssistantHint },
              ],
              details,
            };
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return {
              content: [
                {
                  type: "text" as const,
                  text: ["【注册中心设备列表】", "status: 失败", `error: ${msg}`].join("\n"),
                },
                { type: "text" as const, text: registryAssistantHint },
              ],
              details: { ok: false, error: msg },
            };
          }
        },
      });
    }

    if (!api.registerService) {
      api.logger.warn("a2a-gateway: registerService is unavailable; HTTP endpoints are not started");
      return;
    }

    api.registerService({
      id: "a2a-gateway",
      async start(_ctx) {
        if (server) {
          return;
        }

        // Start DNS-SD discovery (if enabled).
        // When quorum config is present, the QuorumDiscoveryManager wraps the
        // DNS manager and controls polling frequency adaptively; otherwise
        // the DNS manager runs at a fixed interval.
        if (quorumManager) {
          quorumManager.start();
        } else {
          discoveryManager?.start();
        }

        // Start peer health checks
        healthManager?.start();

        // Start HTTP server (JSON-RPC + REST)
        await new Promise<void>((resolve, reject) => {
          server = app.listen(config.server.port, config.server.host, () => {
            api.logger.info(
              `a2a-gateway: HTTP listening on ${config.server.host}:${config.server.port}`
            );
            api.logger.info(
              `a2a-gateway: durable task store at ${config.storage.tasksDir}; concurrency=${config.limits.maxConcurrentTasks}; queue=${config.limits.maxQueuedTasks}`
            );
            resolve();
          });

          server!.once("error", reject);
        });

        // Start embedded tunnel AFTER local HTTP is listening (inbound forwards need it)
        if (tunnelSession) {
          try {
            await tunnelSession.start();
            client.setTunnel(tunnelSession);
            api.logger.info(
              `a2a-gateway: tunnel enabled deviceId=${config.tunnel!.deviceId} relay=${config.tunnel!.relayUrl}`,
            );
          } catch (tunnelErr: unknown) {
            const msg = tunnelErr instanceof Error ? tunnelErr.message : String(tunnelErr);
            api.logger.error(`a2a-gateway: tunnel failed to start: ${msg}`);
            throw tunnelErr;
          }
        }

        // Register with cloud Agent Registry, then start periodic discovery
        if (registryClient && config.registry?.enabled) {
          try {
            if (config.registry.registerOnStart) {
              await registryClient.ensureDataset();
              await registryClient.registerA2a(agentCard as unknown as Record<string, unknown>, true);
            }
            registryClient.start();
            api.logger.info(
              `a2a-gateway: registry enabled serviceId=${config.registry.serviceId} base=${config.registry.baseUrl} dataset=${config.registry.dataset}`,
            );
          } catch (regErr: unknown) {
            const msg = regErr instanceof Error ? regErr.message : String(regErr);
            api.logger.warn(`a2a-gateway: registry startup failed (continuing): ${msg}`);
            // Still start discovery so a later refresh can recover
            registryClient.start();
          }
        }

        // Start gRPC server
        try {
          grpcServer = new GrpcServer();
          const grpcUserBuilder = async (
            call: { metadata?: { get: (key: string) => unknown[] } } | unknown,
          ) => {
            if (config.security.inboundAuth === "bearer" && config.security.validTokens.size > 0) {
              const meta = (call as any)?.metadata;
              const values = meta?.get?.("authorization") || meta?.get?.("Authorization") || [];
              const header = Array.isArray(values) && values.length > 0 ? String(values[0]) : "";
              const providedToken = header.startsWith("Bearer ") ? header.slice(7) : "";
              if (!providedToken || !config.security.validTokens.has(providedToken)) {
                telemetry.recordSecurityRejection("grpc", "invalid or missing bearer token");
                auditLogger.recordSecurityEvent("grpc", "invalid or missing bearer token");
                const err: any = new Error("Unauthorized: invalid or missing bearer token");
                err.code = GrpcStatus.UNAUTHENTICATED;
                throw err;
              }
            }
            return GrpcUserBuilder.noAuthentication();
          };

          grpcServer.addService(
            A2AService,
            grpcService({ requestHandler, userBuilder: grpcUserBuilder as any })
          );

          await new Promise<void>((resolve, reject) => {
            grpcServer!.bindAsync(
              `${config.server.host}:${grpcPort}`,
              ServerCredentials.createInsecure(),
              (error) => {
                if (error) {
                  api.logger.warn(`a2a-gateway: gRPC failed to start: ${error.message}`);
                  grpcServer = null;
                  resolve(); // Non-fatal: HTTP still works
                  return;
                }
                try {
                  grpcServer!.start();
                } catch {
                  // ignore: some grpc-js versions auto-start
                }
                api.logger.info(
                  `a2a-gateway: gRPC listening on ${config.server.host}:${grpcPort}`
                );
                resolve();
              }
            );
          });
        } catch (grpcError: unknown) {
          const msg = grpcError instanceof Error ? grpcError.message : String(grpcError);
          api.logger.warn(`a2a-gateway: gRPC init failed: ${msg}`);
          grpcServer = null;
        }

        // Recover tasks stuck in non-terminal states from a previous run
        await recoverStaleTasks(taskStore, api.logger);

        // Start task TTL cleanup
        const ttlMs = config.storage.taskTtlHours * 3_600_000;
        const intervalMs = config.storage.cleanupIntervalMinutes * 60_000;

        const doCleanup = () => {
          void runTaskCleanup(taskStore, ttlMs, telemetry, api.logger);
        };

        // Run once at startup to clear any backlog
        doCleanup();
        cleanupTimer = setInterval(doCleanup, intervalMs);

        api.logger.info(
          `a2a-gateway: task cleanup enabled — ttl=${config.storage.taskTtlHours}h interval=${config.storage.cleanupIntervalMinutes}min`,
        );

        // Start mDNS self-advertisement (after HTTP is listening)
        mdnsResponder?.start();
      },
      async stop(_ctx) {
        // Stop mDNS self-advertisement (sends goodbye packet)
        mdnsResponder?.stop();

        // Stop DNS-SD discovery (quorum manager stops the underlying DNS manager)
        if (quorumManager) {
          quorumManager.stop();
        } else {
          discoveryManager?.stop();
        }

        registryClient?.stop();
        registryClient = null;

        // Stop peer health checks
        healthManager?.stop();

        // Stop tunnel before tearing down HTTP (no more inbound forwards)
        if (tunnelSession) {
          await tunnelSession.stop();
          client.setTunnel(null);
          tunnelSession = null;
        }

        auditLogger.close();
        client.destroy();

        // Stop task cleanup timer
        if (cleanupTimer) {
          clearInterval(cleanupTimer);
          cleanupTimer = null;
        }

        // Stop gRPC server
        if (grpcServer) {
          grpcServer.forceShutdown();
          grpcServer = null;
        }

        // Stop HTTP server
        if (!server) {
          return;
        }

        await new Promise<void>((resolve, reject) => {
          const activeServer = server!;
          server = null;
          activeServer.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        });
      },
    });
  },
};

export default plugin;
