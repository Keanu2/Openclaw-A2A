import { Command } from "commander";
import chalk from "chalk";
import { resolveTarget } from "../lib/peers.js";
import {
  createClient,
  requestOptions,
} from "../lib/client-factory.js";
import {
  printTaskStatus,
  extractText,
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
    .command("status")
    .description("Query the status of an A2A task by its task ID")
    .argument("<target>", "peer alias or URL")
    .argument("<task-id>", "task ID to query")
    .option("--wait", "poll until terminal state")
    .option("--timeout <ms>", "max wait time in ms", "600000")
    .option("--poll <ms>", "poll interval in ms", "2000")
    .option("--json", "output raw JSON")
    .action(
      async (
        target: string,
        taskId: string,
        opts: Record<string, string | boolean>,
      ) => {
        const globalOpts = (program as any)._globalOpts ?? {};
        const jsonMode = Boolean(opts.json || globalOpts.json);
        const wait = Boolean(opts.wait);
        const timeoutMs = Number(opts.timeout) || 600_000;
        const pollMs = Number(opts.poll) || 2_000;

        try {
          const { url, token } = resolveTarget(target);
          const client = await createClient(url, { token });
          const reqOpts = requestOptions(token);

          // Single query mode
          if (!wait) {
            const task = await client.getTask(
              { id: taskId, historyLength: 20 } as any,
              reqOpts,
            );

            if (jsonMode) {
              jsonOrPretty(task, true);
            } else {
              printTaskStatus(task);
              const text = extractText((task as any)?.status?.message?.parts);
              if (text) console.log(text);
            }
            return;
          }

          // Polling mode
          const startedAt = Date.now();
          let lastState = "";

          while (true) {
            const task = await client.getTask(
              { id: taskId, historyLength: 20 } as any,
              reqOpts,
            );
            const state = (task as any)?.status?.state;

            // Print state transitions
            if (state !== lastState) {
              if (jsonMode) {
                console.log(
                  JSON.stringify({
                    state,
                    timestamp: (task as any)?.status?.timestamp,
                  }),
                );
              } else {
                printTaskStatus(task);
                const text = extractText((task as any)?.status?.message?.parts);
                if (text) console.log(text);
              }
              lastState = state;
            }

            if (state && TERMINAL_STATES.has(state)) return;

            if (state && BLOCKED_STATES.has(state)) {
              console.error(
                `\nTask is blocked (${chalk.magenta(state)}). It needs external action to proceed.`,
              );
              process.exit(2);
            }

            if (Date.now() - startedAt > timeoutMs) {
              console.error(
                `\nTimeout: task ${taskId} still in "${state}" state after ${(timeoutMs / 1000).toFixed(0)}s`,
              );
              console.error(
                `Tip: re-run with a longer --timeout, or query again later without --wait`,
              );
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
