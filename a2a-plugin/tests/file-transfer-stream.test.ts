import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { parseConfig } from "../index.js";
import {
  commitPartNoClobber,
  createTransferRecord,
  FileTransferStore,
  inspectFile,
  newTransferId,
  newTransferTicket,
  resolveCommittedTransferUriSync,
  type FileOffer,
} from "../src/file-transfer.js";

describe("TLS/TCP file transfer primitives", () => {
  it("creates relay-safe unique identifiers and 256-bit tickets", () => {
    const first = newTransferId();
    const second = newTransferId();
    assert.match(first, /^[A-Za-z0-9._-]+$/);
    assert.notEqual(first, second);
    assert.match(newTransferTicket(), /^[A-Za-z0-9_-]{43}$/);
  });

  it("hashes a file without base64 and enforces the configured size cap", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "a2a-tcp-file-"));
    const file = path.join(dir, "payload.bin");
    const bytes = Buffer.from("streamed-file-payload");
    await fs.promises.writeFile(file, bytes);
    try {
      const inspected = await inspectFile(file, bytes.length);
      assert.equal(inspected.size, bytes.length);
      assert.equal(inspected.sha256, createHash("sha256").update(bytes).digest("hex"));
      await assert.rejects(() => inspectFile(file, bytes.length - 1), /maxFileSizeBytes/);
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });

  it("parses an opt-in fileTransfer configuration", () => {
    const config = parseConfig({
      fileTransfer: {
        enabled: true,
        mode: "auto",
        host: "121.37.53.35",
        port: 8001,
        serverName: "a2a-file.invalid",
        certificateSha256: "aa".repeat(32),
        receiveDir: "/data/local/tmp/a2a-received",
        maxFileSizeBytes: 123456,
        maxConcurrentReceives: 3,
        maxInFlightBytes: 654321,
        quic: {
          binary: "/data/local/tmp/a2a-rcp/rcp-raw-stream-v7",
        },
      },
    });
    assert.equal(config.fileTransfer?.enabled, true);
    assert.equal(config.fileTransfer?.mode, "auto");
    assert.equal(config.fileTransfer?.host, "121.37.53.35");
    assert.equal(config.fileTransfer?.port, 8001);
    assert.equal(config.fileTransfer?.maxFileSizeBytes, 123456);
    assert.equal(config.fileTransfer?.maxConcurrentReceives, 3);
    assert.equal(config.fileTransfer?.maxInFlightBytes, 654321);
    assert.equal(config.fileTransfer?.quic?.relayHost, "121.37.53.35");
    assert.equal(config.fileTransfer?.quic?.relayPort, 8008);
  });

  it("commits without overwriting an existing same-name file", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "a2a-tcp-commit-"));
    const existing = path.join(dir, "report.txt");
    const part = path.join(dir, ".transfer.part");
    await fs.promises.writeFile(existing, "keep-me");
    await fs.promises.writeFile(part, "new-file");
    try {
      const committed = await commitPartNoClobber(dir, "report.txt", part, async () => undefined);
      assert.equal(path.basename(committed), "report (1).txt");
      assert.equal(await fs.promises.readFile(existing, "utf8"), "keep-me");
      assert.equal(await fs.promises.readFile(committed, "utf8"), "new-file");
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps the part file through multiple filename collisions", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "a2a-tcp-collisions-"));
    const part = path.join(dir, ".transfer.part");
    await fs.promises.writeFile(path.join(dir, "report.txt"), "first");
    await fs.promises.writeFile(path.join(dir, "report (1).txt"), "second");
    await fs.promises.writeFile(path.join(dir, "report (2).txt"), "third");
    await fs.promises.writeFile(part, "new-file");
    const attempted: string[] = [];
    let linkedCandidate = "";
    try {
      const committed = await commitPartNoClobber(dir, "report.txt", part, async (candidate) => {
        attempted.push(path.basename(candidate));
        assert.equal(await fs.promises.readFile(part, "utf8"), "new-file");
      }, (candidate) => {
        linkedCandidate = path.basename(candidate);
      });
      assert.equal(path.basename(committed), "report (3).txt");
      assert.equal(linkedCandidate, "report (3).txt");
      assert.deepEqual(attempted, ["report.txt", "report (1).txt", "report (2).txt", "report (3).txt"]);
      assert.equal(await fs.promises.readFile(committed, "utf8"), "new-file");
      await assert.rejects(() => fs.promises.stat(part), /ENOENT/);
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });

  it("recovers interrupted state and resolves only durably committed transfer URIs", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "a2a-tcp-state-"));
    const store = new FileTransferStore({ receiveDir: dir });
    const bytes = Buffer.from("durable-payload");
    const makeOffer = (transferId: string): FileOffer => ({
      transferId,
      ticket: newTransferTicket(),
      sourceDevice: "sender",
      targetDevice: "receiver",
      name: "payload.bin",
      mimeType: "application/octet-stream",
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    try {
      const interruptedOffer = makeOffer("interrupted-transfer");
      const interruptedPart = path.join(dir, ".interrupted.part");
      await fs.promises.writeFile(interruptedPart, bytes);
      await store.save(createTransferRecord(interruptedOffer, interruptedPart));
      assert.equal(await store.recoverInterrupted(), 1);
      assert.equal((await store.load(interruptedOffer.transferId))?.state, "FAILED_CONFIRMED");
      await assert.rejects(() => fs.promises.stat(interruptedPart), /ENOENT/);

      const collisionOffer = makeOffer("collision-transfer");
      const collisionPart = path.join(dir, ".collision.part");
      const collisionPath = path.join(dir, "existing-user-file.bin");
      await fs.promises.writeFile(collisionPart, bytes);
      await fs.promises.writeFile(collisionPath, Buffer.alloc(bytes.length, 0x78));
      const collisionRecord = createTransferRecord(collisionOffer, collisionPart);
      collisionRecord.state = "COMMITTING";
      collisionRecord.path = collisionPath;
      await store.save(collisionRecord);
      assert.equal(await store.recoverInterrupted(), 1);
      assert.deepEqual(await fs.promises.readFile(collisionPath), Buffer.alloc(bytes.length, 0x78));
      assert.equal((await store.load(collisionOffer.transferId))?.state, "FAILED_CONFIRMED");

      const committedOffer = makeOffer("committed-transfer");
      const committedPath = path.join(dir, committedOffer.name);
      await fs.promises.writeFile(committedPath, bytes);
      const committed = createTransferRecord(committedOffer);
      committed.state = "DATA_COMMITTED";
      committed.path = committedPath;
      await store.save(committed);
      const resolved = resolveCommittedTransferUriSync(
        { receiveDir: dir },
        `a2a-transfer://${committedOffer.transferId}`,
        committedOffer.name,
        committedOffer.mimeType,
      );
      assert.equal(resolved?.path, committedPath);
      assert.equal((await store.load(committedOffer.transferId))?.state, "COMPLETED");
      assert.equal(resolveCommittedTransferUriSync(
        { receiveDir: dir },
        "a2a-transfer://unknown-transfer",
      ), null);
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });
});
