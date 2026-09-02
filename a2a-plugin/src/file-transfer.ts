import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import tls, { type TLSSocket } from "node:tls";

import {
  commitPartNoClobber,
  createTransferRecord,
  FileTransferStore,
} from "./file-transfer-store.js";
import {
  safeTransferName,
  validateFileOffer,
  type FileOffer,
  type FileTransferConfig,
  type FileTransferRecord,
  type ReceiveResult,
  type SendResult,
  type SourceSnapshot,
} from "./file-transfer-types.js";

export * from "./file-transfer-store.js";
export * from "./file-transfer-types.js";

export type ReadyReceive = {
  ready: Promise<void>;
  completed: Promise<ReceiveResult>;
  cancel: (reason?: string) => void;
};

const nowMs = () => Number(process.hrtime.bigint()) / 1e6;

function normalizeFingerprint(value?: string): string {
  return String(value || "").toLowerCase().replace(/[^a-f0-9]/g, "");
}

function abortError(reason = "file transfer canceled"): Error {
  const error = new Error(reason);
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(String(signal.reason || "file transfer canceled"));
}

async function hashHandle(handle: fs.promises.FileHandle): Promise<string> {
  const hash = createHash("sha256");
  const stream = handle.createReadStream({ autoClose: false, start: 0 });
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function sameStat(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs;
}

export async function inspectFile(filePath: string, maxBytes: number): Promise<SourceSnapshot> {
  const handle = await fs.promises.open(filePath, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error(`not a regular file: ${filePath}`);
    if (before.size > maxBytes) throw new Error(`file exceeds maxFileSizeBytes: ${before.size} > ${maxBytes}`);
    const sha256 = await hashHandle(handle);
    const after = await handle.stat();
    if (!sameStat(before, after)) throw new Error("SOURCE_CHANGED: file changed while hashing");
    return {
      size: before.size,
      sha256,
      dev: before.dev,
      ino: before.ino,
      mtimeMs: before.mtimeMs,
      ctimeMs: before.ctimeMs,
    };
  } finally {
    await handle.close();
  }
}

function writeSocket(socket: TLSSocket, data: string | Buffer): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (socket.destroyed) return reject(new Error("socket is closed"));
    const onError = (error: Error) => finish(error);
    const onClose = () => finish(new Error("socket closed while writing"));
    const finish = (error?: Error) => {
      socket.off("error", onError);
      socket.off("close", onClose);
      if (error) reject(error);
      else resolve();
    };
    socket.once("error", onError);
    socket.once("close", onClose);
    socket.write(data, (error?: Error | null) => finish(error || undefined));
  });
}

async function writeLine(socket: TLSSocket, value: unknown): Promise<void> {
  await writeSocket(socket, `${JSON.stringify(value)}\n`);
}

class SocketLineReader {
  private buffer = Buffer.alloc(0);

  constructor(private readonly socket: TLSSocket) {}

  async readJson(timeoutMs: number): Promise<Record<string, unknown>> {
    const existing = this.takeLine();
    if (existing) return this.parseLine(existing);
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => cleanup(new Error("response timeout")), timeoutMs);
      const onData = (chunk: Buffer) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        const newline = this.buffer.indexOf(10);
        if (newline < 0) {
          if (this.buffer.length > 64 * 1024) cleanup(new Error("response header too large"));
          return;
        }
        if (newline > 64 * 1024) return cleanup(new Error("response header too large"));
        const line = this.takeLine();
        if (!line) return;
        this.socket.pause();
        try {
          cleanup(undefined, this.parseLine(line));
        } catch (error) {
          cleanup(error instanceof Error ? error : new Error(String(error)));
        }
      };
      const onError = (error: Error) => cleanup(error);
      const onClose = () => cleanup(new Error("socket closed before response"));
      const onEnd = () => cleanup(new Error("socket ended before response"));
      const cleanup = (error?: Error, value?: Record<string, unknown>) => {
        clearTimeout(timer);
        this.socket.off("data", onData);
        this.socket.off("error", onError);
        this.socket.off("close", onClose);
        this.socket.off("end", onEnd);
        if (error) reject(error);
        else resolve(value!);
      };
      this.socket.on("data", onData);
      this.socket.once("error", onError);
      this.socket.once("close", onClose);
      this.socket.once("end", onEnd);
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

  private parseLine(line: Buffer): Record<string, unknown> {
    if (line.length > 64 * 1024) throw new Error("response header too large");
    const value = JSON.parse(line.toString("utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("response must be an object");
    return value as Record<string, unknown>;
  }
}

async function connectTls(config: FileTransferConfig, signal?: AbortSignal): Promise<TLSSocket> {
  throwIfAborted(signal);
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
    socket.setTimeout(config.transferTimeoutMs, () => socket.destroy(new Error("file transfer stalled")));
    const timer = setTimeout(() => socket.destroy(new Error("file relay connect timeout")), config.connectTimeoutMs);
    const onAbort = () => socket.destroy(abortError(String(signal?.reason || "file transfer canceled")));
    signal?.addEventListener("abort", onAbort, { once: true });
    const finish = (error?: Error) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(socket);
    };
    socket.once("error", (error) => finish(error));
    socket.once("secureConnect", () => {
      try {
        if (expected) {
          const raw = socket.getPeerCertificate(true)?.raw;
          if (!raw) throw new Error("file relay did not provide a certificate");
          const actual = createHash("sha256").update(raw).digest("hex");
          if (actual !== expected) throw new Error(`file relay certificate pin mismatch: ${actual}`);
        }
        finish();
      } catch (error) {
        socket.destroy();
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

async function writeAll(handle: fs.promises.FileHandle, chunk: Buffer): Promise<void> {
  let offset = 0;
  while (offset < chunk.length) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset, null);
    if (bytesWritten <= 0) throw new Error("disk write made no progress");
    offset += bytesWritten;
  }
}

function updateRecord(record: FileTransferRecord, values: Partial<FileTransferRecord>): FileTransferRecord {
  Object.assign(record, values);
  return record;
}

export function newTransferTicket(): string {
  return randomBytes(32).toString("base64url");
}

export function newTransferId(): string {
  return `a2a-${Date.now()}-${randomBytes(8).toString("hex")}`;
}

export function startFileReceive(
  config: FileTransferConfig,
  offer: FileOffer,
  options: { store?: FileTransferStore } = {},
): ReadyReceive {
  const controller = new AbortController();
  let readySettled = false;
  let readyResolve!: () => void;
  let readyReject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = () => { if (!readySettled) { readySettled = true; resolve(); } };
    readyReject = (error) => { if (!readySettled) { readySettled = true; reject(error); } };
  });

  const completed = (async (): Promise<ReceiveResult> => {
    let socket: TLSSocket | undefined;
    let partPath: string | undefined;
    let record: FileTransferRecord | undefined;
    let committed = false;
    let removeTransferAbortListener: (() => void) | undefined;
    try {
      validateFileOffer(offer, config.maxFileSizeBytes);
      throwIfAborted(controller.signal);
      await fs.promises.mkdir(config.receiveDir, { recursive: true, mode: 0o700 });
      partPath = path.join(
        config.receiveDir,
        `.${offer.transferId}.${randomBytes(6).toString("hex")}.part`,
      );
      record = createTransferRecord(offer, partPath);
      await options.store?.save(record);

      socket = await connectTls(config, controller.signal);
      const onTransferAbort = () => socket?.destroy(abortError(String(controller.signal.reason || "file transfer canceled")));
      controller.signal.addEventListener("abort", onTransferAbort, { once: true });
      removeTransferAbortListener = () => controller.signal.removeEventListener("abort", onTransferAbort);
      const reader = new SocketLineReader(socket);
      await writeLine(socket, {
        version: 1,
        role: "receiver",
        id: offer.transferId,
        token: offer.ticket,
        sourceDevice: offer.targetDevice,
        targetDevice: offer.sourceDevice,
      });
      const registered = await reader.readJson(config.connectTimeoutMs);
      if (registered.type !== "registered" || registered.id !== offer.transferId) {
        throw new Error(`receiver registration rejected: ${JSON.stringify(registered)}`);
      }
      await options.store?.save(updateRecord(record, { state: "READY" }));
      readyResolve();

      const metadata = await reader.readJson(config.transferTimeoutMs);
      if (
        metadata.type !== "metadata" ||
        metadata.id !== offer.transferId ||
        Number(metadata.size) !== offer.size ||
        metadata.sha256 !== offer.sha256
      ) {
        throw new Error("relay metadata does not match A2A offer");
      }
      await options.store?.save(updateRecord(record, { state: "TRANSFERRING" }));

      const output = await fs.promises.open(partPath, "wx", 0o600);
      const hash = createHash("sha256");
      let received = 0;
      const downloadStarted = nowMs();
      try {
        const consume = async (chunk: Buffer) => {
          throwIfAborted(controller.signal);
          if (!chunk.length) return;
          const remaining = offer.size - received;
          if (chunk.length > remaining) throw new Error("relay sent beyond declared size");
          await writeAll(output, chunk);
          hash.update(chunk);
          received += chunk.length;
        };
        await consume(reader.takeRemainder());
        const iterator = socket[Symbol.asyncIterator]();
        while (received < offer.size) {
          const next = await iterator.next();
          if (next.done) break;
          await consume(next.value as Buffer);
        }
        if (received !== offer.size) throw new Error(`incomplete payload: ${received} != ${offer.size}`);
        await output.sync();
      } finally {
        await output.close();
      }

      const downloadDone = nowMs();
      const verifyStarted = nowMs();
      const actualHash = hash.digest("hex");
      if (actualHash !== offer.sha256) throw new Error(`sha256 mismatch: ${actualHash} != ${offer.sha256}`);
      const verifyDone = nowMs();

      const finalPath = await commitPartNoClobber(
        config.receiveDir,
        offer.name,
        partPath,
        async (candidate) => {
          await options.store?.save(updateRecord(record!, { state: "COMMITTING", path: candidate }));
        },
      );
      partPath = undefined;
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
      committed = true;
      await options.store?.save(updateRecord(record, {
        state: "DATA_COMMITTED",
        path: finalPath,
        partPath: undefined,
        receiverDownloadMs: result.receiverDownloadMs,
        receiverVerifyMs: result.receiverVerifyMs,
        error: undefined,
      }));
      try {
        await writeLine(socket, result);
        socket.end();
      } catch {
        socket.destroy();
      }
      removeTransferAbortListener();
      return result;
    } catch (error) {
      removeTransferAbortListener?.();
      const failure = error instanceof Error ? error : new Error(String(error));
      readyReject(failure);
      if (!committed && record) {
        await options.store?.save(updateRecord(record, {
          state: failure.name === "AbortError" ? "CANCELED" : "FAILED_CONFIRMED",
          partPath: undefined,
          path: undefined,
          error: failure.message,
        })).catch(() => undefined);
      }
      if (socket && !socket.destroyed) {
        await writeLine(socket, { ok: false, transferId: offer.transferId, error: failure.message }).catch(() => undefined);
      }
      socket?.destroy();
      if (!committed && partPath) await fs.promises.rm(partPath, { force: true }).catch(() => undefined);
      throw failure;
    }
  })();
  completed.catch(() => undefined);
  return {
    ready,
    completed,
    cancel: (reason = "file transfer canceled") => controller.abort(reason),
  };
}

export async function sendFilePayload(
  config: FileTransferConfig,
  offer: FileOffer,
  filePath: string,
  controlPrepareMs: number,
  snapshot?: SourceSnapshot,
): Promise<SendResult> {
  validateFileOffer(offer, config.maxFileSizeBytes);
  const transferStarted = nowMs();
  let socket: TLSSocket | undefined;
  let source: fs.promises.FileHandle | undefined;
  let succeeded = false;
  try {
    source = await fs.promises.open(filePath, "r");
    const before = await source.stat();
    if (!before.isFile() || before.size !== offer.size) throw new Error("SOURCE_CHANGED: file size changed before send");
    if (snapshot && (
      snapshot.dev !== before.dev ||
      snapshot.ino !== before.ino ||
      snapshot.size !== before.size ||
      snapshot.mtimeMs !== before.mtimeMs ||
      snapshot.ctimeMs !== before.ctimeMs
    )) {
      throw new Error("SOURCE_CHANGED: file identity changed before send");
    }

    socket = await connectTls(config);
    const reader = new SocketLineReader(socket);
    await writeLine(socket, {
      version: 1,
      role: "sender",
      id: offer.transferId,
      token: offer.ticket,
      sourceDevice: offer.sourceDevice,
      targetDevice: offer.targetDevice,
      size: offer.size,
      sha256: offer.sha256,
    });
    const ready = await reader.readJson(config.connectTimeoutMs);
    if (ready.type !== "ready" || ready.id !== offer.transferId) {
      throw new Error(`receiver not ready: ${JSON.stringify(ready)}`);
    }

    const payloadStarted = nowMs();
    const sentHash = createHash("sha256");
    let sent = 0;
    const stream = source.createReadStream({ autoClose: false, start: 0 });
    for await (const chunkValue of stream) {
      const chunk = chunkValue as Buffer;
      if (sent + chunk.length > offer.size) throw new Error("SOURCE_CHANGED: file grew while sending");
      await writeSocket(socket, chunk);
      sentHash.update(chunk);
      sent += chunk.length;
    }
    if (sent !== offer.size) throw new Error(`SOURCE_CHANGED: sent ${sent} bytes, expected ${offer.size}`);
    const actualHash = sentHash.digest("hex");
    if (actualHash !== offer.sha256) throw new Error("SOURCE_CHANGED: file content changed while sending");
    const after = await source.stat();
    if (!sameStat(before, after)) throw new Error("SOURCE_CHANGED: file metadata changed while sending");

    const payloadDone = nowMs();
    const ack = await reader.readJson(config.transferTimeoutMs);
    const finished = nowMs();
    if (
      ack.ok !== true ||
      ack.transferId !== offer.transferId ||
      ack.sha256 !== offer.sha256 ||
      Number(ack.size) !== offer.size ||
      typeof ack.path !== "string" ||
      typeof ack.name !== "string"
    ) {
      throw new Error(`receiver ACK failed: ${JSON.stringify(ack)}`);
    }
    socket.end();
    succeeded = true;
    return {
      ...(ack as unknown as ReceiveResult),
      controlPrepareMs,
      senderSetupMs: payloadStarted - transferStarted,
      senderPayloadMs: payloadDone - payloadStarted,
      senderAckWaitMs: finished - payloadDone,
      transferMs: finished - transferStarted + controlPrepareMs,
    };
  } finally {
    await source?.close().catch(() => undefined);
    if (!succeeded) socket?.destroy();
  }
}
