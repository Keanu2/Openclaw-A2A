/**
 * `a2a bench` — Benchmark an A2A agent with concurrent requests.
 *
 * Sends N requests at configurable concurrency and measures:
 *   - Latency percentiles (P50 / P90 / P99)
 *   - Throughput (req/s)
 *   - Success / failure rate
 */

import { Command } from "commander";
import chalk from "chalk";
import Table from "cli-table3";
import { randomUUID } from "node:crypto";
import { resolveTarget } from "../lib/peers.js";
import {
  createClient,
  requestOptions,
  retryOnConnectionError,
} from "../lib/client-factory.js";
import { printError, latencyColor } from "../lib/format.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function asciiBar(value: number, max: number, width: number = 30): string {
  const filled = Math.round((value / Math.max(max, 1)) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

// ---------------------------------------------------------------------------
// Benchmark runner
// ---------------------------------------------------------------------------

interface BenchResult {
  index: number;
  latencyMs: number;
  success: boolean;
  state: string;
  error?: string;
}

async function runSingleRequest(
  client: any,
  reqOpts: any,
  message: string,
  index: number,
): Promise<BenchResult> {
  const start = Date.now();
  try {
    const outMsg = {
      kind: "message",
      messageId: randomUUID(),
      role: "user",
      parts: [{ kind: "text", text: message }],
    };

    const result = await client.sendMessage(
      { message: outMsg } as any,
      reqOpts,
    );

    const latencyMs = Date.now() - start;
    const state =
      (result as any)?.status?.state ??
      ((result as any)?.kind === "message" ? "completed" : "unknown");

    return { index, latencyMs, success: true, state };
  } catch (err: unknown) {
    const latencyMs = Date.now() - start;
    return {
      index,
      latencyMs,
      success: false,
      state: "error",
      error: (err as Error).message || String(err),
    };
  }
}

async function runBench(
  client: any,
  reqOpts: any,
  message: string,
  total: number,
  concurrency: number,
): Promise<BenchResult[]> {
  const results: BenchResult[] = [];
  let nextIdx = 0;

  async function worker(): Promise<void> {
    while (nextIdx < total) {
      const idx = nextIdx++;
      results.push(
        await runSingleRequest(client, reqOpts, message, idx),
      );
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, total) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export function register(program: Command): void {
  program
    .command("bench")
    .description(
      "Benchmark an A2A agent with concurrent requests",
    )
    .argument("<target>", "peer alias or URL")
    .option("-n, --requests <n>", "total number of requests", "20")
    .option("-c, --concurrency <n>", "concurrent requests", "5")
    .option("-m, --message <text>", "message to send", "ping")
    .option("--json", "output raw JSON results")
    .action(
      async (
        target: string,
        opts: Record<string, string | boolean>,
      ) => {
        const globalOpts = (program as any)._globalOpts ?? {};
        const jsonMode = Boolean(opts.json || globalOpts.json);
        const total = Math.max(1, Number(opts.requests) || 20);
        const concurrency = Math.max(1, Number(opts.concurrency) || 5);
        const message = (opts.message as string) || "ping";

        try {
          const { url, token } = resolveTarget(target);
          const client = await retryOnConnectionError(() =>
            createClient(url, { token }),
          );
          const reqOpts = requestOptions(token);

          if (!jsonMode) {
            process.stderr.write(
              chalk.dim(
                `Benchmarking ${target} — ${total} requests, ${concurrency} concurrent\n\n`,
              ),
            );
          }

          const startTime = Date.now();
          const results = await runBench(
            client,
            reqOpts,
            message,
            total,
            concurrency,
          );
          const wallTime = Date.now() - startTime;

          // Compute stats
          const successes = results.filter((r) => r.success);
          const failures = results.filter((r) => !r.success);
          const latencies = successes
            .map((r) => r.latencyMs)
            .sort((a, b) => a - b);

          const p50 = percentile(latencies, 50);
          const p90 = percentile(latencies, 90);
          const p99 = percentile(latencies, 99);
          const avg =
            latencies.length > 0
              ? latencies.reduce((a, b) => a + b, 0) / latencies.length
              : 0;
          const min = latencies[0] ?? 0;
          const max = latencies[latencies.length - 1] ?? 0;
          const rps = wallTime > 0 ? (total / wallTime) * 1000 : 0;

          if (jsonMode) {
            console.log(
              JSON.stringify(
                {
                  target,
                  url,
                  total,
                  concurrency,
                  wallTimeMs: wallTime,
                  successes: successes.length,
                  failures: failures.length,
                  rps: +rps.toFixed(2),
                  latency: {
                    min,
                    avg: +avg.toFixed(1),
                    p50,
                    p90,
                    p99,
                    max,
                  },
                  results: results.map((r) => ({
                    index: r.index,
                    latencyMs: r.latencyMs,
                    success: r.success,
                    state: r.state,
                    ...(r.error ? { error: r.error } : {}),
                  })),
                },
                null,
                2,
              ),
            );
            return;
          }

          // --- Pretty output ---
          console.log(chalk.bold("Results\n"));

          // Summary table
          const summary = new Table();
          summary.push(
            { Requests: `${successes.length}/${total} OK` },
            { "Wall time": `${wallTime}ms` },
            { Throughput: `${rps.toFixed(1)} req/s` },
            { Failures: failures.length > 0 ? chalk.red(String(failures.length)) : chalk.green("0") },
          );
          console.log(summary.toString());

          // Latency distribution
          console.log(chalk.bold("\nLatency Distribution\n"));
          const latTable = new Table({
            head: ["Metric", "Value", ""],
            style: { head: ["cyan"] },
          });
          latTable.push(
            ["Min", latencyColor(min), asciiBar(min, max)],
            ["P50", latencyColor(p50), asciiBar(p50, max)],
            ["P90", latencyColor(p90), asciiBar(p90, max)],
            ["P99", latencyColor(p99), asciiBar(p99, max)],
            ["Max", latencyColor(max), asciiBar(max, max)],
            ["Avg", latencyColor(Math.round(avg)), asciiBar(avg, max)],
          );
          console.log(latTable.toString());

          // Error breakdown (only if there are failures)
          if (failures.length > 0) {
            console.log(chalk.bold("\nErrors\n"));
            const errCounts = new Map<string, number>();
            for (const f of failures) {
              const key = f.error ?? "unknown";
              errCounts.set(key, (errCounts.get(key) ?? 0) + 1);
            }
            const errTable = new Table({
              head: ["Error", "Count"],
              style: { head: ["red"] },
            });
            for (const [err, count] of errCounts) {
              errTable.push([err.slice(0, 60), String(count)]);
            }
            console.log(errTable.toString());
          }
        } catch (err) {
          printError(err);
        }
      },
    );
}
