import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const PEERS_FILE = join(homedir(), ".openclaw", "a2a-peers.json");

export interface PeerEntry {
  url: string;
  token: string;
}

type PeersConfig = Record<string, string | { url: string; token?: string }>;

export function loadPeers(): PeersConfig {
  let raw: string;
  try {
    raw = readFileSync(PEERS_FILE, "utf-8");
  } catch {
    return {};
  }
  try {
    return JSON.parse(raw) as PeersConfig;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse ${PEERS_FILE}: ${msg}`);
  }
}

export function resolvePeer(name: string): PeerEntry {
  const peers = loadPeers();
  const entry = peers[name];
  if (!entry) {
    const available = Object.keys(peers);
    const hint =
      available.length > 0
        ? `Available peers: ${available.join(", ")}`
        : `No peers configured. Create ${PEERS_FILE}`;
    throw new Error(`Unknown peer "${name}". ${hint}`);
  }
  return {
    url: typeof entry === "string" ? entry : entry.url,
    token: typeof entry === "object" ? entry.token ?? "" : "",
  };
}

/**
 * Resolve a CLI target to { url, token }.
 * If target starts with http(s)://, treat as URL.
 * Otherwise, resolve as peer alias.
 */
export function resolveTarget(
  target: string,
  tokenOverride?: string,
): PeerEntry {
  if (target.startsWith("http://") || target.startsWith("https://")) {
    return {
      url: target,
      token: tokenOverride ?? process.env.A2A_TOKEN ?? "",
    };
  }

  const peer = resolvePeer(target);
  return {
    url: peer.url,
    token: tokenOverride ?? peer.token ?? process.env.A2A_TOKEN ?? "",
  };
}
