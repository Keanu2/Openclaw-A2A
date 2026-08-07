/**
 * `a2a trace` — Send a message with full request lifecycle tracing.
 *
 * Breaks the request into observable steps:
 *   1. Peer resolution (alias → URL)
 *   2. Agent Card fetch
 *   3. Client creation (transport negotiation)
 *   4. Message send
 *   5. Response received
 *
 * Each step is timed individually. The waterfall view shows where time is spent.
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
import {
  extractText,
  statusColor,
  latencyColor,
  printError,
} from "../lib/format.js";

// ---------------------------------------------------------------------------
// Trace step
// ---------------------------------------------------------------------------

interface TraceStep {
  name: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  detail?: string;
  error?: string;
}

function step(
  name: string,
  origin: number,
  start: number,
  end: number,
  detail?: string,
): TraceStep {
  return {
    name,
    startMs: start - origin,
    endMs: end - origin,
    durationMs: end - start,
    detail,
  };
}

// ---------------------------------------------------------------------------
// Waterfall renderer
// ---------------------------------------------------------------------------

function renderWaterfall(steps: TraceStep[], totalMs: number): void {
  const maxWidth = 40;

  console.log(chalk.bold("\nRequest Waterfall\n"));

  const table = new Table({
    head: ["Step", "Duration", "Timeline", "Detail"],
    style: { head: ["cyan"] },
    colWidths: [22, 12, maxWidth + 4, 40],
  });

  for (const s of steps) {
    const offsetRatio = totalMs > 0 ? s.startMs / totalMs : 0;
    const widthRatio = totalMs > 0 ? s.durationMs / totalMs : 0;
    const offset = Math.round(offsetRatio * maxWidth);
    const width = Math.max(1, Math.round(widthRatio * maxWidth));

    const bar =
      " ".repeat(offset) +
      (s.error ? chalk.red("█".repeat(width)) : chalk.green("█".repeat(width)));

    table.push([
      s.error ? chalk.red(s.name) : s.name,
      s.error ? chalk.red(`${s.durationMs}ms`) : latencyColor(s.durationMs),
      bar,
      chalk.dim((s.detail ?? s.error ?? "").slice(0, 36)),
    ]);
  }

  console.log(table.toString());
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export function register(program: Command): void {
  program
    .command("trace")
    .description(
      "Send a message with full lifecycle tracing (resolve → card → send → response)",
    )
    .argument("<target>", "peer alias or URL")
    .argument("<message>", "text message to send")
    .option("--agent-id <id>", "route to a specific OpenClaw agentId")
    .option("--task-id <id>", "continue an existing task")
    .option("--context-id <id>", "reuse an existing context")
    .option("--json", "output raw JSON trace")
    .action(
      async (
        target: string,
        message: string,
        opts: Record<string, string | boolean>,
      ) => {
        const globalOpts = (program as any)._globalOpts ?? {};
        const jsonMode = Boolean(opts.json || globalOpts.json);
        const agentId =
          (opts["agent-id"] as string) ?? (opts.agentId as string) ?? "";
        const taskId =
          (opts["task-id"] as string) ?? (opts.taskId as string) ?? "";
        const contextId =
          (opts["context-id"] as string) ?? (opts.contextId as string) ?? "";

        const origin = Date.now();
        const steps: TraceStep[] = [];

        try {
          // Step 1: Peer resolution
          let t0 = Date.now();
          const { url, token } = resolveTarget(target);
          let t1 = Date.now();
          steps.push(step("Peer resolve", origin, t0, t1, `→ ${url}`));

          // Step 2: Agent Card fetch
          t0 = Date.now();
          let cardName = "";
          let cardVersion = "";
          try {
            const cardUrl =
              url.replace(/\/+$/, "") + "/.well-known/agent-card.json";
            const headers: Record<string, string> = {};
            if (token) headers.authorization = `Bearer ${token}`;
            const res = await fetch(cardUrl, { headers });
            if (res.ok) {
              const card = (await res.json()) as Record<string, unknown>;
              cardName = (card.name ?? card.agentName ?? "") as string;
              cardVersion = (card.version ?? "") as string;
            }
            t1 = Date.now();
            steps.push(
              step(
                "Agent Card",
                origin,
                t0,
                t1,
                cardName ? `${cardName} v${cardVersion}` : "fetched",
              ),
            );
          } catch (cardErr) {
            t1 = Date.now();
            steps.push({
              name: "Agent Card",
              startMs: t0 - origin,
              endMs: t1 - origin,
              durationMs: t1 - t0,
              error: (cardErr as Error).message,
            });
          }

          // Step 3: Client creation (transport negotiation)
          t0 = Date.now();
          const client = await retryOnConnectionError(() =>
            createClient(url, { token }),
          );
          t1 = Date.now();
          steps.push(step("Client init", origin, t0, t1, "transport negotiated"));

          // Step 4: Message send
          const outMsg: Record<string, unknown> = {
            kind: "message",
            messageId: randomUUID(),
            role: "user",
            parts: [{ kind: "text", text: message }],
          };
          if (taskId) outMsg.taskId = taskId.slice(0, 256);
          if (contextId) outMsg.contextId = contextId.slice(0, 256);
          if (agentId) outMsg.agentId = agentId;

          const reqOpts = requestOptions(token);
          t0 = Date.now();
          const result = await retryOnConnectionError(() =>
            client.sendMessage({ message: outMsg } as any, reqOpts),
          );
          t1 = Date.now();

          const resultKind = (result as any)?.kind ?? "unknown";
          const resultState =
            (result as any)?.status?.state ?? resultKind;
          steps.push(
            step("Send + Response", origin, t0, t1, `kind=${resultKind} state=${resultState}`),
          );

          const totalMs = t1 - origin;

          // Extract response text
          const responseText =
            extractText((result as any)?.parts) ??
            extractText((result as any)?.status?.message?.parts) ??
            "";

          if (jsonMode) {
            console.log(
              JSON.stringify(
                {
                  target,
                  url,
                  totalMs,
                  steps: steps.map((s) => ({
                    name: s.name,
                    startMs: s.startMs,
                    endMs: s.endMs,
                    durationMs: s.durationMs,
                    ...(s.detail ? { detail: s.detail } : {}),
                    ...(s.error ? { error: s.error } : {}),
                  })),
                  response: {
                    kind: resultKind,
                    state: resultState,
                    text: responseText || undefined,
                  },
                },
                null,
                2,
              ),
            );
            return;
          }

          // Pretty output
          console.log(
            chalk.bold(`Trace: ${target}`) +
              chalk.dim(` (${url})`),
          );

          renderWaterfall(steps, totalMs);

          console.log(
            `\nTotal: ${chalk.bold(latencyColor(totalMs))}` +
              (cardName
                ? ` → ${chalk.green(cardName)}`
                : ""),
          );

          if (responseText) {
            console.log(chalk.dim("\nResponse:"));
            console.log(responseText);
          }
        } catch (err) {
          // Still show partial trace if we got some steps
          if (steps.length > 0 && !jsonMode) {
            const lastEnd = steps[steps.length - 1].endMs;
            renderWaterfall(steps, lastEnd);
          }
          printError(err);
        }
      },
    );
}
