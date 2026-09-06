import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  publicTransferStatus,
  safeTransferName,
  type FileOffer,
  type FileTransferConfig,
  type FileTransferRecord,
  type PublicTransferStatus,
} from "./file-transfer-types.js";

const RECORD_DIR_NAME = ".a2a-transfer-state";
const VALID_ID = /^[A-Za-z0-9._-]{1,128}$/;

function recordPath(stateDir: string, transferId: string): string {
  if (!VALID_ID.test(transferId)) throw new Error("invalid transferId");
  return path.join(stateDir, `${transferId}.json`);
}

async function syncDirectory(dir: string): Promise<void> {
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(dir, "r");
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EPERM" && code !== "EISDIR") throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function atomicWriteJson(target: string, value: unknown): Promise<void> {
  const dir = path.dirname(target);
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  const temp = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const handle = await fs.promises.open(temp, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.promises.rename(temp, target);
    await syncDirectory(dir);
  } catch (error) {
    await fs.promises.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function fileTransferStateDir(config: Pick<FileTransferConfig, "receiveDir">): string {
  return path.join(config.receiveDir, RECORD_DIR_NAME);
}

export function createTransferRecord(offer: FileOffer, partPath?: string): FileTransferRecord {
  const now = new Date().toISOString();
  return {
    version: 1,
    transferId: offer.transferId,
    ...(offer.attemptId ? { attemptId: offer.attemptId } : {}),
    ...(offer.transport ? { transport: offer.transport } : {}),
    sourceDevice: offer.sourceDevice,
    targetDevice: offer.targetDevice,
    name: safeTransferName(offer.name),
    mimeType: offer.mimeType,
    size: offer.size,
    sha256: offer.sha256,
    state: "PREPARING",
    createdAt: now,
    updatedAt: now,
    ...(partPath ? { partPath } : {}),
  };
}

export class FileTransferStore {
  readonly stateDir: string;
  private readonly writes = new Map<string, Promise<void>>();

  constructor(private readonly config: Pick<FileTransferConfig, "receiveDir">) {
    this.stateDir = fileTransferStateDir(config);
  }

  async load(transferId: string): Promise<FileTransferRecord | null> {
    try {
      const raw = await fs.promises.readFile(recordPath(this.stateDir, transferId), "utf8");
      const parsed = JSON.parse(raw) as FileTransferRecord;
      return parsed?.version === 1 && parsed.transferId === transferId ? parsed : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async save(record: FileTransferRecord): Promise<void> {
    record.updatedAt = new Date().toISOString();
    const snapshot = JSON.parse(JSON.stringify(record)) as FileTransferRecord;
    const previous = this.writes.get(record.transferId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => atomicWriteJson(
      recordPath(this.stateDir, record.transferId),
      snapshot,
    ));
    this.writes.set(record.transferId, next);
    try {
      await next;
    } finally {
      if (this.writes.get(record.transferId) === next) this.writes.delete(record.transferId);
    }
  }

  async getPublicStatus(transferId: string): Promise<PublicTransferStatus | null> {
    const record = await this.load(transferId);
    return record ? publicTransferStatus(record) : null;
  }

  async recoverInterrupted(): Promise<number> {
    await fs.promises.mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    let recovered = 0;
    for (const name of await fs.promises.readdir(this.stateDir)) {
      if (!name.endsWith(".json")) continue;
      const transferId = name.slice(0, -5);
      if (!VALID_ID.test(transferId)) continue;
      const record = await this.load(transferId).catch(() => null);
      if (!record || ["DATA_COMMITTED", "COMPLETED", "FAILED_CONFIRMED", "CANCELED"].includes(record.state)) {
        continue;
      }
      if (record.state === "COMMITTING" && record.path) {
        const committed = await verifyOwnedCommittedFile(this.config.receiveDir, record).catch(() => false);
        if (committed) {
          await removeOwnedPath(this.config.receiveDir, record.partPath);
          record.state = "DATA_COMMITTED";
          record.error = undefined;
          record.partPath = undefined;
          await this.save(record);
          recovered += 1;
          continue;
        }
      }
      await removeOwnedPath(this.config.receiveDir, record.partPath);
      // Never remove record.path here. COMMITTING persists the candidate name
      // before link(2); at crash time that path may still belong to the user.
      record.state = "FAILED_CONFIRMED";
      record.error = "interrupted by gateway restart before durable commit";
      record.partPath = undefined;
      record.path = undefined;
      await this.save(record);
      recovered += 1;
    }
    return recovered;
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function removeOwnedPath(root: string, candidate?: string): Promise<void> {
  if (!candidate || !isWithin(root, candidate)) return;
  await fs.promises.rm(candidate, { force: true }).catch(() => undefined);
}

async function verifyOwnedCommittedFile(root: string, record: FileTransferRecord): Promise<boolean> {
  if (!record.path || !isWithin(root, record.path)) return false;
  const finalStat = await fs.promises.stat(record.path);
  if (!finalStat.isFile() || finalStat.size !== record.size) return false;
  if (record.partPath && isWithin(root, record.partPath)) {
    try {
      const partStat = await fs.promises.stat(record.partPath);
      if (!partStat.isFile() || partStat.dev !== finalStat.dev || partStat.ino !== finalStat.ino) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(record.path)) hash.update(chunk as Buffer);
  return hash.digest("hex") === record.sha256;
}

export async function commitPartNoClobber(
  receiveDir: string,
  desiredName: string,
  partPath: string,
  beforeLink: (candidate: string) => Promise<void>,
  afterLink?: (candidate: string) => void,
): Promise<string> {
  const parsed = path.parse(safeTransferName(desiredName));
  for (let index = 0; index < 10_000; index += 1) {
    const candidate = path.join(
      receiveDir,
      index === 0 ? parsed.base : `${parsed.name} (${index})${parsed.ext}`,
    );
    await beforeLink(candidate);
    try {
      await fs.promises.link(partPath, candidate);
      afterLink?.(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
    // Only link(2)'s EEXIST means that the candidate name is occupied. Keep
    // durability/cleanup outside that catch: retrying after the part was
    // removed would turn an already-created final file into a false ENOENT.
    await syncDirectory(receiveDir);
    await fs.promises.rm(partPath, { force: true });
    await syncDirectory(receiveDir);
    return candidate;
  }
  throw new Error("unable to allocate receive filename");
}

export interface ResolvedTransfer {
  transferId: string;
  path: string;
  name: string;
  mimeType: string;
  size: number;
  sha256: string;
}

export function resolveCommittedTransferUriSync(
  config: Pick<FileTransferConfig, "receiveDir">,
  uri: string,
  expectedName?: string,
  expectedMimeType?: string,
): ResolvedTransfer | null {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return null;
  }
  if (parsed.protocol !== "a2a-transfer:" || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash) {
    return null;
  }
  const transferId = parsed.hostname || parsed.pathname.replace(/^\/+/, "");
  if (!VALID_ID.test(transferId)) return null;
  try {
    const target = recordPath(fileTransferStateDir(config), transferId);
    const record = JSON.parse(fs.readFileSync(target, "utf8")) as FileTransferRecord;
    if (record.version !== 1 || record.transferId !== transferId) return null;
    if (record.state !== "DATA_COMMITTED" && record.state !== "COMPLETED") return null;
    if (!record.path || !isWithin(config.receiveDir, record.path)) return null;
    if (expectedName && safeTransferName(expectedName) !== record.name) return null;
    if (expectedMimeType && expectedMimeType !== record.mimeType) return null;
    const stat = fs.statSync(record.path);
    if (!stat.isFile() || stat.size !== record.size) return null;
    if (record.state !== "COMPLETED") {
      record.state = "COMPLETED";
      record.updatedAt = new Date().toISOString();
      const temp = `${target}.${process.pid}.resolve.tmp`;
      fs.writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      fs.renameSync(temp, target);
    }
    return {
      transferId,
      path: record.path,
      name: path.basename(record.path),
      mimeType: record.mimeType,
      size: record.size,
      sha256: record.sha256,
    };
  } catch {
    return null;
  }
}

/** Wait for receiver store to reach DATA_COMMITTED before treating a2a-transfer:// as valid. */
export async function resolveCommittedTransferUri(
  config: Pick<FileTransferConfig, "receiveDir">,
  uri: string,
  expectedName?: string,
  expectedMimeType?: string,
  timeoutMs = 60_000,
  pollMs = 200,
): Promise<ResolvedTransfer | null> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    const resolved = resolveCommittedTransferUriSync(config, uri, expectedName, expectedMimeType);
    if (resolved) return resolved;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
