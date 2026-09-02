import type {
  FileOffer,
  FileTransferConfig,
  TransportName,
} from "./file-transfer-types.js";

export interface PeerCapability {
  transports: TransportName[];
  maxStreamBytes?: number;
  maxInlineBytes?: number;
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

export function localCapability(config: FileTransferConfig, maxInlineBytes: number): PeerCapability {
  const transports: TransportName[] = ["inline-base64"];
  if (config.enabled) transports.push("tcp-v1");
  if (config.quic?.enabled && config.quic.binary) transports.push("quic-v7");
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

/**
 * Choose transport for a file. tcp-v1 auto-select requires config.order to include it
 * AND quic not preferred; first release keeps tcp as the explicit streaming default when
 * quic is not enabled, matching deployed 1.5.x devices.
 */
export function selectTransport(params: {
  config: FileTransferConfig;
  size: number;
  maxInlineBytes: number;
  peerName: string;
  remote: PeerCapability | null;
  forced?: TransportName;
}): TransportName {
  if (params.forced) return params.forced;
  const preferredInline = params.config.inlinePreferredBelowBytes ?? 1024 * 1024;
  if (params.size <= preferredInline) return "inline-base64";

  const available = intersectTransports(
    localCapability(params.config, params.maxInlineBytes),
    params.remote,
  );
  const autoPeers = params.config.autoPeers || [];
  const peerAllowed = autoPeers.length === 0 || autoPeers.includes(params.peerName);
  const order = params.config.order?.length
    ? params.config.order
    : (["quic-v7", "tcp-v1", "inline-base64"] as TransportName[]);

  if (!peerAllowed) {
    if (params.size <= params.maxInlineBytes) return "inline-base64";
    throw new Error(`peer ${params.peerName} is not in fileTransfer.autoPeers and file exceeds inline limit`);
  }

  for (const name of order) {
    if (!available.includes(name)) continue;
    if (name === "inline-base64") {
      if (params.size <= params.maxInlineBytes) return name;
      continue;
    }
    if (name === "quic-v7" && params.config.quic?.enabled) return name;
    if (name === "tcp-v1" && params.config.enabled) return name;
  }
  if (params.size <= params.maxInlineBytes) return "inline-base64";
  throw new Error("no available file transport for this peer/size");
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
