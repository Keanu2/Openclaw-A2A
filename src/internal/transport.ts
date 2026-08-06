/**
 * A2A Gateway — HTTP Transport Layer
 *
 * OpenClaw gateway-internal module — NOT part of the A2A spec.
 * Uses only Node.js built-in modules (http, https).
 */

import http from "node:http";
import https from "node:https";
import type { A2AEnvelope } from "./types-internal.js";

// ---------------------------------------------------------------------------
// Inbound header extraction
// ---------------------------------------------------------------------------

export interface InboundHeaders {
  signature: string;
  timestamp: number;
  nonce: string;
  sourceGatewayId: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_BODY_BYTES = 2 * 1024 * 1024; // 2 MB
const INBOX_PATH = "/a2a/v1/inbox";
const OUTBOUND_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// InboundServer
// ---------------------------------------------------------------------------

export interface InboundHandlers {
  onMessage(
    envelope: A2AEnvelope,
    rawBody: string,
    headers: InboundHeaders,
  ): Promise<{ statusCode: number; body: string }>;
}

export class InboundServer {
  private server: http.Server | null = null;
  private readonly config: { host: string; port: number };
  private readonly handlers: InboundHandlers;

  constructor(
    config: { host: string; port: number },
    handlers: InboundHandlers,
  ) {
    this.config = config;
    this.handlers = handlers;
  }

  /** Start the HTTP server. Resolves once the server is listening. */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });

      this.server.once("error", reject);

      this.server.listen(this.config.port, this.config.host, () => {
        this.server!.removeListener("error", reject);
        resolve();
      });
    });
  }

  /** Gracefully stop the server. */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => resolve());
    });
  }

  // -------------------------------------------------------------------------
  // Internal request handler
  // -------------------------------------------------------------------------

  private handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    // Route check
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://localhost");
    } catch {
      this.sendJson(res, 400, { error: "Malformed URL" });
      return;
    }
    if (url.pathname !== INBOX_PATH) {
      this.sendJson(res, 404, { error: "Not found" });
      return;
    }

    // Method check
    if (req.method !== "POST") {
      this.sendJson(res, 405, { error: "Method not allowed" });
      return;
    }

    // Content-Type check
    const contentType = req.headers["content-type"] ?? "";
    if (!contentType.includes("application/json")) {
      this.sendJson(res, 400, { error: "Content-Type must be application/json" });
      return;
    }

    // Read body with size limit
    this.readBody(req)
      .then((rawBody) => this.processBody(rawBody, req, res))
      .catch((err) => {
        if ((err as { code?: string }).code === "PAYLOAD_TOO_LARGE") {
          this.sendJson(res, 413, { error: "Payload too large" });
        } else {
          this.sendJson(res, 500, { error: "Internal server error" });
        }
      });
  }

  private async processBody(
    rawBody: string,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    // Parse JSON
    let envelope: A2AEnvelope;
    try {
      envelope = JSON.parse(rawBody) as A2AEnvelope;
    } catch {
      this.sendJson(res, 400, { error: "Invalid JSON" });
      return;
    }

    // Extract security headers
    const headers: InboundHeaders = {
      signature: this.headerString(req, "x-a2a-signature"),
      timestamp: Number(this.headerString(req, "x-a2a-timestamp")) || 0,
      nonce: this.headerString(req, "x-a2a-nonce"),
      sourceGatewayId: this.headerString(req, "x-a2a-source-gateway"),
    };

    // Delegate to handler
    try {
      const result = await this.handlers.onMessage(envelope, rawBody, headers);
      this.sendJson(res, result.statusCode, JSON.parse(result.body));
    } catch {
      this.sendJson(res, 500, { error: "Internal server error" });
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let totalBytes = 0;

      req.on("data", (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_BODY_BYTES) {
          req.destroy();
          const err = new Error("Payload too large");
          (err as Error & { code: string }).code = "PAYLOAD_TOO_LARGE";
          reject(err);
          return;
        }
        chunks.push(chunk);
      });

      req.on("end", () => {
        resolve(Buffer.concat(chunks).toString("utf8"));
      });

      req.on("error", reject);
    });
  }

  private headerString(req: http.IncomingMessage, name: string): string {
    const value = req.headers[name];
    if (Array.isArray(value)) return value[0] ?? "";
    return value ?? "";
  }

  private sendJson(
    res: http.ServerResponse,
    statusCode: number,
    body: unknown,
  ): void {
    const payload = JSON.stringify(body);
    res.writeHead(statusCode, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload, "utf8"),
    });
    res.end(payload);
  }
}

// ---------------------------------------------------------------------------
// OutboundClient
// ---------------------------------------------------------------------------

export interface OutboundResult {
  success: boolean;
  statusCode: number;
  body: string;
}

export class OutboundClient {
  /**
   * Send an A2A envelope to a remote gateway.
   */
  send(
    url: string,
    envelope: A2AEnvelope,
    signature: string,
    timestamp: number,
    nonce: string,
    sourceGatewayId: string,
  ): Promise<OutboundResult> {
    return new Promise((resolve) => {
      const parsed = new URL(url);
      const isHttps = parsed.protocol === "https:";
      const transport = isHttps ? https : http;

      const body = JSON.stringify(envelope);

      const options: http.RequestOptions = {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body, "utf8"),
          "X-A2A-Signature": signature,
          "X-A2A-Timestamp": String(timestamp),
          "X-A2A-Nonce": nonce,
          "X-A2A-Source-Gateway": sourceGatewayId,
        },
        timeout: OUTBOUND_TIMEOUT_MS,
      };

      const req = transport.request(options, (res) => {
        const chunks: Buffer[] = [];

        res.on("data", (chunk: Buffer) => chunks.push(chunk));

        res.on("end", () => {
          const responseBody = Buffer.concat(chunks).toString("utf8");
          const statusCode = res.statusCode ?? 0;
          resolve({
            success: statusCode >= 200 && statusCode < 300,
            statusCode,
            body: responseBody,
          });
        });

        res.on("error", () => {
          resolve({ success: false, statusCode: 0, body: "Response read error" });
        });
      });

      req.on("timeout", () => {
        req.destroy();
        resolve({ success: false, statusCode: 0, body: "Request timeout" });
      });

      req.on("error", (err) => {
        resolve({
          success: false,
          statusCode: 0,
          body: err.message || "Connection error",
        });
      });

      req.end(body);
    });
  }
}
