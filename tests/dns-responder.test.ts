import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  sanitizeInstanceName,
  resolveAdvertiseHostname,
  encodeTxtData,
  MdnsResponder,
  buildMdnsAdvertiseConfig,
  MDNS_ADVERTISE_DEFAULTS,
} from "../src/dns-responder.js";
import type { MdnsAdvertiseConfig } from "../src/dns-responder.js";

// ---------------------------------------------------------------------------
// sanitizeInstanceName
// ---------------------------------------------------------------------------

describe("sanitizeInstanceName", () => {
  it("passes through a normal name", () => {
    assert.equal(sanitizeInstanceName("MyAgent"), "MyAgent");
  });

  it("strips control characters", () => {
    assert.equal(sanitizeInstanceName("My\x00\x1fAgent"), "MyAgent");
  });

  it("trims whitespace", () => {
    assert.equal(sanitizeInstanceName("  Agent  "), "Agent");
  });

  it("truncates to 63 bytes", () => {
    const long = "A".repeat(100);
    assert.equal(sanitizeInstanceName(long).length, 63);
  });

  it("falls back to default for empty string", () => {
    assert.equal(sanitizeInstanceName(""), "a2a-gateway");
  });

  it("falls back to default for whitespace-only", () => {
    assert.equal(sanitizeInstanceName("   "), "a2a-gateway");
  });
});

// ---------------------------------------------------------------------------
// resolveAdvertiseHostname
// ---------------------------------------------------------------------------

describe("resolveAdvertiseHostname", () => {
  it("returns the host as-is when not wildcard", () => {
    assert.equal(resolveAdvertiseHostname("192.168.1.10"), "192.168.1.10");
  });

  it("resolves something for 0.0.0.0 (either an IP or hostname)", () => {
    const result = resolveAdvertiseHostname("0.0.0.0");
    assert.ok(result.length > 0);
    assert.notEqual(result, "0.0.0.0");
  });

  it("resolves something for :: (IPv6 wildcard)", () => {
    const result = resolveAdvertiseHostname("::");
    assert.ok(result.length > 0);
    assert.notEqual(result, "::");
  });
});

// ---------------------------------------------------------------------------
// encodeTxtData
// ---------------------------------------------------------------------------

describe("encodeTxtData", () => {
  it("encodes key=value pairs as buffers", () => {
    const buffers = encodeTxtData({ name: "Bot", protocol: "jsonrpc" });
    assert.equal(buffers.length, 2);
    assert.equal(buffers[0].toString(), "name=Bot");
    assert.equal(buffers[1].toString(), "protocol=jsonrpc");
  });

  it("skips empty values", () => {
    const buffers = encodeTxtData({ name: "Bot", empty: "" });
    assert.equal(buffers.length, 1);
    assert.equal(buffers[0].toString(), "name=Bot");
  });

  it("returns empty array for empty input", () => {
    assert.deepEqual(encodeTxtData({}), []);
  });
});

// ---------------------------------------------------------------------------
// buildMdnsAdvertiseConfig
// ---------------------------------------------------------------------------

describe("buildMdnsAdvertiseConfig", () => {
  it("builds config with defaults when raw is empty", () => {
    const cfg = buildMdnsAdvertiseConfig({
      agentCardName: "TestBot",
      serverHost: "192.168.1.5",
      serverPort: 18800,
      inboundAuth: "none",
    });

    assert.equal(cfg.enabled, false);
    assert.equal(cfg.instanceName, "TestBot");
    assert.equal(cfg.serviceName, "_a2a._tcp.local");
    assert.equal(cfg.hostname, "192.168.1.5");
    assert.equal(cfg.port, 18800);
    assert.equal(cfg.ttl, 120);
    assert.equal(cfg.txt.name, "TestBot");
    assert.equal(cfg.txt.protocol, "jsonrpc");
    assert.equal(cfg.txt.auth_type, undefined);
  });

  it("includes auth in TXT when bearer is configured", () => {
    const cfg = buildMdnsAdvertiseConfig({
      agentCardName: "SecureBot",
      serverHost: "10.0.0.1",
      serverPort: 9000,
      inboundAuth: "bearer",
      token: "secret-token",
    });

    assert.equal(cfg.txt.auth_type, "bearer");
    assert.equal(cfg.txt.auth_token, "secret-token");
  });

  it("respects raw config overrides", () => {
    const cfg = buildMdnsAdvertiseConfig({
      agentCardName: "Bot",
      serverHost: "0.0.0.0",
      serverPort: 18800,
      inboundAuth: "none",
      raw: { enabled: true, ttl: 300, serviceName: "_custom._tcp.local" },
    });

    assert.equal(cfg.enabled, true);
    assert.equal(cfg.ttl, 300);
    assert.equal(cfg.serviceName, "_custom._tcp.local");
  });

  it("rejects TTL below minimum (10s)", () => {
    const cfg = buildMdnsAdvertiseConfig({
      agentCardName: "Bot",
      serverHost: "localhost",
      serverPort: 8080,
      inboundAuth: "none",
      raw: { ttl: 5 },
    });

    assert.equal(cfg.ttl, MDNS_ADVERTISE_DEFAULTS.ttl);
  });

  it("resolves 0.0.0.0 to a real hostname", () => {
    const cfg = buildMdnsAdvertiseConfig({
      agentCardName: "Bot",
      serverHost: "0.0.0.0",
      serverPort: 18800,
      inboundAuth: "none",
    });

    assert.notEqual(cfg.hostname, "0.0.0.0");
  });
});

// ---------------------------------------------------------------------------
// MdnsResponder lifecycle
// ---------------------------------------------------------------------------

describe("MdnsResponder", () => {
  const baseConfig: MdnsAdvertiseConfig = {
    enabled: true,
    instanceName: "TestBot",
    serviceName: "_a2a._tcp.local",
    hostname: "192.168.1.10",
    port: 18800,
    ttl: 120,
    txt: { name: "TestBot", protocol: "jsonrpc", path: "/.well-known/agent-card.json" },
  };

  const noopLog = (() => {}) as any;

  it("does not start when enabled is false", () => {
    const responder = new MdnsResponder({ ...baseConfig, enabled: false }, noopLog);
    responder.start();
    responder.stop(); // should not throw
  });

  it("start + stop lifecycle does not throw", () => {
    const responder = new MdnsResponder(baseConfig, noopLog);
    responder.start();
    responder.stop();
  });

  it("double start is idempotent", () => {
    const responder = new MdnsResponder(baseConfig, noopLog);
    responder.start();
    responder.start(); // should not throw or create duplicate sockets
    responder.stop();
  });

  it("stop without start does not throw", () => {
    const responder = new MdnsResponder(baseConfig, noopLog);
    responder.stop();
  });

  it("logs start and stop events", () => {
    const logs: string[] = [];
    const logFn = (level: string, msg: string) => logs.push(msg);
    const responder = new MdnsResponder(baseConfig, logFn as any);
    responder.start();
    responder.stop();
    assert.ok(logs.includes("mdns-responder.started"));
    assert.ok(logs.includes("mdns-responder.stopped"));
  });
});

// ---------------------------------------------------------------------------
// Integration: config → responder round-trip
// ---------------------------------------------------------------------------

describe("config → responder round-trip", () => {
  it("disabled config produces no-op responder", () => {
    const cfg = buildMdnsAdvertiseConfig({
      agentCardName: "Bot",
      serverHost: "localhost",
      serverPort: 18800,
      inboundAuth: "none",
    });
    assert.equal(cfg.enabled, false);

    // Responder should be a no-op when disabled
    const responder = new MdnsResponder(cfg, (() => {}) as any);
    responder.start();
    responder.stop();
  });

  it("enabled config produces working responder", () => {
    const cfg = buildMdnsAdvertiseConfig({
      agentCardName: "LiveBot",
      serverHost: "10.0.0.5",
      serverPort: 9999,
      inboundAuth: "bearer",
      token: "tok",
      raw: { enabled: true },
    });
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.instanceName, "LiveBot");
    assert.equal(cfg.txt.auth_type, "bearer");

    const logs: string[] = [];
    const responder = new MdnsResponder(cfg, ((_l, msg) => logs.push(msg)) as any);
    responder.start();
    assert.ok(logs.includes("mdns-responder.started"));
    responder.stop();
    assert.ok(logs.includes("mdns-responder.stopped"));
  });
});
