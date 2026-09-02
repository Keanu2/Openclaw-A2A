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
} from "../src/file-transfer-types.js";
import {
  intersectTransports,
  localCapability,
  parseOpenclawFileTransferCapability,
  selectTransport,
} from "../src/file-transfer-capability.js";
import {
  FileTransferStore,
  commitPartNoClobber,
  createTransferRecord,
  resolveCommittedTransferUriSync,
} from "../src/file-transfer-store.js";
import type { FileTransferConfig } from "../src/file-transfer-types.js";

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

  it("selects quic when enabled and peer allows", () => {
    const config: FileTransferConfig = {
      enabled: true,
      host: "relay",
      port: 8001,
      serverName: "a2a-file.invalid",
      receiveDir: "/tmp",
      maxFileSizeBytes: 100 * 1024 * 1024,
      maxConcurrentReceives: 2,
      maxInFlightBytes: 200 * 1024 * 1024,
      connectTimeoutMs: 1000,
      transferTimeoutMs: 10000,
      autoPeers: ["phone"],
      quic: {
        enabled: true,
        binary: "/bin/true",
        extraEnv: {},
        relayHost: "relay",
        relayPort: 8008,
        connectTimeoutMs: 1000,
        transferTimeoutMs: 10000,
        stallTimeoutMs: 1000,
      },
    };
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
  });

  it("falls back to inline for small files", () => {
    const config: FileTransferConfig = {
      enabled: true,
      host: "relay",
      port: 8001,
      serverName: "x",
      receiveDir: "/tmp",
      maxFileSizeBytes: 100,
      maxConcurrentReceives: 1,
      maxInFlightBytes: 100,
      connectTimeoutMs: 1000,
      transferTimeoutMs: 1000,
      inlinePreferredBelowBytes: 1024,
    };
    assert.equal(selectTransport({
      config,
      size: 100,
      maxInlineBytes: 50 * 1024 * 1024,
      peerName: "anyone",
      remote: null,
    }), "inline-base64");
  });

  it("intersects transports and keeps legacy peers on inline only", () => {
    const local = localCapability({
      enabled: true,
      host: "x",
      port: 1,
      serverName: "x",
      receiveDir: "/tmp",
      maxFileSizeBytes: 10,
      maxConcurrentReceives: 1,
      maxInFlightBytes: 10,
      connectTimeoutMs: 1,
      transferTimeoutMs: 1,
      quic: {
        enabled: true,
        binary: "/bin/true",
        extraEnv: {},
        relayHost: "x",
        relayPort: 8008,
        connectTimeoutMs: 1,
        transferTimeoutMs: 1,
        stallTimeoutMs: 1,
      },
    }, 1024);
    assert.deepEqual(intersectTransports(local, null), ["inline-base64"]);
    assert.ok(local.transports.includes("quic-v7"));
    assert.ok(local.transports.includes("tcp-v1"));
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
