import type { RetryConfig, OutboundSendResult } from "./types.js";

type LogFn = (level: "info" | "warn", msg: string, details?: Record<string, unknown>) => void;

/**
 * Determine whether an error or failed result is retryable.
 *
 * Retryable: network errors, 5xx, 429 (rate-limited).
 * Not retryable: 4xx (client errors except 429).
 */
export function isRetryable(errorOrResult: unknown): boolean {
  // OutboundSendResult-shaped objects
  if (
    errorOrResult &&
    typeof errorOrResult === "object" &&
    "ok" in errorOrResult &&
    "statusCode" in errorOrResult
  ) {
    const result = errorOrResult as OutboundSendResult;
    if (result.ok) return false;
    const code = result.statusCode;
    // 429 = rate limited → retry; 5xx = server error → retry
    return code === 429 || code >= 500;
  }

  // Network-level errors are always retryable
  if (errorOrResult instanceof Error) {
    const msg = errorOrResult.message.toLowerCase();
    return (
      msg.includes("econnrefused") ||
      msg.includes("econnreset") ||
      msg.includes("etimedout") ||
      msg.includes("fetch failed") ||
      msg.includes("network") ||
      msg.includes("socket") ||
      msg.includes("abort")
    );
  }

  // Unknown errors → retry as a safe default
  return true;
}

/**
 * Calculate delay with exponential backoff + jitter.
 */
function calcDelay(attempt: number, config: RetryConfig): number {
  const exponential = Math.min(
    config.baseDelayMs * Math.pow(2, attempt),
    config.maxDelayMs,
  );
  // Add 0–10% jitter to prevent thundering herd
  const jitter = Math.random() * exponential * 0.1;
  return exponential + jitter;
}

/**
 * Wrap an async operation with configurable retry + exponential backoff.
 *
 * The function `fn` should throw on network errors or return an
 * OutboundSendResult. Non-retryable failures are returned immediately.
 */
export async function withRetry(
  fn: () => Promise<OutboundSendResult>,
  config: RetryConfig,
  log?: LogFn,
  peerName?: string,
): Promise<OutboundSendResult> {
  let lastResult: OutboundSendResult | undefined;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      const result = await fn();

      // Success → return immediately
      if (result.ok) return result;

      // Non-retryable failure → return immediately
      if (!isRetryable(result)) return result;

      lastResult = result;
    } catch (error: unknown) {
      if (!isRetryable(error)) {
        return {
          ok: false,
          statusCode: 500,
          response: { error: error instanceof Error ? error.message : String(error) },
        };
      }

      lastResult = {
        ok: false,
        statusCode: 500,
        response: { error: error instanceof Error ? error.message : String(error) },
      };
    }

    // If we have retries left, wait before the next attempt
    if (attempt < config.maxRetries) {
      const delay = calcDelay(attempt, config);
      log?.("warn", "peer.retry", {
        peer: peerName,
        attempt: attempt + 1,
        max_retries: config.maxRetries,
        delay_ms: Math.round(delay),
      });
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  // All retries exhausted
  return lastResult!;
}
