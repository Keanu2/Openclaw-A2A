/**
 * Tunnel 集成测试（可本地直接跑，不依赖真实 OpenClaw / 云端中继）
 *
 * 覆盖：
 * 1. 配置解析（开启 tunnel / 校验失败）
 * 2. 迷你中继 + 双 TunnelSession 双向 HTTP 转发（对齐 relay-server 协议）
 * 3. createTunnelFetch 出站路径
 *
 * 运行：
 *   cd Openclaw-A2A
 *   npm install
 *   npx tsx --test tests/tunnel-integration.test.ts
 *
 * 或跑全部测试：
 *   npm test
 */

import assert from "node:assert/strict";
import http from "node:http";
import { describe, it, before, after } from "node:test";
import { WebSocketServer, type WebSocket } from "ws";

import { parseConfig } from "../index.js";
import { filterHeaders } from "../src/tunnel/protocol.js";
import { createTunnelSession } from "../src/tunnel/session.js";
import { createTunnelFetch } from "../src/tunnel/tunnel-fetch.js";

// ---------------------------------------------------------------------------
// Mini relay — 行为对齐 openclaw-a2a-relay/relay-server.py 的核心路径
// ---------------------------------------------------------------------------

type DeviceMap = Map<string, WebSocket>;

function startMiniRelay(port: number): {
  wss: WebSocketServer;
  devices: DeviceMap;
  close: () => Promise<void>;
} {
  const devices: DeviceMap = new Map();
  const pending = new Map<string, (msg: Record<string, unknown>) => void>();

  const wss = new WebSocketServer({ host: "127.0.0.1", port });

  wss.on("connection", (ws) => {
    let deviceId: string | null = null;

    ws.on("message", (raw) => {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(String(raw)) as Record<string, unknown>;
      } catch {
        return;
      }

      const type = String(data.type || "");

      if (!deviceId) {
        if (type !== "register" || typeof data.device_id !== "string") {
          ws.send(JSON.stringify({ type: "error", error: "first message must be register" }));
          ws.close();
          return;
        }
        deviceId = data.device_id;
        const old = devices.get(deviceId);
        if (old && old !== ws) {
          try {
            old.close();
          } catch {
            // ignore
          }
        }
        devices.set(deviceId, ws);
        ws.send(
          JSON.stringify({
            type: "registered",
            device_id: deviceId,
            timestamp: new Date().toISOString(),
          }),
        );
        return;
      }

      if (type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
        return;
      }

      if (type === "forward_response") {
        const mid = String(data.message_id || "");
        const waiter = pending.get(mid);
        if (waiter) {
          pending.delete(mid);
          waiter(data);
        }
        return;
      }

      if (type === "forward_request") {
        const messageId = String(data.message_id || "");
        const target = String(data.target_device || "");
        const targetWs = devices.get(target);
        if (!messageId || !target || !data.http_request) {
          ws.send(
            JSON.stringify({
              type: "error",
              message_id: messageId || null,
              error: "Invalid forward_request",
            }),
          );
          return;
        }
        if (!targetWs) {
          ws.send(
            JSON.stringify({
              type: "error",
              message_id: messageId,
              error: `Device ${target} not found`,
            }),
          );
          return;
        }

        const timeoutSec = typeof data.timeout === "number" ? data.timeout : 30;
        const timer = setTimeout(() => {
          if (pending.has(messageId)) {
            pending.delete(messageId);
            ws.send(
              JSON.stringify({
                type: "error",
                message_id: messageId,
                error: "timeout",
              }),
            );
          }
        }, timeoutSec * 1000);

        pending.set(messageId, (response) => {
          clearTimeout(timer);
          ws.send(JSON.stringify(response));
        });

        targetWs.send(
          JSON.stringify({
            type: "forward_request",
            message_id: messageId,
            source_device: deviceId,
            target_device: target,
            http_request: data.http_request,
            timeout: timeoutSec,
          }),
        );
      }
    });

    ws.on("close", () => {
      if (deviceId && devices.get(deviceId) === ws) {
        devices.delete(deviceId);
      }
    });
  });

  return {
    wss,
    devices,
    close: () =>
      new Promise<void>((resolve, reject) => {
        wss.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

function startLocalService(
  port: number,
  handler: (req: http.IncomingMessage, body: string) => { status: number; body: string; headers?: Record<string, string> },
): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const out = handler(req, body);
        res.writeHead(out.status, {
          "content-type": "application/json",
          ...(out.headers || {}),
        });
        res.end(out.body);
      });
    });
    server.listen(port, "127.0.0.1", () => resolve(server));
    server.on("error", reject);
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

const quietLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

// ---------------------------------------------------------------------------
// 1. 配置解析
// ---------------------------------------------------------------------------

describe("tunnel config parsing", () => {
  it("defaults to tunnel disabled when omitted", () => {
    const cfg = parseConfig({
      agentCard: { name: "t", skills: ["chat"] },
      server: { port: 18800 },
    });
    assert.equal(cfg.tunnel?.enabled ?? false, false);
  });

  it("parses enabled tunnel and peer tunnelDeviceId", () => {
    const cfg = parseConfig({
      agentCard: { name: "t", skills: ["chat"] },
      server: { port: 18800 },
      tunnel: {
        enabled: true,
        relayUrl: "ws://127.0.0.1:18080",
        deviceId: "office-a",
      },
      peers: [
        {
          name: "home",
          agentCardUrl: "http://127.0.0.1:18800/.well-known/agent-card.json",
          tunnelDeviceId: "home-b",
        },
      ],
    });
    assert.equal(cfg.tunnel?.enabled, true);
    assert.equal(cfg.tunnel?.relayUrl, "ws://127.0.0.1:18080");
    assert.equal(cfg.tunnel?.deviceId, "office-a");
    assert.equal(cfg.tunnel?.localServicePort, 18800);
    assert.equal(cfg.peers[0]?.tunnelDeviceId, "home-b");
  });

  it("rejects enabled tunnel without relayUrl/deviceId", () => {
    assert.throws(
      () =>
        parseConfig({
          tunnel: { enabled: true, relayUrl: "ws://x", deviceId: "" },
        }),
      /relayUrl and tunnel.deviceId/,
    );
  });

  it("rejects non-ws relayUrl", () => {
    assert.throws(
      () =>
        parseConfig({
          tunnel: {
            enabled: true,
            relayUrl: "http://example.com",
            deviceId: "a",
          },
        }),
      /ws:\/\/ or wss:\/\//,
    );
  });
});

describe("filterHeaders", () => {
  it("strips hop-by-hop headers like tunnel-client", () => {
    const out = filterHeaders({
      Host: "evil",
      "Content-Length": "9",
      Authorization: "Bearer tok",
      "Content-Type": "application/json",
      Connection: "keep-alive",
    });
    assert.equal(out["Authorization"], "Bearer tok");
    assert.equal(out["Content-Type"], "application/json");
    assert.equal(out["Host"], undefined);
    assert.equal(out["Content-Length"], undefined);
    assert.equal(out["Connection"], undefined);
  });
});

// ---------------------------------------------------------------------------
// 2. 端到端：双设备经迷你中继转发
// ---------------------------------------------------------------------------

describe("tunnel session e2e via mini relay", () => {
  const RELAY_PORT = 18081;
  const PORT_A = 18091;
  const PORT_B = 18092;

  let relay: ReturnType<typeof startMiniRelay>;
  let serverA: http.Server;
  let serverB: http.Server;

  before(async () => {
    relay = startMiniRelay(RELAY_PORT);
    serverA = await startLocalService(PORT_A, (req, body) => {
      if (req.url?.startsWith("/.well-known/")) {
        return {
          status: 200,
          body: JSON.stringify({ name: "Agent-A", url: "http://127.0.0.1:18091" }),
        };
      }
      return {
        status: 200,
        body: JSON.stringify({
          from: "A",
          method: req.method,
          path: req.url,
          echo: body,
          auth: req.headers.authorization || null,
        }),
      };
    });
    serverB = await startLocalService(PORT_B, (req, body) => {
      if (req.url?.startsWith("/.well-known/")) {
        return {
          status: 200,
          body: JSON.stringify({ name: "Agent-B", url: "http://127.0.0.1:18092" }),
        };
      }
      return {
        status: 200,
        body: JSON.stringify({
          from: "B",
          method: req.method,
          path: req.url,
          echo: body,
          auth: req.headers.authorization || null,
        }),
      };
    });
  });

  after(async () => {
    await closeServer(serverA);
    await closeServer(serverB);
    await relay.close();
  });

  it("registers two devices on the relay", async () => {
    const a = createTunnelSession({
      relayUrl: `ws://127.0.0.1:${RELAY_PORT}`,
      deviceId: "device-a",
      localServicePort: PORT_A,
      heartbeatIntervalMs: 60_000,
      logger: quietLogger,
    });
    const b = createTunnelSession({
      relayUrl: `ws://127.0.0.1:${RELAY_PORT}`,
      deviceId: "device-b",
      localServicePort: PORT_B,
      heartbeatIntervalMs: 60_000,
      logger: quietLogger,
    });

    await a.start();
    await b.start();
    assert.equal(a.isConnected, true);
    assert.equal(b.isConnected, true);
    assert.equal(relay.devices.has("device-a"), true);
    assert.equal(relay.devices.has("device-b"), true);

    await a.stop();
    await b.stop();
  });

  it("forwards HTTP POST A → B and returns body (NAT path)", async () => {
    const a = createTunnelSession({
      relayUrl: `ws://127.0.0.1:${RELAY_PORT}`,
      deviceId: "device-a2",
      localServicePort: PORT_A,
      requestTimeoutMs: 10_000,
      heartbeatIntervalMs: 60_000,
      logger: quietLogger,
    });
    const b = createTunnelSession({
      relayUrl: `ws://127.0.0.1:${RELAY_PORT}`,
      deviceId: "device-b2",
      localServicePort: PORT_B,
      requestTimeoutMs: 10_000,
      heartbeatIntervalMs: 60_000,
      logger: quietLogger,
    });

    await a.start();
    await b.start();

    const resp = await a.forward("device-b2", {
      method: "POST",
      path: "/a2a/jsonrpc",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret-b",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "message/send", id: 1 }),
    });

    assert.equal(resp.status, 200);
    const parsed = JSON.parse(resp.body) as {
      from: string;
      path: string;
      echo: string;
      auth: string | null;
    };
    assert.equal(parsed.from, "B");
    assert.equal(parsed.path, "/a2a/jsonrpc");
    assert.ok(parsed.echo.includes("message/send"));
    assert.equal(parsed.auth, "Bearer secret-b");

    await a.stop();
    await b.stop();
  });

  it("forwards B → A (reverse direction)", async () => {
    const a = createTunnelSession({
      relayUrl: `ws://127.0.0.1:${RELAY_PORT}`,
      deviceId: "device-a3",
      localServicePort: PORT_A,
      requestTimeoutMs: 10_000,
      heartbeatIntervalMs: 60_000,
      logger: quietLogger,
    });
    const b = createTunnelSession({
      relayUrl: `ws://127.0.0.1:${RELAY_PORT}`,
      deviceId: "device-b3",
      localServicePort: PORT_B,
      requestTimeoutMs: 10_000,
      heartbeatIntervalMs: 60_000,
      logger: quietLogger,
    });

    await a.start();
    await b.start();

    const resp = await b.forward("device-a3", {
      method: "GET",
      path: "/.well-known/agent-card.json",
      headers: {},
      body: "",
    });

    assert.equal(resp.status, 200);
    const card = JSON.parse(resp.body) as { name: string };
    assert.equal(card.name, "Agent-A");

    await a.stop();
    await b.stop();
  });

  it("createTunnelFetch maps fetch(url) → forward(path)", async () => {
    const a = createTunnelSession({
      relayUrl: `ws://127.0.0.1:${RELAY_PORT}`,
      deviceId: "device-a4",
      localServicePort: PORT_A,
      requestTimeoutMs: 10_000,
      heartbeatIntervalMs: 60_000,
      logger: quietLogger,
    });
    const b = createTunnelSession({
      relayUrl: `ws://127.0.0.1:${RELAY_PORT}`,
      deviceId: "device-b4",
      localServicePort: PORT_B,
      requestTimeoutMs: 10_000,
      heartbeatIntervalMs: 60_000,
      logger: quietLogger,
    });

    await a.start();
    await b.start();

    const fetchViaTunnel = createTunnelFetch(a, "device-b4");
    // host 故意写不可达地址，证明只按 path 转发
    const res = await fetchViaTunnel("http://192.0.2.1:9999/a2a/jsonrpc?x=1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hello: "tunnel-fetch" }),
    });

    assert.equal(res.status, 200);
    const parsed = (await res.json()) as { from: string; path: string; echo: string };
    assert.equal(parsed.from, "B");
    assert.equal(parsed.path, "/a2a/jsonrpc?x=1");
    assert.ok(parsed.echo.includes("tunnel-fetch"));

    await a.stop();
    await b.stop();
  });

  it("errors when target device is offline", async () => {
    const a = createTunnelSession({
      relayUrl: `ws://127.0.0.1:${RELAY_PORT}`,
      deviceId: "device-a5",
      localServicePort: PORT_A,
      requestTimeoutMs: 5_000,
      heartbeatIntervalMs: 60_000,
      logger: quietLogger,
    });
    await a.start();

    await assert.rejects(
      () =>
        a.forward("nobody-online", {
          method: "GET",
          path: "/",
          headers: {},
          body: "",
        }),
      /not found/i,
    );

    await a.stop();
  });
});
