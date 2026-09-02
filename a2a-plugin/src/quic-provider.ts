import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import {
  TransferError,
  channelFingerprint,
  deriveChannelName,
  type FileOffer,
  type QuicTransferConfig,
  type ReceiveResult,
  type SendResult,
} from "./file-transfer-types.js";

export interface QuicPreparedAttempt {
  offer: FileOffer;
  channel: string;
  receiveDir: string;
  finalPath: string;
  process?: ChildProcessWithoutNullStreams;
  ready: Promise<void>;
  completed: Promise<ReceiveResult>;
  cancel: (reason?: string) => void;
}

function defaultExtraEnv(): Record<string, string> {
  return {
    LD_LIBRARY_PATH: "/system/lib64/ndk:/data/local/tmp/a2a-rcp",
  };
}

function mergeEnv(extra: Record<string, string> | undefined): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...defaultExtraEnv(),
    ...(extra || {}),
  };
}

function parseResultLine(line: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of line.trim().split(/\s+/)) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    out[part.slice(0, idx)] = part.slice(idx + 1);
  }
  return out;
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function killProcessTree(child: ChildProcessWithoutNullStreams | undefined): void {
  if (!child || child.killed) return;
  try {
    child.kill("SIGKILL");
  } catch {
    // ignore
  }
}

function spawnHelper(
  quic: QuicTransferConfig,
  args: string[],
): ChildProcessWithoutNullStreams {
  if (!quic.binary) {
    throw new TransferError("UNSUPPORTED", "quic binary is not configured");
  }
  if (!fs.existsSync(quic.binary)) {
    throw new TransferError("UNAVAILABLE_BEFORE_START", `quic binary missing: ${quic.binary}`);
  }
  return spawn(quic.binary, args, {
    shell: false,
    env: mergeEnv(quic.extraEnv),
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function collectProcess(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      killProcessTree(child);
      finish(new TransferError("AMBIGUOUS", `quic helper timed out after ${timeoutMs}ms`, true));
    }, timeoutMs);
    const finish = (error?: Error, value?: { code: number | null; stdout: string; stderr: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value!);
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 1024 * 1024) stdout = stdout.slice(-512 * 1024);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > 1024 * 1024) stderr = stderr.slice(-512 * 1024);
    });
    child.on("error", (error) => finish(new TransferError("UNAVAILABLE_BEFORE_START", error.message)));
    child.on("close", (code) => finish(undefined, { code, stdout, stderr }));
  });
}

function extractResult(stdout: string, stderr: string): Record<string, string> {
  const lines = `${stdout}\n${stderr}`.split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].startsWith("RESULT ")) return parseResultLine(lines[i].slice("RESULT ".length));
  }
  throw new TransferError("AMBIGUOUS", "quic helper produced no RESULT line", true);
}

export function startQuicReceive(
  quic: QuicTransferConfig,
  offer: FileOffer,
  receiveDir: string,
): QuicPreparedAttempt {
  const attemptId = offer.attemptId || offer.transferId;
  const channel = deriveChannelName(offer.ticket, offer.transferId, attemptId);
  // Avoid clobbering an existing same-name file from a prior TCP/QUIC transfer.
  const safeName = offer.name;
  const parsed = path.parse(safeName);
  let finalPath = path.join(receiveDir, safeName);
  let n = 0;
  while (fs.existsSync(finalPath) && n < 1000) {
    n += 1;
    finalPath = path.join(receiveDir, `${parsed.name} (${n})${parsed.ext}`);
  }
  fs.mkdirSync(receiveDir, { recursive: true, mode: 0o700 });

  let readyResolve!: () => void;
  let readyReject!: (error: Error) => void;
  let readySettled = false;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = () => {
      if (!readySettled) {
        readySettled = true;
        resolve();
      }
    };
    readyReject = (error) => {
      if (!readySettled) {
        readySettled = true;
        reject(error);
      }
    };
  });

  const args = [
    "--mode", "recv",
    "--host", quic.relayHost,
    "--port", String(quic.relayPort),
    "--channel", channel,
    "--file", finalPath,
    "--sha256", offer.sha256,
    "--timeout", `${Math.ceil(quic.transferTimeoutMs / 1000)}s`,
    "--stall", `${Math.ceil(quic.stallTimeoutMs / 1000)}s`,
    "--connect-timeout", `${Math.ceil(quic.connectTimeoutMs / 1000)}s`,
  ];

  let child: ChildProcessWithoutNullStreams | undefined;
  const completed = (async (): Promise<ReceiveResult> => {
    const started = Date.now();
    try {
      child = spawnHelper(quic, args);
      // Helper has no JSONL "registered" yet; give the process a brief start window.
      await new Promise((r) => setTimeout(r, 800));
      if (child.exitCode !== null) {
        const errText = (child.stderr.read()?.toString?.() || "helper exited early").toString();
        throw new TransferError("UNAVAILABLE_BEFORE_START", `quic recv failed to start: ${errText}`);
      }
      readyResolve();
      const result = await collectProcess(child, quic.transferTimeoutMs);
      const parsed = extractResult(result.stdout, result.stderr);
      if (parsed.ok !== "true") {
        throw new TransferError(
          "FAILED_CONFIRMED",
          `quic recv failed: ${parsed.error || result.stderr.slice(0, 200)}`,
        );
      }
      const bytes = Number(parsed.bytes || 0);
      const sha = String(parsed.sha256 || "");
      if (bytes !== offer.size || sha !== offer.sha256) {
        throw new TransferError(
          "INTEGRITY_FAILED",
          `quic integrity mismatch bytes=${bytes} sha=${sha}`,
          true,
        );
      }
      if (!fs.existsSync(finalPath)) {
        throw new TransferError("FAILED_CONFIRMED", "quic recv RESULT ok but file missing");
      }
      const downloadMs = Number(parsed.download_seconds || 0) * 1000;
      const verifyMs = Number(parsed.commit_seconds || 0) * 1000;
      return {
        ok: true,
        transferId: offer.transferId,
        path: finalPath,
        name: path.basename(finalPath),
        size: bytes,
        sha256: sha,
        receiverDownloadMs: downloadMs || Math.max(0, Date.now() - started),
        receiverVerifyMs: verifyMs,
      };
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      readyReject(failure);
      killProcessTree(child);
      throw failure;
    }
  })();
  completed.catch(() => undefined);

  return {
    offer,
    channel,
    receiveDir,
    finalPath,
    process: child,
    ready,
    completed,
    cancel: (reason = "canceled") => {
      killProcessTree(child);
      readyReject(new TransferError("CANCELED", reason, true));
    },
  };
}

export async function sendQuicPayload(
  quic: QuicTransferConfig,
  offer: FileOffer,
  sourcePath: string,
  controlPrepareMs: number,
): Promise<SendResult> {
  const attemptId = offer.attemptId || offer.transferId;
  const channel = deriveChannelName(offer.ticket, offer.transferId, attemptId);
  const started = Date.now();
  const beforeHash = await hashFile(sourcePath);
  if (beforeHash !== offer.sha256) {
    throw new TransferError("INTEGRITY_FAILED", "SOURCE_CHANGED before quic send", true);
  }
  const args = [
    "--mode", "send",
    "--host", quic.relayHost,
    "--port", String(quic.relayPort),
    "--channel", channel,
    "--file", sourcePath,
    "--timeout", `${Math.ceil(quic.transferTimeoutMs / 1000)}s`,
    "--stall", `${Math.ceil(quic.stallTimeoutMs / 1000)}s`,
    "--connect-timeout", `${Math.ceil(quic.connectTimeoutMs / 1000)}s`,
  ];
  const child = spawnHelper(quic, args);
  try {
    const result = await collectProcess(child, quic.transferTimeoutMs);
    const parsed = extractResult(result.stdout, result.stderr);
    if (parsed.ok !== "true") {
      throw new TransferError(
        "AMBIGUOUS",
        `quic send failed: ${parsed.error || result.stderr.slice(0, 200)}`,
        true,
      );
    }
    const bytes = Number(parsed.bytes || 0);
    const sha = String(parsed.sha256 || "");
    if (bytes !== offer.size || sha !== offer.sha256) {
      throw new TransferError("INTEGRITY_FAILED", `quic send integrity mismatch`, true);
    }
    const payloadMs = Number(parsed.transfer_seconds || 0) * 1000;
    const finished = Date.now();
    return {
      ok: true,
      transferId: offer.transferId,
      path: sourcePath,
      name: path.basename(sourcePath),
      size: bytes,
      sha256: sha,
      receiverDownloadMs: 0,
      receiverVerifyMs: 0,
      controlPrepareMs,
      senderSetupMs: 0,
      senderPayloadMs: payloadMs || finished - started,
      senderAckWaitMs: Number(parsed.receipt_wait_seconds || 0) * 1000,
      transferMs: finished - started + controlPrepareMs,
      transport: "quic-v7",
      attemptId,
      dataCommitted: true,
      doNotRetry: true,
    };
  } catch (error) {
    killProcessTree(child);
    if (error instanceof TransferError) throw error;
    throw new TransferError("AMBIGUOUS", error instanceof Error ? error.message : String(error), true);
  }
}

export function describeQuicChannel(offer: FileOffer): { channel: string; fingerprint: string } {
  const attemptId = offer.attemptId || offer.transferId;
  const channel = deriveChannelName(offer.ticket, offer.transferId, attemptId);
  return { channel, fingerprint: channelFingerprint(channel) };
}
