import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import tls, { type TLSSocket } from "node:tls";

export interface FileTransferConfig {
  enabled: boolean;
  host: string;
  port: number;
  serverName: string;
  certificateSha256?: string;
  receiveDir: string;
  maxFileSizeBytes: number;
  connectTimeoutMs: number;
  transferTimeoutMs: number;
}

export interface FileOffer {
  transferId: string;
  ticket: string;
  sourceDevice: string;
  targetDevice: string;
  name: string;
  mimeType: string;
  size: number;
  sha256: string;
}

export interface ReceiveResult {
  ok: true;
  transferId: string;
  path: string;
  name: string;
  size: number;
  sha256: string;
  receiverDownloadMs: number;
  receiverVerifyMs: number;
}

export interface SendResult extends ReceiveResult {
  controlPrepareMs: number;
  senderSetupMs: number;
  senderPayloadMs: number;
  senderAckWaitMs: number;
  transferMs: number;
}

type ReadyReceive = {
  ready: Promise<void>;
  completed: Promise<ReceiveResult>;
};

const nowMs = () => Number(process.hrtime.bigint()) / 1e6;

function normalizeFingerprint(value?: string): string {
  return String(value || "").toLowerCase().replace(/[^a-f0-9]/g, "");
}

function validateOffer(offer: FileOffer, maxBytes: number): void {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(offer.transferId)) throw new Error("invalid transferId");
  if (!/^[a-f0-9]{64}$/.test(offer.sha256)) throw new Error("invalid sha256");
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(offer.ticket)) throw new Error("invalid ticket");
  if (!Number.isSafeInteger(offer.size) || offer.size < 0 || offer.size > maxBytes) {
    throw new Error(`invalid file size: ${offer.size}`);
  }
  if (!offer.sourceDevice || !offer.targetDevice) throw new Error("sourceDevice and targetDevice are required");
}

function safeName(name: string): string {
  const base = path.basename(String(name || "file")).replace(/[\u0000-\u001f\u007f]/g, "_");
  return base && base !== "." && base !== ".." ? base : "file";
}

async function availablePath(dir: string, name: string): Promise<string> {
  const parsed = path.parse(safeName(name));
  for (let i = 0; i < 10_000; i += 1) {
    const candidate = path.join(dir, i === 0 ? parsed.base : `${parsed.name} (${i})${parsed.ext}`);
    try {
      await fs.promises.access(candidate, fs.constants.F_OK);
    } catch {
      return candidate;
    }
  }
  throw new Error("unable to allocate receive filename");
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function writeLine(socket: TLSSocket, value: unknown): void {
  socket.write(`${JSON.stringify(value)}\n`);
}

class SocketLineReader {
  private buffer = Buffer.alloc(0);
  constructor(private readonly socket: TLSSocket) {}

  async readJson(timeoutMs: number): Promise<Record<string, unknown>> {
    const existing = this.takeLine();
    if (existing) return JSON.parse(existing.toString("utf8"));
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => cleanup(new Error("response timeout")), timeoutMs);
      const onData = (chunk: Buffer) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        if (this.buffer.length > 64 * 1024) return cleanup(new Error("response header too large"));
        const line = this.takeLine();
        if (!line) return;
        // Keep payload bytes in the socket/readable buffer until the caller
        // switches from line framing to bounded payload consumption.
        this.socket.pause();
        try { cleanup(undefined, JSON.parse(line.toString("utf8"))); }
        catch (error) { cleanup(error instanceof Error ? error : new Error(String(error))); }
      };
      const onError = (error: Error) => cleanup(error);
      const onClose = () => cleanup(new Error("socket closed before response"));
      const cleanup = (error?: Error, value?: Record<string, unknown>) => {
        clearTimeout(timer);
        this.socket.off("data", onData);
        this.socket.off("error", onError);
        this.socket.off("close", onClose);
        if (error) reject(error); else resolve(value!);
      };
      this.socket.on("data", onData);
      this.socket.once("error", onError);
      this.socket.once("close", onClose);
      this.socket.resume();
    });
  }

  takeRemainder(): Buffer {
    const value = this.buffer;
    this.buffer = Buffer.alloc(0);
    return value;
  }

  private takeLine(): Buffer | null {
    const newline = this.buffer.indexOf(10);
    if (newline < 0) return null;
    const line = this.buffer.subarray(0, newline);
    this.buffer = this.buffer.subarray(newline + 1);
    return line;
  }
}

async function connectTls(config: FileTransferConfig): Promise<TLSSocket> {
  return new Promise<TLSSocket>((resolve, reject) => {
    let settled = false;
    const expected = normalizeFingerprint(config.certificateSha256);
    const socket = tls.connect({
      host: config.host,
      port: config.port,
      servername: config.serverName,
      rejectUnauthorized: expected.length === 0,
    });
    socket.setNoDelay(true);
    socket.setTimeout(config.transferTimeoutMs, () => socket.destroy(new Error("file transfer timeout")));
    const timer = setTimeout(() => socket.destroy(new Error("file relay connect timeout")), config.connectTimeoutMs);
    const fail = (error: Error) => {
      clearTimeout(timer);
      if (!settled) { settled = true; reject(error); }
    };
    socket.once("error", fail);
    socket.once("secureConnect", () => {
      clearTimeout(timer);
      try {
        if (expected) {
          const raw = socket.getPeerCertificate(true)?.raw;
          if (!raw) throw new Error("file relay did not provide a certificate");
          const actual = createHash("sha256").update(raw).digest("hex");
          if (actual !== expected) throw new Error(`file relay certificate pin mismatch: ${actual}`);
        }
        if (!settled) { settled = true; resolve(socket); }
      } catch (error) {
        socket.destroy();
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

export function newTransferTicket(): string {
  return randomBytes(32).toString("base64url");
}

export function newTransferId(): string {
  return `a2a-${Date.now()}-${randomBytes(8).toString("hex")}`;
}

export async function inspectFile(filePath: string, maxBytes: number): Promise<{ size: number; sha256: string }> {
  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile()) throw new Error(`not a regular file: ${filePath}`);
  if (stat.size > maxBytes) throw new Error(`file exceeds maxFileSizeBytes: ${stat.size} > ${maxBytes}`);
  return { size: stat.size, sha256: await hashFile(filePath) };
}

export function startFileReceive(config: FileTransferConfig, offer: FileOffer): ReadyReceive {
  let readyResolve!: () => void;
  let readyReject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });

  const completed = (async (): Promise<ReceiveResult> => {
    validateOffer(offer, config.maxFileSizeBytes);
    await fs.promises.mkdir(config.receiveDir, { recursive: true });
    const finalPath = await availablePath(config.receiveDir, offer.name);
    const partPath = path.join(config.receiveDir, `.${offer.transferId}.part`);
    let socket: TLSSocket | undefined;
    const started = nowMs();
    try {
      await fs.promises.rm(partPath, { force: true });
      socket = await connectTls(config);
      const reader = new SocketLineReader(socket);
      writeLine(socket, {
        version: 1, role: "receiver", id: offer.transferId, token: offer.ticket,
        sourceDevice: offer.targetDevice, targetDevice: offer.sourceDevice,
      });
      readyResolve();
      const metadata = await reader.readJson(config.transferTimeoutMs);
      if (metadata.type !== "metadata" || Number(metadata.size) !== offer.size || metadata.sha256 !== offer.sha256) {
        throw new Error("relay metadata does not match A2A offer");
      }

      const output = await fs.promises.open(partPath, "wx");
      const hash = createHash("sha256");
      let received = 0;
      const downloadStarted = nowMs();
      try {
        const consume = async (chunk: Buffer) => {
          if (!chunk.length) return;
          const remaining = offer.size - received;
          if (chunk.length > remaining) throw new Error("relay sent beyond declared size");
          await output.write(chunk);
          hash.update(chunk);
          received += chunk.length;
        };
        await consume(reader.takeRemainder());
        // Do not use `break` from `for await`: Node destroys a Readable when
        // the async iterator returns early, which would close TLS before ACK.
        const iterator = socket[Symbol.asyncIterator]();
        while (received < offer.size) {
          const next = await iterator.next();
          if (next.done) break;
          await consume(next.value as Buffer);
        }
      } finally {
        await output.close();
      }
      if (received !== offer.size) throw new Error(`incomplete payload: ${received} != ${offer.size}`);
      const downloadDone = nowMs();
      const verifyStarted = nowMs();
      const actualHash = hash.digest("hex");
      const verifyDone = nowMs();
      if (actualHash !== offer.sha256) throw new Error(`sha256 mismatch: ${actualHash} != ${offer.sha256}`);
      await fs.promises.rename(partPath, finalPath);
      const result: ReceiveResult = {
        ok: true,
        transferId: offer.transferId,
        path: finalPath,
        name: path.basename(finalPath),
        size: received,
        sha256: actualHash,
        receiverDownloadMs: downloadDone - downloadStarted,
        receiverVerifyMs: verifyDone - verifyStarted,
      };
      writeLine(socket, result);
      socket.end();
      return result;
    } catch (error) {
      readyReject(error instanceof Error ? error : new Error(String(error)));
      if (socket && !socket.destroyed) writeLine(socket, { ok: false, error: error instanceof Error ? error.message : String(error) });
      socket?.destroy();
      await fs.promises.rm(partPath, { force: true }).catch(() => undefined);
      throw error;
    } finally {
      void started;
    }
  })();
  // The completion promise is intentionally retained by the caller; avoid an
  // unhandled-rejection warning if the sender disconnects after prepare.
  completed.catch(() => undefined);
  return { ready, completed };
}

export async function sendFilePayload(
  config: FileTransferConfig,
  offer: FileOffer,
  filePath: string,
  controlPrepareMs: number,
): Promise<SendResult> {
  validateOffer(offer, config.maxFileSizeBytes);
  const transferStarted = nowMs();
  const socket = await connectTls(config);
  const reader = new SocketLineReader(socket);
  writeLine(socket, {
    version: 1, role: "sender", id: offer.transferId, token: offer.ticket,
    sourceDevice: offer.sourceDevice, targetDevice: offer.targetDevice,
    size: offer.size, sha256: offer.sha256,
  });
  const ready = await reader.readJson(config.connectTimeoutMs);
  if (ready.type !== "ready") throw new Error(`receiver not ready: ${JSON.stringify(ready)}`);
  const payloadStarted = nowMs();
  for await (const chunk of fs.createReadStream(filePath)) {
    if (!socket.write(chunk as Buffer)) await new Promise<void>((resolve) => socket.once("drain", resolve));
  }
  const payloadDone = nowMs();
  const ack = await reader.readJson(config.transferTimeoutMs);
  const finished = nowMs();
  socket.end();
  if (ack.ok !== true || ack.sha256 !== offer.sha256 || Number(ack.size) !== offer.size) {
    throw new Error(`receiver ACK failed: ${JSON.stringify(ack)}`);
  }
  return {
    ...(ack as unknown as ReceiveResult),
    controlPrepareMs,
    senderSetupMs: payloadStarted - transferStarted,
    senderPayloadMs: payloadDone - payloadStarted,
    senderAckWaitMs: finished - payloadDone,
    transferMs: finished - transferStarted + controlPrepareMs,
  };
}
