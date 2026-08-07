/**
 * Embedded tunnel session — logic aligned with a2a-relay-2/tunnel-client/client.js
 *
 * Differences vs standalone CLI (intentional, for in-process use):
 * - No local HTTP proxy port (--local-port); outbound uses forward() directly
 * - Library API: start()/stop()/forward() instead of process.argv + process.exit
 * - error messages with message_id reject the matching pending request
 * - Heartbeat timeout detects half-open sockets; reconnect is unlimited by default
 */

import http from "node:http";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";

import {
  MessageType,
  filterHeaders,
  type TunnelHttpRequest,
  type TunnelHttpResponse,
  type TunnelLogger,
  type TunnelRegisterExtras,
  type TunnelSessionOptions,
} from "./protocol.js";

type Pending = {
  resolve: (value: TunnelHttpResponse) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type PendingRegister = {
  resolve: () => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const defaultLogger: TunnelLogger = {
  info: (msg, data) => (data !== undefined ? console.log(msg, data) : console.log(msg)),
  warn: (msg, data) => (data !== undefined ? console.warn(msg, data) : console.warn(msg)),
  error: (msg, data) => (data !== undefined ? console.error(msg, data) : console.error(msg)),
};

/** 0 means unlimited reconnect attempts. */
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 0;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 45_000;
const DEFAULT_RECONNECT_INTERVAL_MS = 5_000;
const DEFAULT_MAX_RECONNECT_INTERVAL_MS = 60_000;

export class TunnelSession {
  private readonly opts: Required<
    Pick<
      TunnelSessionOptions,
      | "relayUrl"
      | "deviceId"
      | "localServicePort"
      | "heartbeatIntervalMs"
      | "heartbeatTimeoutMs"
      | "requestTimeoutMs"
      | "reconnectIntervalMs"
      | "maxReconnectIntervalMs"
      | "maxReconnectAttempts"
    >
  > & { logger: TunnelLogger; registerExtras?: TunnelRegisterExtras };

  private ws: WebSocket | null = null;
  private connected = false;
  /** True only after register succeeds; gates auto-reconnect. */
  private running = false;
  private shouldReconnect = false;
  private reconnectAttempts = 0;
  private reconnectScheduled = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /** Updated on any inbound WS traffic (app message or protocol pong). */
  private lastRecvAt = 0;
  private readonly pendingRequests = new Map<string, Pending>();
  private starting: Promise<void> | null = null;
  private registerWait: PendingRegister | null = null;
  /** After enriched REGISTER is rejected, stick to device_id-only. */
  private preferPlainRegister = false;

  constructor(options: TunnelSessionOptions) {
    this.opts = {
      relayUrl: options.relayUrl,
      deviceId: options.deviceId,
      localServicePort: options.localServicePort,
      heartbeatIntervalMs: options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
      heartbeatTimeoutMs: options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS,
      requestTimeoutMs: options.requestTimeoutMs ?? 300_000,
      reconnectIntervalMs: options.reconnectIntervalMs ?? DEFAULT_RECONNECT_INTERVAL_MS,
      maxReconnectIntervalMs: options.maxReconnectIntervalMs ?? DEFAULT_MAX_RECONNECT_INTERVAL_MS,
      maxReconnectAttempts: options.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS,
      registerExtras: options.registerExtras,
      logger: options.logger ?? defaultLogger,
    };
  }

  get isConnected(): boolean {
    return this.connected;
  }

  get deviceId(): string {
    return this.opts.deviceId;
  }

  async start(): Promise<void> {
    if (this.starting) return this.starting;
    this.starting = this.doStart();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private async doStart(): Promise<void> {
    this.shouldReconnect = true;
    this.running = false;
    this.reconnectAttempts = 0;
    this.clearReconnectTimer();
    try {
      await this.connectAndRegister();
      this.running = true;
      this.startHeartbeat();
      this.opts.logger.info(
        `a2a-tunnel: connected as ${this.opts.deviceId} → ${this.opts.relayUrl} (local service :${this.opts.localServicePort})`,
      );
    } catch (err) {
      this.shouldReconnect = false;
      this.running = false;
      this.stopHeartbeat();
      this.clearRegisterWait(new Error("Tunnel start aborted"));
      this.detachSocket();
      this.connected = false;
      throw err;
    }
  }

  async stop(): Promise<void> {
    this.shouldReconnect = false;
    this.running = false;
    this.stopHeartbeat();
    this.clearReconnectTimer();
    this.clearRegisterWait(new Error("Tunnel stopped"));
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Tunnel stopped"));
      this.pendingRequests.delete(id);
    }
    this.detachSocket();
    this.connected = false;
    this.opts.logger.info("a2a-tunnel: stopped");
  }

  private clearRegisterWait(err?: Error): void {
    if (!this.registerWait) return;
    clearTimeout(this.registerWait.timer);
    if (err) this.registerWait.reject(err);
    this.registerWait = null;
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectScheduled = false;
  }

  /**
   * Outbound: same as tunnel-client sendForwardRequest + waiting for forward_response.
   */
  async forward(
    targetDevice: string,
    httpRequest: TunnelHttpRequest,
    timeoutMs = this.opts.requestTimeoutMs,
  ): Promise<TunnelHttpResponse> {
    if (!this.connected || !this.ws) {
      throw new Error("Tunnel not connected");
    }

    const messageId = randomUUID();
    const message = {
      type: MessageType.FORWARD_REQUEST,
      message_id: messageId,
      source_device: this.opts.deviceId,
      target_device: targetDevice,
      http_request: {
        method: httpRequest.method,
        path: httpRequest.path,
        headers: filterHeaders(httpRequest.headers),
        body: httpRequest.body ?? "",
      },
      timeout: Math.floor(timeoutMs / 1000),
    };

    return new Promise<TunnelHttpResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(messageId);
        reject(new Error(`Tunnel timeout: ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingRequests.set(messageId, { resolve, reject, timer });

      try {
        this.ws!.send(JSON.stringify(message));
      } catch (err) {
        clearTimeout(timer);
        this.pendingRequests.delete(messageId);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private buildRegisterPayload(): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      type: MessageType.REGISTER,
      device_id: this.opts.deviceId,
    };
    const extras = this.opts.registerExtras;
    if (!this.preferPlainRegister && extras) {
      if (extras.dataset) payload.dataset = extras.dataset;
      if (extras.serviceId) payload.service_id = extras.serviceId;
      if (extras.agentCard) payload.agent_card = extras.agentCard;
    }
    return payload;
  }

  private async connectAndRegister(): Promise<void> {
    await this.openSocket();
    const tryRegister = async (): Promise<void> => {
      const registered = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (this.registerWait) {
            this.registerWait = null;
            reject(new Error("Tunnel register timeout"));
          }
        }, 10_000);
        this.registerWait = { resolve, reject, timer };
      });
      const payload = this.buildRegisterPayload();
      if (!this.send(payload)) {
        this.clearRegisterWait(new Error("Failed to send register message"));
        this.forceCloseSocket();
        throw new Error("Failed to send register message");
      }
      await registered;
    };

    try {
      await tryRegister();
    } catch (err) {
      const hadExtras =
        !this.preferPlainRegister &&
        Boolean(this.opts.registerExtras?.dataset || this.opts.registerExtras?.serviceId);
      if (hadExtras) {
        this.opts.logger.warn(
          "Tunnel enriched REGISTER failed; falling back to device_id-only",
          { error: err instanceof Error ? err.message : String(err) },
        );
        this.preferPlainRegister = true;
        this.forceCloseSocket();
        await this.openSocket();
        try {
          await tryRegister();
        } catch (err2) {
          this.forceCloseSocket();
          throw err2;
        }
      } else {
        // Leave a half-open/unregistered socket; force teardown so close→reconnect can run.
        this.forceCloseSocket();
        throw err;
      }
    }
    this.reconnectAttempts = 0;
  }

  private openSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.detachSocket();

      const ws = new WebSocket(this.opts.relayUrl);
      this.ws = ws;
      let settled = false;

      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("Tunnel connection timeout"));
        try {
          ws.terminate();
        } catch {
          // ignore
        }
      }, 10_000);

      ws.on("open", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.connected = true;
        this.lastRecvAt = Date.now();
        resolve();
      });

      ws.on("message", (data) => {
        this.lastRecvAt = Date.now();
        this.handleMessage(data.toString());
      });

      ws.on("pong", () => {
        this.lastRecvAt = Date.now();
      });

      ws.on("error", (err) => {
        this.opts.logger.error(`a2a-tunnel: websocket error: ${err.message}`);
        this.connected = false;
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(err);
      });

      ws.on("close", () => {
        this.connected = false;
        this.opts.logger.warn("a2a-tunnel: websocket closed");
        this.scheduleReconnect();
      });
    });
  }

  /** Drop local socket reference without scheduling reconnect (used by stop/start abort). */
  private detachSocket(): void {
    if (!this.ws) return;
    const ws = this.ws;
    this.ws = null;
    try {
      ws.removeAllListeners();
      ws.close();
    } catch {
      // ignore
    }
  }

  /** Tear down a live/zombie socket; close handler schedules reconnect when running. */
  private forceCloseSocket(): void {
    this.connected = false;
    const ws = this.ws;
    if (!ws) {
      this.scheduleReconnect();
      return;
    }
    try {
      // terminate() is more reliable than close() for half-open / stuck Send-Q sockets
      ws.terminate();
    } catch {
      this.ws = null;
      this.scheduleReconnect();
    }
  }

  private reconnectDelayMs(attempt: number): number {
    const exp = Math.min(attempt - 1, 6); // cap exponential growth
    const delay = this.opts.reconnectIntervalMs * 2 ** exp;
    return Math.min(delay, this.opts.maxReconnectIntervalMs);
  }

  private scheduleReconnect(): void {
    // Only reconnect after a successful start (avoid racing failed open/close)
    if (!this.shouldReconnect || !this.running) return;
    if (this.reconnectScheduled) return;

    const max = this.opts.maxReconnectAttempts;
    if (max > 0 && this.reconnectAttempts >= max) {
      this.opts.logger.error("a2a-tunnel: max reconnect attempts reached");
      return;
    }

    this.reconnectAttempts += 1;
    const attempt = this.reconnectAttempts;
    const delay = this.reconnectDelayMs(attempt);
    const maxLabel = max > 0 ? String(max) : "∞";
    this.reconnectScheduled = true;
    this.opts.logger.info(
      `a2a-tunnel: reconnecting (${attempt}/${maxLabel}) in ${delay}ms`,
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectScheduled = false;
      if (!this.shouldReconnect || !this.running) return;
      void this.connectAndRegister()
        .then(() => {
          this.startHeartbeat();
          this.opts.logger.info(
            `a2a-tunnel: reconnected as ${this.opts.deviceId} → ${this.opts.relayUrl}`,
          );
        })
        .catch((err) => {
          this.opts.logger.error(
            `a2a-tunnel: reconnect failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          // register/open failure may not always emit close; ensure another attempt
          this.scheduleReconnect();
        });
    }, delay);
  }

  private handleMessage(raw: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(raw) as Record<string, unknown>;
    } catch (err) {
      this.opts.logger.error(
        `a2a-tunnel: failed to parse message: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    const type = String(message.type || "");

    switch (type) {
      case MessageType.FORWARD_REQUEST:
        void this.handleInboundForward(message);
        break;
      case MessageType.FORWARD_RESPONSE:
        this.handleForwardResponse(message);
        break;
      case MessageType.ERROR: {
        const messageId = typeof message.message_id === "string" ? message.message_id : null;
        const errText = typeof message.error === "string" ? message.error : "Tunnel error";
        this.opts.logger.error(`a2a-tunnel: error from relay: ${errText}`);
        if (messageId) {
          const pending = this.pendingRequests.get(messageId);
          if (pending) {
            clearTimeout(pending.timer);
            this.pendingRequests.delete(messageId);
            pending.reject(new Error(errText));
          }
        } else if (this.registerWait) {
          clearTimeout(this.registerWait.timer);
          this.registerWait.reject(new Error(errText));
          this.registerWait = null;
        }
        break;
      }
      case MessageType.PING:
        this.send({ type: MessageType.PONG });
        break;
      case MessageType.PONG:
        break;
      case MessageType.REGISTERED:
        if (this.registerWait) {
          clearTimeout(this.registerWait.timer);
          this.registerWait.resolve();
          this.registerWait = null;
        }
        break;
      default:
        this.opts.logger.warn(`a2a-tunnel: unknown message type: ${type}`);
    }
  }

  private handleForwardResponse(message: Record<string, unknown>): void {
    const messageId = typeof message.message_id === "string" ? message.message_id : "";
    const pending = this.pendingRequests.get(messageId);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pendingRequests.delete(messageId);

    const httpResponse = message.http_response as TunnelHttpResponse | undefined;
    if (!httpResponse || typeof httpResponse.status !== "number") {
      pending.reject(new Error("Invalid forward_response"));
      return;
    }
    pending.resolve({
      status: httpResponse.status,
      headers: httpResponse.headers || {},
      body: typeof httpResponse.body === "string" ? httpResponse.body : String(httpResponse.body ?? ""),
    });
  }

  /** Inbound path: same as tunnel-client handler → localServicePort */
  private async handleInboundForward(message: Record<string, unknown>): Promise<void> {
    const messageId = String(message.message_id || "");
    const httpRequest = message.http_request as TunnelHttpRequest | undefined;
    const path = httpRequest?.path || "/";
    const method = (httpRequest?.method || "GET").toUpperCase();
    const localUrl = `http://127.0.0.1:${this.opts.localServicePort}${path}`;

    try {
      const localResponse = await this.makeLocalHttpRequest(
        method,
        localUrl,
        httpRequest?.body ?? "",
        httpRequest?.headers || {},
      );

      this.send({
        type: MessageType.FORWARD_RESPONSE,
        message_id: messageId,
        http_response: {
          status: localResponse.status,
          headers: filterHeaders(localResponse.headers),
          body: localResponse.body,
        },
        status: localResponse.status,
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.opts.logger.error(`a2a-tunnel: inbound forward failed: ${errMsg}`);
      this.send({
        type: MessageType.FORWARD_RESPONSE,
        message_id: messageId,
        http_response: {
          status: 500,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ error: errMsg }),
        },
        status: 500,
      });
    }
  }

  private makeLocalHttpRequest(
    method: string,
    url: string,
    body: string,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<TunnelHttpResponse> {
    return new Promise((resolve, reject) => {
      const forwardHeaders = filterHeaders(headers);
      const options: http.RequestOptions = {
        method,
        headers: { ...forwardHeaders },
      };

      const bodyStr = body || "";
      if (method !== "GET" && method !== "HEAD") {
        (options.headers as Record<string, string | number>)["content-length"] =
          Buffer.byteLength(bodyStr);
      }

      const req = http.request(url, options, (res) => {
        let responseData = "";
        res.on("data", (chunk) => {
          responseData += chunk.toString();
        });
        res.on("end", () => {
          resolve({
            status: res.statusCode || 500,
            headers: res.headers as Record<string, string | string[] | undefined>,
            body: responseData,
          });
        });
        res.on("error", reject);
      });

      req.setTimeout(this.opts.requestTimeoutMs, () => {
        req.destroy();
        reject(new Error(`Local request timeout after ${this.opts.requestTimeoutMs}ms`));
      });
      req.on("error", reject);

      if (method !== "GET" && method !== "HEAD" && bodyStr) {
        req.write(bodyStr);
      }
      req.end();
    });
  }

  private send(message: Record<string, unknown>): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.opts.logger.warn("a2a-tunnel: cannot send, socket not open");
      return false;
    }
    try {
      this.ws.send(JSON.stringify(message));
      return true;
    } catch (err) {
      this.opts.logger.error(
        `a2a-tunnel: send failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.lastRecvAt = Date.now();
    this.heartbeatTimer = setInterval(() => {
      if (!this.connected || !this.ws) return;

      const silentFor = Date.now() - this.lastRecvAt;
      if (silentFor >= this.opts.heartbeatTimeoutMs) {
        this.opts.logger.warn(
          `a2a-tunnel: heartbeat timeout (${silentFor}ms without recv), forcing reconnect`,
        );
        this.forceCloseSocket();
        return;
      }

      this.send({ type: MessageType.PING });
      try {
        // Protocol-level ping helps some middleboxes; also drives the 'pong' handler.
        this.ws.ping();
      } catch {
        // ignore — app-level PING already sent
      }
    }, this.opts.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}

export function createTunnelSession(options: TunnelSessionOptions): TunnelSession {
  return new TunnelSession(options);
}
