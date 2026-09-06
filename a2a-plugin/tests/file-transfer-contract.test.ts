import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  deriveChannelName,
  newAttemptId,
  newTransferId,
  newTransferTicket,
  safeTransferName,
  validateFileOffer,
  TransferError,
  type FileTransferConfig,
} from "../src/file-transfer-types.js";
import {
  intersectTransports,
  isPreStartTransportFailure,
  listTransportCandidates,
  localCapability,
  parseFileTransferMode,
  parseOpenclawFileTransferCapability,
  peerCapabilityFromAgentCard,
  selectTransport,
} from "../src/file-transfer-capability.js";
import {
  FileTransferStore,
  commitPartNoClobber,
  createTransferRecord,
  resolveCommittedTransferUriSync,
} from "../src/file-transfer-store.js";
import { buildAgentCard } from "../src/agent-card.js";
import type { GatewayConfig } from "../src/types.js";

function baseConfig(over: Partial<FileTransferConfig> = {}): FileTransferConfig {
  return {
    enabled: true,
    mode: "auto",
    host: "relay",
    port: 8001,
    serverName: "a2a-file.invalid",
    receiveDir: "/tmp",
    maxFileSizeBytes: 100 * 1024 * 1024,
    maxConcurrentReceives: 2,
    maxInFlightBytes: 200 * 1024 * 1024,
    connectTimeoutMs: 1000,
    transferTimeoutMs: 10000,
    inlinePreferredBelowBytes: 1024 * 1024,
    ...over,
  };
}

describe("file-transfer contract", () => {
  it("derives stable channel names from ticket+ids", () => {
    const ticket = newTransferTicket();
    const transferId = newTransferId();
    const attemptId = newAttemptId();
    const a = deriveChannelName(ticket, transferId, attemptId);
    const b = deriveChannelName(ticket, transferId, attemptId);
    assert.equal(a, b);
    assert.match(a, /^c[A-Za-z0-9._-]{10,120}$/);
    assert.notEqual(
      deriveChannelName(ticket, transferId, attemptId),
      deriveChannelName(ticket, transferId, newAttemptId()),
    );
  });

  it("rejects expired offers", () => {
    assert.throws(
      () => validateFileOffer({
        transferId: "a2a-1",
        ticket: "a".repeat(32),
        sourceDevice: "HW-A",
        targetDevice: "HW-B",
        name: "x.bin",
        mimeType: "application/octet-stream",
        size: 1,
        sha256: "a".repeat(64),
        expiresAt: Date.now() - 1000,
      }, 100),
      (err: unknown) => err instanceof TransferError && err.category === "POLICY_REJECTED",
    );
  });

  it("parses mode aliases", () => {
    assert.equal(parseFileTransferMode("auto"), "auto");
    assert.equal(parseFileTransferMode("quic-v7"), "quic");
    assert.equal(parseFileTransferMode("tcp-v1"), "tcp");
    assert.equal(parseFileTransferMode("inline"), "base64");
  });

  it("auto prefers quic when both sides advertise it and binary exists", () => {
    const bin = path.join(os.tmpdir(), `a2a-fake-rcp-${process.pid}`);
    fs.writeFileSync(bin, "#!/bin/true\n");
    try {
      const config = baseConfig({
        quic: {
          enabled: true,
          binary: bin,
          extraEnv: {},
          relayHost: "relay",
          relayPort: 8008,
          connectTimeoutMs: 1000,
          transferTimeoutMs: 10000,
          stallTimeoutMs: 1000,
        },
      });
      const remote = parseOpenclawFileTransferCapability({
        openclawFileTransfer: {
          version: 1,
          transports: ["quic-v7", "tcp-v1", "inline-base64"],
          maxStreamBytes: 100 * 1024 * 1024,
        },
      });
      assert.equal(selectTransport({
        config,
        size: 10 * 1024 * 1024,
        maxInlineBytes: 50 * 1024 * 1024,
        peerName: "phone",
        remote,
      }), "quic-v7");
    } finally {
      fs.rmSync(bin, { force: true });
    }
  });

  it("auto uses inline for small files even when quic is available", () => {
    const config = baseConfig({
      inlinePreferredBelowBytes: 1024,
      quic: {
        enabled: true,
        binary: "/nonexistent-rcp-binary",
        extraEnv: {},
        relayHost: "relay",
        relayPort: 8008,
        connectTimeoutMs: 1000,
        transferTimeoutMs: 1000,
        stallTimeoutMs: 1000,
      },
    });
    assert.equal(selectTransport({
      config,
      size: 100,
      maxInlineBytes: 50 * 1024 * 1024,
      peerName: "anyone",
      remote: {
        transports: ["quic-v7", "tcp-v1", "inline-base64"],
      },
    }), "inline-base64");
  });

  it("legacy peer (no Card block) only gets inline; large file fails under mode=tcp", () => {
    const config = baseConfig({ mode: "tcp" });
    assert.deepEqual(listTransportCandidates({
      config,
      size: 10,
      maxInlineBytes: 50 * 1024 * 1024,
      peerName: "legacy",
      remote: null,
    }), []);
    assert.equal(selectTransport({
      config: baseConfig({ mode: "auto", inlinePreferredBelowBytes: 1024 }),
      size: 100,
      maxInlineBytes: 50 * 1024 * 1024,
      peerName: "legacy",
      remote: null,
    }), "inline-base64");
  });

  it("mode=base64 refuses oversized files", () => {
    assert.deepEqual(listTransportCandidates({
      config: baseConfig({ mode: "base64" }),
      size: 60 * 1024 * 1024,
      maxInlineBytes: 50 * 1024 * 1024,
      peerName: "x",
      remote: { transports: ["inline-base64", "tcp-v1"], maxInlineBytes: 50 * 1024 * 1024 },
    }), []);
  });

  it("falls back to tcp when remote has no quic", () => {
    const config = baseConfig({ mode: "auto", inlinePreferredBelowBytes: 1024 });
    assert.equal(selectTransport({
      config,
      size: 5 * 1024 * 1024,
      maxInlineBytes: 50 * 1024 * 1024,
      peerName: "phone",
      remote: { transports: ["tcp-v1", "inline-base64"] },
    }), "tcp-v1");
  });

  it("detects pre-start prepare failures for auto candidate switch", () => {
    assert.equal(isPreStartTransportFailure("Receiver prepare failed (404): missing"), true);
    assert.equal(isPreStartTransportFailure("File data committed, but A2A notification failed"), false);
  });

  it("intersects transports and keeps legacy peers on inline only", () => {
    const local = localCapability(baseConfig({
      quic: {
        enabled: true,
        binary: "/nonexistent",
        extraEnv: {},
        relayHost: "x",
        relayPort: 8008,
        connectTimeoutMs: 1,
        transferTimeoutMs: 1,
        stallTimeoutMs: 1,
      },
    }), 1024);
    assert.deepEqual(intersectTransports(local, null), ["inline-base64"]);
    assert.ok(local.transports.includes("tcp-v1"));
    assert.ok(!local.transports.includes("quic-v7"));
  });

  it("Agent Card omits quic-v7 when helper binary is missing", () => {
    const gw = {
      agentCard: { name: "T", skills: [] },
      server: { host: "127.0.0.1", port: 18800 },
      security: {
        inboundAuth: "none",
        allowedMimeTypes: ["*/*"],
        maxFileSizeBytes: 1,
        maxInlineFileSizeBytes: 1024,
        fileUriAllowlist: [],
        validTokens: new Set<string>(),
      },
      fileTransfer: baseConfig({
        quic: {
          enabled: true,
          binary: "/no/such/rcp",
          extraEnv: {},
          relayHost: "x",
          relayPort: 8008,
          connectTimeoutMs: 1,
          transferTimeoutMs: 1,
          stallTimeoutMs: 1,
        },
      }),
      tunnel: { enabled: true, relayUrl: "ws://x:8001", deviceId: "dev-1" },
    } as unknown as GatewayConfig;
    const card = buildAgentCard(gw);
    const cap = peerCapabilityFromAgentCard(card);
    assert.ok(cap);
    assert.ok(cap!.transports.includes("tcp-v1"));
    assert.ok(cap!.transports.includes("inline-base64"));
    assert.ok(!cap!.transports.includes("quic-v7"));
  });

  it("persists transfer records and resolves a2a-transfer URIs", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "a2a-ft-"));
    const config = { receiveDir: dir };
    const store = new FileTransferStore(config);
    const offer = {
      transferId: "a2a-contract-1",
      attemptId: "att-1",
      transport: "tcp-v1" as const,
      ticket: "b".repeat(32),
      sourceDevice: "HW-A",
      targetDevice: "HW-B",
      name: "demo.bin",
      mimeType: "application/octet-stream",
      size: 4,
      sha256: createHashHex("demo"),
    };
    const part = path.join(dir, `.${offer.transferId}.part`);
    fs.writeFileSync(part, "demo");
    const record = createTransferRecord(offer, part);
    await store.save(record);
    const finalPath = await commitPartNoClobber(dir, offer.name, part, async () => undefined);
    record.state = "DATA_COMMITTED";
    record.path = finalPath;
    record.partPath = undefined;
    await store.save(record);
    const resolved = resolveCommittedTransferUriSync(
      config,
      `a2a-transfer://${offer.transferId}`,
      offer.name,
      offer.mimeType,
    );
    assert.ok(resolved);
    assert.equal(resolved!.size, 4);
    assert.equal(safeTransferName("a/../x|.bin"), "x_.bin");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

function createHashHex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
