import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { parseConfig } from "../index.js";
import { inspectFile, newTransferId, newTransferTicket } from "../src/file-transfer.js";

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
        host: "121.37.53.35",
        port: 8001,
        serverName: "a2a-file.invalid",
        certificateSha256: "aa".repeat(32),
        receiveDir: "/data/local/tmp/a2a-received",
        maxFileSizeBytes: 123456,
      },
    });
    assert.equal(config.fileTransfer?.enabled, true);
    assert.equal(config.fileTransfer?.host, "121.37.53.35");
    assert.equal(config.fileTransfer?.port, 8001);
    assert.equal(config.fileTransfer?.maxFileSizeBytes, 123456);
  });
});
