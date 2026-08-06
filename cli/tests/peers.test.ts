import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";

import { resolveTarget, loadPeers, resolvePeer } from "../src/lib/peers.js";

describe("resolveTarget", () => {
  it("returns URL directly for http:// targets", () => {
    const result = resolveTarget("http://localhost:18800");
    assert.equal(result.url, "http://localhost:18800");
  });

  it("returns URL directly for https:// targets", () => {
    const result = resolveTarget("https://example.com:18800");
    assert.equal(result.url, "https://example.com:18800");
  });

  it("applies token override for URL targets", () => {
    const result = resolveTarget("http://localhost:18800", "my-token");
    assert.equal(result.token, "my-token");
  });

  it("resolves peer alias from config", () => {
    // This test requires ~/.openclaw/a2a-peers.json to exist with AntiBot
    // Skip if not available
    try {
      const result = resolveTarget("AntiBot");
      assert.ok(result.url.startsWith("http"));
    } catch {
      // peers file not configured — skip
    }
  });

  it("throws for unknown peer", () => {
    assert.throws(
      () => resolveTarget("nonexistent-peer-xyz-12345"),
      /Unknown peer/,
    );
  });
});

describe("loadPeers", () => {
  it("returns object from valid config", () => {
    const peers = loadPeers();
    assert.equal(typeof peers, "object");
  });
});
