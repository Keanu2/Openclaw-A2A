import { createHmac, randomBytes } from "node:crypto";
import path from "node:path";

export type TransportName = "inline-base64" | "quic-v7" | "tcp-v1";

export type ErrorCategory =
  | "UNSUPPORTED"
  | "UNAVAILABLE_BEFORE_START"
  | "FAILED_CONFIRMED"
  | "AMBIGUOUS"
  | "POLICY_REJECTED"
  | "INTEGRITY_FAILED"
  | "AUTH_FAILED"
  | "CANCELED";

export interface QuicTransferConfig {
  enabled: boolean;
  binary: string;
  extraEnv: Record<string, string>;
  relayHost: string;
  relayPort: number;
  connectTimeoutMs: number;
  transferTimeoutMs: number;
  stallTimeoutMs: number;
}

export interface FileTransferConfig {
  enabled: boolean;
  host: string;
  port: number;
  serverName: string;
  certificateSha256?: string;
  receiveDir: string;
  maxFileSizeBytes: number;
  maxConcurrentReceives: number;
  maxInFlightBytes: number;
  connectTimeoutMs: number;
  transferTimeoutMs: number;
  /** Preferred stream order; tcp-v1 is ignored for auto-select until explicitly enabled. */
  order?: TransportName[];
  inlinePreferredBelowBytes?: number;
  autoPeers?: string[];
  quic?: QuicTransferConfig;
}

export interface FileOffer {
  version?: 1;
  transferId: string;
  attemptId?: string;
  transport?: TransportName;
  ticket: string;
  sourceDevice: string;
  targetDevice: string;
  name: string;
  mimeType: string;
  size: number;
  sha256: string;
  expiresAt?: number;
}

export interface SourceSnapshot {
  size: number;
  sha256: string;
  dev: number;
  ino: number;
  mtimeMs: number;
  ctimeMs: number;
}

export type FileTransferState =
  | "PREPARING"
  | "READY"
  | "TRANSFERRING"
  | "COMMITTING"
  | "DATA_COMMITTED"
  | "NOTIFY_PENDING"
  | "COMPLETED"
  | "FAILED_CONFIRMED"
  | "CANCELED"
  | "EXPIRED"
  | "INTERRUPTED";

export interface FileTransferRecord {
  version: 1;
  transferId: string;
  attemptId?: string;
  transport?: TransportName;
  sourceDevice: string;
  targetDevice: string;
  name: string;
  mimeType: string;
  size: number;
  sha256: string;
  state: FileTransferState;
  createdAt: string;
  updatedAt: string;
  path?: string;
  partPath?: string;
  error?: string;
  errorCategory?: ErrorCategory;
  receiverDownloadMs?: number;
  receiverVerifyMs?: number;
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
  transport?: TransportName;
  attemptId?: string;
  dataCommitted?: boolean;
  doNotRetry?: boolean;
  errorCategory?: ErrorCategory;
}

export interface PublicTransferStatus {
  ok: true;
  transferId: string;
  state: FileTransferState;
  name: string;
  mimeType: string;
  size: number;
  sha256: string;
  updatedAt: string;
  attemptId?: string;
  transport?: TransportName;
  error?: string;
  errorCategory?: ErrorCategory;
}

export class TransferError extends Error {
  readonly category: ErrorCategory;
  readonly doNotRetry: boolean;

  constructor(category: ErrorCategory, message: string, doNotRetry = false) {
    super(message);
    this.name = "TransferError";
    this.category = category;
    this.doNotRetry = doNotRetry;
  }
}

export function validateFileOffer(offer: FileOffer, maxBytes: number): void {
  if (!offer || typeof offer !== "object") throw new TransferError("POLICY_REJECTED", "invalid file offer", true);
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(offer.transferId)) {
    throw new TransferError("POLICY_REJECTED", "invalid transferId", true);
  }
  if (offer.attemptId !== undefined && !/^[A-Za-z0-9._-]{1,128}$/.test(offer.attemptId)) {
    throw new TransferError("POLICY_REJECTED", "invalid attemptId", true);
  }
  if (!/^[a-f0-9]{64}$/.test(offer.sha256)) {
    throw new TransferError("POLICY_REJECTED", "invalid sha256", true);
  }
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(offer.ticket)) {
    throw new TransferError("POLICY_REJECTED", "invalid ticket", true);
  }
  if (!Number.isSafeInteger(offer.size) || offer.size < 0 || offer.size > maxBytes) {
    throw new TransferError("POLICY_REJECTED", `invalid file size: ${offer.size}`, true);
  }
  if (typeof offer.sourceDevice !== "string" || !/^[A-Za-z0-9._:-]{1,256}$/.test(offer.sourceDevice)) {
    throw new TransferError("AUTH_FAILED", "invalid sourceDevice", true);
  }
  if (typeof offer.targetDevice !== "string" || !/^[A-Za-z0-9._:-]{1,256}$/.test(offer.targetDevice)) {
    throw new TransferError("AUTH_FAILED", "invalid targetDevice", true);
  }
  if (typeof offer.name !== "string" || Buffer.byteLength(offer.name, "utf8") > 1024) {
    throw new TransferError("POLICY_REJECTED", "invalid file name", true);
  }
  if (typeof offer.mimeType !== "string" || offer.mimeType.length > 256) {
    throw new TransferError("POLICY_REJECTED", "invalid MIME type", true);
  }
  if (offer.expiresAt !== undefined && (!Number.isFinite(offer.expiresAt) || offer.expiresAt < Date.now())) {
    throw new TransferError("POLICY_REJECTED", "offer expired", true);
  }
}

function truncateUtf8(value: string, maxBytes: number): string {
  let result = value;
  while (Buffer.byteLength(result, "utf8") > maxBytes) result = result.slice(0, -1);
  return result;
}

export function safeTransferName(name: string): string {
  const base = path.basename(String(name || "file").replace(/\\/g, "/"));
  let cleaned = base
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "_")
    .replace(/^\.+/, "")
    .replace(/[. ]+$/g, "")
    .trim();
  cleaned = truncateUtf8(cleaned, 220);
  if (!cleaned) cleaned = "file";
  const stem = path.parse(cleaned).name.toUpperCase();
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)) cleaned = `_${cleaned}`;
  return cleaned;
}

export function recordMatchesOffer(record: FileTransferRecord, offer: FileOffer): boolean {
  return record.transferId === offer.transferId &&
    record.sourceDevice === offer.sourceDevice &&
    record.targetDevice === offer.targetDevice &&
    record.name === safeTransferName(offer.name) &&
    record.mimeType === offer.mimeType &&
    record.size === offer.size &&
    record.sha256 === offer.sha256;
}

export function publicTransferStatus(record: FileTransferRecord): PublicTransferStatus {
  return {
    ok: true,
    transferId: record.transferId,
    state: record.state,
    name: record.name,
    mimeType: record.mimeType,
    size: record.size,
    sha256: record.sha256,
    updatedAt: record.updatedAt,
    ...(record.attemptId ? { attemptId: record.attemptId } : {}),
    ...(record.transport ? { transport: record.transport } : {}),
    ...(record.error ? { error: record.error } : {}),
    ...(record.errorCategory ? { errorCategory: record.errorCategory } : {}),
  };
}

export function newTransferTicket(): string {
  return randomBytes(32).toString("base64url");
}

export function newTransferId(): string {
  return `a2a-${Date.now()}-${randomBytes(8).toString("hex")}`;
}

export function newAttemptId(): string {
  return `att-${Date.now()}-${randomBytes(6).toString("hex")}`;
}

/** Derive a wire channel name; ASCII-safe for a2a-stream/2. */
export function deriveChannelName(ticket: string, transferId: string, attemptId: string): string {
  const digest = createHmac("sha256", ticket)
    .update(`openclaw-a2a-file\0${transferId}\0${attemptId}`)
    .digest("base64url");
  return `c${digest.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 120)}`;
}

export function channelFingerprint(channel: string): string {
  return channel.slice(0, 12);
}
