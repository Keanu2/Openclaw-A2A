/**
 * `a2a stream` — Send a message and display the SSE stream in real-time.
 *
 * Uses the SDK's `sendMessageStream()` which returns an AsyncGenerator of
 * A2A stream events: status updates, artifact chunks, and final messages.
 */

import { Command } from "commander";
import chalk from "chalk";
import { randomUUID } from "node:crypto";
import { resolveTarget } from "../lib/peers.js";
import {
  createClient,
  requestOptions,
  retryOnConnectionError,
} from "../lib/client-factory.js";
import {
  statusColor,
  extractText,
  printError,
  jsonOrPretty,
} from "../lib/format.js";

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export function register(program: Command): void {
  program
    .command("stream")
    .description("Send a message and stream the response via SSE in real-time")
    .argument("<target>", "peer alias or URL")
    .argument("<message>", "text message to send")
    .option("--timeout <ms>", "max stream duration in ms", "120000")
    .option("--agent-id <id>", "route to a specific OpenClaw agentId")
    .option("--task-id <id>", "continue an existing task")
    .option("--context-id <id>", "reuse an existing context")
    .option("--json", "output raw JSON events (one per line)")
    .action(
      async (
        target: string,
        message: string,
        opts: Record<string, string | boolean>,
      ) => {
        const globalOpts = (program as any)._globalOpts ?? {};
        const jsonMode = Boolean(opts.json || globalOpts.json);
        const timeoutMs = Number(opts.timeout) || 120_000;
        const agentId =
          (opts["agent-id"] as string) ?? (opts.agentId as string) ?? "";
        const taskId =
          (opts["task-id"] as string) ?? (opts.taskId as string) ?? "";
        const contextId =
          (opts["context-id"] as string) ?? (opts.contextId as string) ?? "";

        try {
          const { url, token } = resolveTarget(target);
          const client = await createClient(url, { token });
          const reqOpts = requestOptions(token);

          const outboundMessage: Record<string, unknown> = {
            kind: "message",
            messageId: randomUUID(),
            role: "user",
            parts: [{ kind: "text", text: message }],
          };
          if (taskId) outboundMessage.taskId = taskId.slice(0, 256);
          if (contextId) outboundMessage.contextId = contextId.slice(0, 256);
          if (agentId) outboundMessage.agentId = agentId;

          const sendParams: Record<string, unknown> = {
            message: outboundMessage,
          };

          const startTime = Date.now();
          let eventCount = 0;
          let lastState = "";

          if (!jsonMode) {
            process.stderr.write(
              chalk.dim(`Streaming from ${target}...\n\n`),
            );
          }

          const stream = (await retryOnConnectionError(() =>
            (client as any).sendMessageStream(sendParams, reqOpts),
          )) as AsyncIterable<Record<string, unknown>>;

          const timer = setTimeout(() => {
            console.error(
              chalk.red(`\nStream timeout after ${timeoutMs / 1000}s`),
            );
            process.exit(3);
          }, timeoutMs);

          try {
            for await (const event of stream) {
              eventCount++;

              if (jsonMode) {
                console.log(JSON.stringify(event));
                continue;
              }

              // Handle different event types
              const kind = (event as any)?.kind;

              if (kind === "status-update") {
                const state = (event as any)?.status?.state ?? "";
                if (state !== lastState) {
                  process.stderr.write(
                    `${chalk.dim("[")}${statusColor(state)}${chalk.dim("]")} `,
                  );
                  lastState = state;
                }
                const text = extractText(
                  (event as any)?.status?.message?.parts,
                );
                if (text) process.stdout.write(text);
              } else if (kind === "artifact-update") {
                const parts = (event as any)?.artifact?.parts;
                const text = extractText(parts);
                if (text) process.stdout.write(text);
              } else if (kind === "message") {
                const text = extractText((event as any)?.parts);
                if (text) process.stdout.write(text);
              } else if (kind === "task") {
                const state = (event as any)?.status?.state ?? "";
                if (state !== lastState) {
                  process.stderr.write(
                    `${chalk.dim("[")}${statusColor(state)}${chalk.dim("]")} `,
                  );
                  lastState = state;
                }
                const text = extractText(
                  (event as any)?.status?.message?.parts,
                );
                if (text) process.stdout.write(text);
              }
            }
          } finally {
            clearTimeout(timer);
          }

          const elapsed = Date.now() - startTime;

          if (!jsonMode) {
            process.stdout.write("\n");
            process.stderr.write(
              chalk.dim(
                `\n--- ${eventCount} events, ${elapsed}ms ---\n`,
              ),
            );
          }
        } catch (err) {
          printError(err);
        }
      },
    );
}
