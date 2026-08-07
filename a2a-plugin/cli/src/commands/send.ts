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
  printTaskStatus,
  printError,
  jsonOrPretty,
} from "../lib/format.js";

const TERMINAL_STATES = new Set(["completed", "failed", "canceled", "rejected"]);
const BLOCKED_STATES = new Set(["input-required", "auth-required"]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function register(program: Command): void {
  program
    .command("send")
    .description("Send a message to an A2A agent and display the response")
    .argument("<target>", "peer alias or URL")
    .argument("<message>", "text message to send")
    .option("--non-blocking", "send with configuration.blocking=false")
    .option("--wait", "when non-blocking, poll until terminal state")
    .option("--timeout <ms>", "max wait time in ms", "120000")
    .option("--poll <ms>", "poll interval in ms", "2000")
    .option("--agent-id <id>", "route to a specific OpenClaw agentId")
    .option("--task-id <id>", "continue an existing task (follow-up turn)")
    .option("--context-id <id>", "reuse an existing context for multi-round routing")
    .option("--json", "output raw JSON")
    .action(
      async (
        target: string,
        message: string,
        opts: Record<string, string | boolean>,
      ) => {
        const globalOpts = (program as any)._globalOpts ?? {};
        const jsonMode = Boolean(opts.json || globalOpts.json);
        const nonBlocking = Boolean(opts["non-blocking"] || opts.nonBlocking);
        const wait = Boolean(opts.wait);
        const timeoutMs = Number(opts.timeout) || 120_000;
        const pollMs = Number(opts.poll) || 2_000;
        const agentId = (opts["agent-id"] as string) ?? (opts.agentId as string) ?? "";
        const taskId = (opts["task-id"] as string) ?? (opts.taskId as string) ?? "";
        const contextId = (opts["context-id"] as string) ?? (opts.contextId as string) ?? "";

        try {
          const { url, token } = resolveTarget(target);
          const client = await createClient(url, { token });
          const reqOpts = requestOptions(token);

          // Build outbound message
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
          if (nonBlocking) {
            sendParams.configuration = { blocking: false };
          }

          // Send
          const result = await retryOnConnectionError(() =>
            client.sendMessage(sendParams as any, reqOpts),
          );

          // Immediate response (no wait)
          if (!nonBlocking || !wait) {
            if (jsonMode) {
              jsonOrPretty(result, true);
              return;
            }

            if ((result as any)?.kind === "message") {
              const text = extractText((result as any).parts);
              console.log(text ?? JSON.stringify(result, null, 2));
              return;
            }

            if ((result as any)?.kind === "task") {
              printTaskStatus(result);
              const text = extractText((result as any).status?.message?.parts);
              if (text) console.log(text);
              return;
            }

            console.log(JSON.stringify(result, null, 2));
            return;
          }

          // Async task mode: poll until terminal state
          const responseTaskId =
            (result as any)?.kind === "task"
              ? (result as any).id
              : (result as any)?.taskId;

          if (!responseTaskId || typeof responseTaskId !== "string") {
            // Can't wait without a task id — print immediate result
            if (jsonMode) {
              jsonOrPretty(result, true);
            } else {
              console.log(JSON.stringify(result, null, 2));
            }
            return;
          }

          if (!jsonMode && (result as any)?.kind === "task") {
            printTaskStatus(result);
          }

          const startedAt = Date.now();

          while (true) {
            const task = await client.getTask(
              { id: responseTaskId, historyLength: 20 } as any,
              reqOpts,
            );
            const state = (task as any)?.status?.state;

            if (state && TERMINAL_STATES.has(state)) {
              if (jsonMode) {
                jsonOrPretty(task, true);
              } else {
                const text = extractText((task as any).status?.message?.parts);
                console.log(text ?? JSON.stringify(task, null, 2));
              }
              return;
            }

            if (state && BLOCKED_STATES.has(state)) {
              console.error(
                `\nTask is blocked (${chalk.magenta(state)}). It needs external action to proceed.`,
              );
              console.error(
                `Check status later: ${chalk.dim(`a2a status ${target} ${responseTaskId}`)}`,
              );
              if (jsonMode) jsonOrPretty(task, true);
              process.exit(2);
            }

            if (Date.now() - startedAt > timeoutMs) {
              const elapsed = (timeoutMs / 1000).toFixed(0);
              const lastState = (task as any)?.status?.state ?? "unknown";
              console.error(
                `\nTimeout: task ${responseTaskId} still "${lastState}" after ${elapsed}s`,
              );
              console.error(
                `Tip: increase --timeout or check status later with:`,
              );
              console.error(
                `  ${chalk.dim(`a2a status ${target} ${responseTaskId} --wait`)}`,
              );
              if (jsonMode) jsonOrPretty(task, true);
              process.exit(3);
            }

            await sleep(pollMs);
          }
        } catch (err) {
          printError(err);
        }
      },
    );
}
