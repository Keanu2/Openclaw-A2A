import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

export type AuditDirection = "inbound" | "outbound";
export type AuditEventType = "task" | "security";

export interface AuditEntry {
  ts: string;
  direction: AuditDirection;
  type: AuditEventType;
  taskId?: string;
  contextId?: string;
  peer?: string;
  status: string;
  statusCode?: number;
  durationMs?: number;
  detail?: string;
}

/**
 * Append-only JSONL audit logger.
 * Writes one JSON line per A2A call event to a dedicated audit file,
 * separate from the application's structured logs.
 */
export class AuditLogger {
  private readonly filePath: string;
  private dirEnsured = false;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  private ensureDir(): void {
    if (this.dirEnsured) return;
    this.dirEnsured = true;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
  }

  recordInbound(
    taskId: string,
    contextId: string,
    status: string,
    durationMs: number,
  ): void {
    this.write({
      ts: new Date().toISOString(),
      direction: "inbound",
      type: "task",
      taskId,
      contextId,
      status,
      durationMs,
    });
  }

  recordOutbound(
    peer: string,
    ok: boolean,
    statusCode: number,
    durationMs: number,
  ): void {
    this.write({
      ts: new Date().toISOString(),
      direction: "outbound",
      type: "task",
      peer,
      status: ok ? "success" : "failure",
      statusCode,
      durationMs,
    });
  }

  recordSecurityEvent(surface: string, reason: string): void {
    this.write({
      ts: new Date().toISOString(),
      direction: "inbound",
      type: "security",
      status: "rejected",
      detail: `${surface}: ${reason}`,
    });
  }

  /**
   * Read the last N entries from the audit log.
   * Returns entries in reverse chronological order (newest first).
   */
  async tail(count: number = 50): Promise<AuditEntry[]> {
    if (!fs.existsSync(this.filePath)) return [];

    const entries: AuditEntry[] = [];
    const input = fs.createReadStream(this.filePath, { encoding: "utf-8" });
    const rl = readline.createInterface({ input, crlfDelay: Infinity });

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line));
      } catch {
        // skip malformed lines
      }
    }

    // Return last N in reverse order
    return entries.slice(-count).reverse();
  }

  close(): void {
    // No-op — appendFileSync has no persistent handles to close
  }

  private write(entry: AuditEntry): void {
    try {
      this.ensureDir();
      fs.appendFileSync(this.filePath, JSON.stringify(entry) + "\n");
    } catch {
      // Swallow write errors — audit must not crash the gateway
    }
  }
}
