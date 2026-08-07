/**
 * Tests for metrics endpoint authentication.
 * Verifies that the /a2a/metrics endpoint respects the metricsAuth config.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createMockWebSocketClass,
  registerPlugin,
} from "./helpers.js";

function makeConfig(port: number, overrides: Record<string, unknown> = {}) {
  return {
    agentCard: {
      name: "Metrics Auth Test",
      description: "test",
      url: `http://127.0.0.1:${port}/a2a/jsonrpc`,
      skills: [{ name: "chat" }],
    },
    server: { host: "127.0.0.1", port },
    peers: [],
    security: {
      inboundAuth: "bearer",
      token: "test-secret-token",
    },
    routing: { defaultAgentId: "default" },
    ...overrides,
  };
}

describe("metrics endpoint auth", () => {
  it("returns metrics without auth when metricsAuth is none (default)", async () => {
    const port = 19100 + Math.floor(Math.random() * 100);
    const originalWebSocket = (globalThis as any).WebSocket;
    (globalThis as any).WebSocket = createMockWebSocketClass();

    try {
      const { service } = registerPlugin(makeConfig(port, {
        observability: { metricsAuth: "none" },
      }));
      assert(service, "service should be registered");
      await service.start();

      const res = await fetch(`http://127.0.0.1:${port}/a2a/metrics`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert(typeof body === "object" && body !== null, "should return metrics object");

      await service.stop();
    } finally {
      (globalThis as any).WebSocket = originalWebSocket;
    }
  });

  it("rejects metrics request without token when metricsAuth is bearer", async () => {
    const port = 19200 + Math.floor(Math.random() * 100);
    const originalWebSocket = (globalThis as any).WebSocket;
    (globalThis as any).WebSocket = createMockWebSocketClass();

    try {
      const { service } = registerPlugin(makeConfig(port, {
        observability: { metricsAuth: "bearer" },
      }));
      assert(service, "service should be registered");
      await service.start();

      const res = await fetch(`http://127.0.0.1:${port}/a2a/metrics`);
      assert.equal(res.status, 401);

      await service.stop();
    } finally {
      (globalThis as any).WebSocket = originalWebSocket;
    }
  });

  it("rejects metrics request with wrong token when metricsAuth is bearer", async () => {
    const port = 19300 + Math.floor(Math.random() * 100);
    const originalWebSocket = (globalThis as any).WebSocket;
    (globalThis as any).WebSocket = createMockWebSocketClass();

    try {
      const { service } = registerPlugin(makeConfig(port, {
        observability: { metricsAuth: "bearer" },
      }));
      assert(service, "service should be registered");
      await service.start();

      const res = await fetch(`http://127.0.0.1:${port}/a2a/metrics`, {
        headers: { Authorization: "Bearer wrong-token" },
      });
      assert.equal(res.status, 401);

      await service.stop();
    } finally {
      (globalThis as any).WebSocket = originalWebSocket;
    }
  });

  it("accepts metrics request with valid token when metricsAuth is bearer", async () => {
    const port = 19400 + Math.floor(Math.random() * 100);
    const originalWebSocket = (globalThis as any).WebSocket;
    (globalThis as any).WebSocket = createMockWebSocketClass();

    try {
      const { service } = registerPlugin(makeConfig(port, {
        observability: { metricsAuth: "bearer" },
      }));
      assert(service, "service should be registered");
      await service.start();

      const res = await fetch(`http://127.0.0.1:${port}/a2a/metrics`, {
        headers: { Authorization: "Bearer test-secret-token" },
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert(typeof body === "object" && body !== null, "should return metrics object");

      await service.stop();
    } finally {
      (globalThis as any).WebSocket = originalWebSocket;
    }
  });
});
