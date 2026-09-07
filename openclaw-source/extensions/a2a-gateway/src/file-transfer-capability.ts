import fs from "node:fs";

import type {
  FileOffer,
  FileTransferConfig,
  FileTransferMode,
  TransportName,
} from "./file-transfer-types.js";

export interface PeerCapability {
  transports: TransportName[];
  maxStreamBytes?: number;
  maxInlineBytes?: number;
}

const KNOWN_TRANSPORTS: TransportName[] = ["inline-base64", "quic-v7", "tcp-v1"];

export function isQuicBinaryAvailable(binary?: string): boolean {
  const path = typeof binary === "string" ? binary.trim() : "";
  if (!path) return false;
  try {
    fs.accessSync(path, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export function parseFileTransferMode(value: unknown, fallback: FileTransferMode = "auto"): FileTransferMode {
  if (value === "auto" || value === "quic" || value === "tcp" || value === "base64") return value;
  // Legacy aliases
  if (value === "quic-v7") return "quic";
  if (value === "tcp-v1") return "tcp";
  if (value === "inline-base64" || value === "inline") return "base64";
  return fallback;
}

export function parseOpenclawFileTransferCapability(metadata: unknown): PeerCapability | null {
  if (!metadata || typeof metadata !== "object") return null;
  const block = (metadata as Record<string, unknown>).openclawFileTransfer;
  if (!block || typeof block !== "object") return null;
  const obj = block as Record<string, unknown>;
  const transports = Array.isArray(obj.transports)
    ? obj.transports.filter((t): t is TransportName =>
      t === "inline-base64" || t === "quic-v7" || t === "tcp-v1")
    : [];
  if (transports.length === 0) return null;
  return {
    transports,
    maxStreamBytes: typeof obj.maxStreamBytes === "number" ? obj.maxStreamBytes : undefined,
    maxInlineBytes: typeof obj.maxInlineBytes === "number" ? obj.maxInlineBytes : undefined,
  };
}

/** Capability from a full Agent Card object (or empty → legacy). */
export function peerCapabilityFromAgentCard(agentCard: unknown): PeerCapability | null {
  if (!agentCard || typeof agentCard !== "object") return null;
  const meta = (agentCard as Record<string, unknown>).metadata;
  return parseOpenclawFileTransferCapability(meta ?? null);
}

export function localCapability(config: FileTransferConfig, maxInlineBytes: number): PeerCapability {
  const transports: TransportName[] = ["inline-base64"];
  if (config.enabled && config.host) transports.push("tcp-v1");
  if (config.enabled && isQuicBinaryAvailable(config.quic?.binary)) transports.push("quic-v7");
  return {
    transports,
    maxStreamBytes: config.maxFileSizeBytes,
    maxInlineBytes,
  };
}

export function intersectTransports(local: PeerCapability, remote: PeerCapability | null): TransportName[] {
  if (!remote) return ["inline-base64"];
  return local.transports.filter((t) => remote.transports.includes(t));
}

function autoOrder(config: FileTransferConfig): TransportName[] {
  if (config.order?.length) {
    return config.order.filter((t) => KNOWN_TRANSPORTS.includes(t));
  }
  return ["quic-v7", "tcp-v1", "inline-base64"];
}

/**
 * Ordered candidates for a send. Card intersection + mode; no post-start fallback.
 * Missing remote capability → legacy inline-only.
 */
export function listTransportCandidates(params: {
  config: FileTransferConfig;
  size: number;
  maxInlineBytes: number;
  peerName: string;
  remote: PeerCapability | null;
  forced?: TransportName;
}): TransportName[] {
  if (params.forced) return [params.forced];

  const mode = params.config.mode ?? "auto";
  const remoteMaxInline = params.remote?.maxInlineBytes ?? params.maxInlineBytes;
  const effectiveInlineMax = Math.min(params.maxInlineBytes, remoteMaxInline);
  const preferredInline = params.config.inlinePreferredBelowBytes ?? 1024 * 1024;

  const available = intersectTransports(
    localCapability(params.config, params.maxInlineBytes),
    params.remote,
  );

  const autoPeers = params.config.autoPeers || [];
  if (autoPeers.length > 0 && !autoPeers.includes(params.peerName)) {
    if (params.size <= effectiveInlineMax && available.includes("inline-base64")) {
      return ["inline-base64"];
    }
    return [];
  }

  if (mode === "quic") {
    return available.includes("quic-v7") ? ["quic-v7"] : [];
  }
  if (mode === "tcp") {
    return available.includes("tcp-v1") ? ["tcp-v1"] : [];
  }
  if (mode === "base64") {
    if (available.includes("inline-base64") && params.size <= effectiveInlineMax) {
      return ["inline-base64"];
    }
    return [];
  }

  // auto
  if (params.size <= preferredInline && available.includes("inline-base64")) {
    return ["inline-base64"];
  }

  const out: TransportName[] = [];
  for (const name of autoOrder(params.config)) {
    if (!available.includes(name)) continue;
    if (name === "inline-base64") {
      if (params.size <= effectiveInlineMax) out.push(name);
      continue;
    }
    out.push(name);
  }
  return out;
}

export function selectTransport(params: {
  config: FileTransferConfig;
  size: number;
  maxInlineBytes: number;
  peerName: string;
  remote: PeerCapability | null;
  forced?: TransportName;
}): TransportName {
  const candidates = listTransportCandidates(params);
  if (candidates.length === 0) {
    const mode = params.config.mode ?? "auto";
    if (!params.remote) {
      throw new Error(
        `peer ${params.peerName} has no openclawFileTransfer capability (legacy); ` +
        `only inline-base64 is assumed and this file exceeds the inline limit or mode=${mode} forbids it`,
      );
    }
    throw new Error(`no available file transport for peer ${params.peerName} (mode=${mode})`);
  }
  return candidates[0]!;
}

export function ensureOfferAttempt(offer: FileOffer, transport: TransportName, attemptId: string): FileOffer {
  return {
    ...offer,
    version: 1,
    transport,
    attemptId,
    expiresAt: offer.expiresAt ?? Date.now() + 30 * 60 * 1000,
  };
}

/** Prepare failed before any payload — safe to try next candidate under auto. */
export function isPreStartTransportFailure(error: string): boolean {
  const msg = String(error || "").toLowerCase();
  if (/data committed|ambiguous|committing|do not retry|already committed/.test(msg)) return false;
  if (/prepare failed \(404\)|prepare failed \(501\)|prepare failed \(405\)|prepare failed \(400\)/.test(msg)) {
    return true;
  }
  if (/unsupported|not enabled|not available|no available file transport/.test(msg)) return true;
  if (/quic-v7 is not enabled|tcp-v1|receiver prepare failed/.test(msg) && /404|501|unsupported/.test(msg)) {
    return true;
  }
  return /prepare failed/.test(msg) && /\(404\)|\(501\)|\(405\)/.test(msg);
}
