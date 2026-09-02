import path from "node:path";

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
  | "COMPLETED"
  | "FAILED_CONFIRMED"
  | "CANCELED";

export interface FileTransferRecord {
  version: 1;
  transferId: string;
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
  error?: string;
}

export function validateFileOffer(offer: FileOffer, maxBytes: number): void {
  if (!offer || typeof offer !== "object") throw new Error("invalid file offer");
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(offer.transferId)) throw new Error("invalid transferId");
  if (!/^[a-f0-9]{64}$/.test(offer.sha256)) throw new Error("invalid sha256");
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(offer.ticket)) throw new Error("invalid ticket");
  if (!Number.isSafeInteger(offer.size) || offer.size < 0 || offer.size > maxBytes) {
    throw new Error(`invalid file size: ${offer.size}`);
  }
  if (typeof offer.sourceDevice !== "string" || !/^[A-Za-z0-9._:-]{1,256}$/.test(offer.sourceDevice)) {
    throw new Error("invalid sourceDevice");
  }
  if (typeof offer.targetDevice !== "string" || !/^[A-Za-z0-9._:-]{1,256}$/.test(offer.targetDevice)) {
    throw new Error("invalid targetDevice");
  }
  if (typeof offer.name !== "string" || Buffer.byteLength(offer.name, "utf8") > 1024) {
    throw new Error("invalid file name");
  }
  if (typeof offer.mimeType !== "string" || offer.mimeType.length > 256) {
    throw new Error("invalid MIME type");
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
    ...(record.error ? { error: record.error } : {}),
  };
}
