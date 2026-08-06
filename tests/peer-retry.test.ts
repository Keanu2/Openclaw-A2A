import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isRetryable, withRetry } from "../src/peer-retry.js";
import type { OutboundSendResult, RetryConfig } from "../src/types.js";

describe("isRetryable", () => {
  it("returns false for successful result", () => {
    assert.equal(isRetryable({ ok: true, statusCode: 200, response: {} }), false);
  });

  it("returns true for 500 error", () => {
    assert.equal(isRetryable({ ok: false, statusCode: 500, response: {} }), true);
  });

  it("returns true for 502 error", () => {
    assert.equal(isRetryable({ ok: false, statusCode: 502, response: {} }), true);
  });

  it("returns true for 429 rate limit", () => {
    assert.equal(isRetryable({ ok: false, statusCode: 429, response: {} }), true);
  });

  it("returns false for 400 client error", () => {
    assert.equal(isRetryable({ ok: false, statusCode: 400, response: {} }), false);
  });

  it("returns false for 404 not found", () => {
    assert.equal(isRetryable({ ok: false, statusCode: 404, response: {} }), false);
  });

  it("returns true for ECONNREFUSED error", () => {
    assert.equal(isRetryable(new Error("connect ECONNREFUSED 127.0.0.1:18800")), true);
  });

  it("returns true for fetch failed error", () => {
    assert.equal(isRetryable(new Error("fetch failed")), true);
  });

  it("returns false for non-network Error", () => {
    assert.equal(isRetryable(new Error("Invalid argument")), false);
  });
});

describe("withRetry", () => {
  const fastConfig: RetryConfig = {
    maxRetries: 2,
    baseDelayMs: 10,
    maxDelayMs: 50,
  };

  it("returns immediately on success", async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        return { ok: true, statusCode: 200, response: { data: "ok" } };
      },
      fastConfig,
    );

    assert.equal(calls, 1);
    assert.equal(result.ok, true);
  });

  it("retries on 500 and eventually succeeds", async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 3) {
          return { ok: false, statusCode: 500, response: { error: "server error" } };
        }
        return { ok: true, statusCode: 200, response: { data: "ok" } };
      },
      fastConfig,
    );

    assert.equal(calls, 3);
    assert.equal(result.ok, true);
  });

  it("does not retry on 400", async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        return { ok: false, statusCode: 400, response: { error: "bad request" } };
      },
      fastConfig,
    );

    assert.equal(calls, 1);
    assert.equal(result.ok, false);
    assert.equal(result.statusCode, 400);
  });

  it("exhausts retries and returns last failure", async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        return { ok: false, statusCode: 503, response: { error: "unavailable" } };
      },
      fastConfig,
    );

    // 1 initial + 2 retries = 3 total
    assert.equal(calls, 3);
    assert.equal(result.ok, false);
    assert.equal(result.statusCode, 503);
  });

  it("retries on thrown network errors", async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 2) {
          throw new Error("fetch failed");
        }
        return { ok: true, statusCode: 200, response: {} };
      },
      fastConfig,
    );

    assert.equal(calls, 2);
    assert.equal(result.ok, true);
  });

  it("does not retry when maxRetries is 0", async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        return { ok: false, statusCode: 500, response: {} };
      },
      { maxRetries: 0, baseDelayMs: 10, maxDelayMs: 50 },
    );

    assert.equal(calls, 1);
    assert.equal(result.ok, false);
  });
});
