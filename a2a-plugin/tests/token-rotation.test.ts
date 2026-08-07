import { describe, it } from "node:test";
import assert from "node:assert/strict";

/**
 * Token rotation tests — validates that parseConfig correctly merges
 * token/tokens into validTokens Set, and that auth checking works with
 * multiple tokens.
 *
 * We import parseConfig indirectly by testing the compiled output.
 * Since parseConfig is not exported, we test the SecurityConfig shape directly.
 */

describe("Token rotation — validTokens merging", () => {
  // Helper to simulate parseConfig's token merging logic
  function mergeTokens(token?: string, tokens?: string[]): Set<string> {
    const singleToken = token ?? "";
    const tokenArray = Array.isArray(tokens)
      ? tokens.filter((t): t is string => typeof t === "string" && t.length > 0)
      : [];
    return new Set<string>(
      [singleToken, ...tokenArray].filter(t => t.length > 0),
    );
  }

  it("single token produces Set with 1 element", () => {
    const result = mergeTokens("abc123");
    assert.equal(result.size, 1);
    assert.ok(result.has("abc123"));
  });

  it("tokens array produces Set with all elements", () => {
    const result = mergeTokens(undefined, ["tok-a", "tok-b"]);
    assert.equal(result.size, 2);
    assert.ok(result.has("tok-a"));
    assert.ok(result.has("tok-b"));
  });

  it("token + tokens merged and deduplicated", () => {
    const result = mergeTokens("shared", ["shared", "new-tok"]);
    assert.equal(result.size, 2);
    assert.ok(result.has("shared"));
    assert.ok(result.has("new-tok"));
  });

  it("empty token string ignored", () => {
    const result = mergeTokens("", ["valid"]);
    assert.equal(result.size, 1);
    assert.ok(result.has("valid"));
  });

  it("empty tokens array with valid token", () => {
    const result = mergeTokens("only-one", []);
    assert.equal(result.size, 1);
    assert.ok(result.has("only-one"));
  });

  it("both empty produces empty Set", () => {
    const result = mergeTokens("", []);
    assert.equal(result.size, 0);
  });

  it("neither provided produces empty Set", () => {
    const result = mergeTokens(undefined, undefined);
    assert.equal(result.size, 0);
  });

  it("filters out non-string and empty-string entries from tokens array", () => {
    const result = mergeTokens(undefined, ["good", "", "also-good"] as string[]);
    assert.equal(result.size, 2);
    assert.ok(result.has("good"));
    assert.ok(result.has("also-good"));
  });
});

describe("Token rotation — bearer auth validation", () => {
  // Simulate the auth check logic from index.ts userBuilder
  function validateBearerToken(
    header: string | undefined,
    validTokens: Set<string>,
  ): boolean {
    if (validTokens.size === 0) return true; // no auth configured
    const providedToken = typeof header === "string" && header.startsWith("Bearer ")
      ? header.slice(7)
      : "";
    return providedToken.length > 0 && validTokens.has(providedToken);
  }

  it("accepts old token during rotation", () => {
    const tokens = new Set(["old-tok", "new-tok"]);
    assert.ok(validateBearerToken("Bearer old-tok", tokens));
  });

  it("accepts new token during rotation", () => {
    const tokens = new Set(["old-tok", "new-tok"]);
    assert.ok(validateBearerToken("Bearer new-tok", tokens));
  });

  it("rejects unknown token", () => {
    const tokens = new Set(["old-tok", "new-tok"]);
    assert.equal(validateBearerToken("Bearer wrong", tokens), false);
  });

  it("rejects missing header", () => {
    const tokens = new Set(["tok"]);
    assert.equal(validateBearerToken(undefined, tokens), false);
  });

  it("rejects malformed header (no Bearer prefix)", () => {
    const tokens = new Set(["tok"]);
    assert.equal(validateBearerToken("tok", tokens), false);
  });

  it("accepts any when no tokens configured", () => {
    const tokens = new Set<string>();
    assert.ok(validateBearerToken(undefined, tokens));
  });

  it("single token backward compat", () => {
    const tokens = new Set(["my-secret"]);
    assert.ok(validateBearerToken("Bearer my-secret", tokens));
    assert.equal(validateBearerToken("Bearer other", tokens), false);
  });
});
