import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

import {
  inspectFile,
  newTransferId,
  newTransferTicket,
  sendFilePayload,
  startFileReceive,
  type FileOffer,
  type FileTransferConfig,
} from "../src/file-transfer.js";

const [host, portRaw, serverName, certificateSha256, inputPath, receiveDir] = process.argv.slice(2);
if (!host || !portRaw || !serverName || !certificateSha256 || !inputPath || !receiveDir) {
  throw new Error("usage: tsx file-transfer-smoke.ts HOST PORT SERVER_NAME CERT_SHA256 INPUT RECEIVE_DIR");
}
const config: FileTransferConfig = {
  enabled: true,
  host,
  port: Number(portRaw),
  serverName,
  certificateSha256,
  receiveDir,
  maxFileSizeBytes: 1024 * 1024 * 1024,
  connectTimeoutMs: 15_000,
  transferTimeoutMs: 120_000,
};
const inspected = await inspectFile(inputPath, config.maxFileSizeBytes);
const offer: FileOffer = {
  transferId: newTransferId(),
  ticket: newTransferTicket(),
  sourceDevice: "smoke-sender",
  targetDevice: "smoke-receiver",
  name: path.basename(inputPath),
  mimeType: "application/octet-stream",
  ...inspected,
};
const receive = startFileReceive(config, offer);
const controlStarted = performance.now();
await receive.ready;
const controlPrepareMs = performance.now() - controlStarted;
const sent = await sendFilePayload(config, offer, inputPath, controlPrepareMs);
const received = await receive.completed;
if (sent.sha256 !== received.sha256 || sent.size !== received.size) throw new Error("smoke integrity mismatch");
process.stdout.write(`${JSON.stringify({ sent, received })}\n`);
await fs.promises.rm(received.path, { force: true });
