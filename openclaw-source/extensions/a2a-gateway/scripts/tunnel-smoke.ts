#!/usr/bin/env node
/**
 * 手工冒烟脚本：不依赖 OpenClaw，验证「迷你中继 + 双 TunnelSession」能否互通。
 *
 * 用法：
 *   cd openclaw-a2a-gateway-tunnel
 *   npm install
 *   npx tsx scripts/tunnel-smoke.ts
 *
 * 成功输出末尾应有：SMOKE OK
 */

import http from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { createTunnelSession } from "../src/tunnel/session.js";
import { createTunnelFetch } from "../src/tunnel/tunnel-fetch.js";

const RELAY_PORT = 18181;
const PORT_A = 18191;
const PORT_B = 18192;

function startMiniRelay(port: number) {
  const devices = new Map<string, WebSocket>();
  const pending = new Map<string, (msg: Record<string, unknown>) => void>();
  const wss = new WebSocketServer({ host: "127.0.0.1", port });

  wss.on("connection", (ws) => {
    let deviceId: string | null = null;
    ws.on("message", (raw) => {
      const data = JSON.parse(String(raw)) as Record<string, unknown>;
      const type = String(data.type || "");
      if (!deviceId) {
        deviceId = String(data.device_id);
        devices.set(deviceId, ws);
        ws.send(JSON.stringify({ type: "registered", device_id: deviceId }));
        return;
      }
      if (type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
        return;
      }
      if (type === "forward_response") {
        pending.get(String(data.message_id))?.(data);
        pending.delete(String(data.message_id));
        return;
      }
      if (type === "forward_request") {
        const mid = String(data.message_id);
        const target = String(data.target_device);
        const targetWs = devices.get(target);
        if (!targetWs) {
          ws.send(JSON.stringify({ type: "error", message_id: mid, error: `Device ${target} not found` }));
          return;
        }
        pending.set(mid, (response) => ws.send(JSON.stringify(response)));
        targetWs.send(
          JSON.stringify({
            type: "forward_request",
            message_id: mid,
            source_device: deviceId,
            target_device: target,
            http_request: data.http_request,
            timeout: data.timeout ?? 30,
          }),
        );
      }
    });
    ws.on("close", () => {
      if (deviceId && devices.get(deviceId) === ws) devices.delete(deviceId);
    });
  });

  return {
    close: () => new Promise<void>((r, j) => wss.close((e) => (e ? j(e) : r()))),
  };
}

function listen(port: number, name: string): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ name, path: req.url, body }));
      });
    });
    server.listen(port, "127.0.0.1", () => resolve(server));
    server.on("error", reject);
  });
}

async function main() {
  console.log("[1] start mini relay + local services");
  const relay = startMiniRelay(RELAY_PORT);
  const svcA = await listen(PORT_A, "A");
  const svcB = await listen(PORT_B, "B");

  console.log("[2] start tunnel sessions");
  const a = createTunnelSession({
    relayUrl: `ws://127.0.0.1:${RELAY_PORT}`,
    deviceId: "smoke-a",
    localServicePort: PORT_A,
    requestTimeoutMs: 10_000,
  });
  const b = createTunnelSession({
    relayUrl: `ws://127.0.0.1:${RELAY_PORT}`,
    deviceId: "smoke-b",
    localServicePort: PORT_B,
    requestTimeoutMs: 10_000,
  });
  await a.start();
  await b.start();

  console.log("[3] A → B via forward()");
  const r1 = await a.forward("smoke-b", {
    method: "POST",
    path: "/a2a/jsonrpc",
    headers: { "content-type": "application/json" },
    body: '{"ping":true}',
  });
  console.log("    status=", r1.status, "body=", r1.body);
  if (r1.status !== 200 || !r1.body.includes('"name":"B"')) {
    throw new Error("forward A→B failed");
  }

  console.log("[4] A → B via createTunnelFetch (host ignored)");
  const fetchB = createTunnelFetch(a, "smoke-b");
  const r2 = await fetchB("http://invalid.example:1/.well-known/agent-card.json");
  const text = await r2.text();
  console.log("    status=", r2.status, "body=", text);
  if (r2.status !== 200 || !text.includes('"name":"B"')) {
    throw new Error("tunnel fetch failed");
  }

  console.log("[5] cleanup");
  await a.stop();
  await b.stop();
  await new Promise<void>((r, j) => svcA.close((e) => (e ? j(e) : r())));
  await new Promise<void>((r, j) => svcB.close((e) => (e ? j(e) : r())));
  await relay.close();

  console.log("SMOKE OK");
}

main().catch((err) => {
  console.error("SMOKE FAILED", err);
  process.exit(1);
});
