import { Command } from "commander";
import chalk from "chalk";
import { resolveTarget } from "../lib/peers.js";
import { printAgentCard, printError, jsonOrPretty } from "../lib/format.js";

export function register(program: Command): void {
  program
    .command("card")
    .description("Fetch and display an agent's Agent Card")
    .argument("<target>", "peer alias or URL")
    .option("--timeout <ms>", "request timeout in ms", "5000")
    .option("--json", "output raw JSON")
    .action(async (target: string, opts: Record<string, string | boolean>) => {
      const globalOpts = (program as any)._globalOpts ?? {};
      const jsonMode = Boolean(opts.json || globalOpts.json);
      const timeoutMs = Number(opts.timeout) || 5000;

      try {
        const { url, token } = resolveTarget(target);
        const cardUrl = url.replace(/\/+$/, "") + "/.well-known/agent-card.json";
        const headers: Record<string, string> = {};
        if (token) headers.authorization = `Bearer ${token}`;

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        try {
          const res = await fetch(cardUrl, {
            headers,
            signal: controller.signal,
          });

          if (!res.ok) {
            console.error(
              chalk.red(`HTTP ${res.status}`) +
                ` fetching agent card from ${chalk.dim(cardUrl)}`,
            );
            return;
          }

          const card = await res.json();

          if (jsonMode) {
            jsonOrPretty(card, true);
            return;
          }

          printAgentCard(card);
        } finally {
          clearTimeout(timer);
        }
      } catch (err) {
        printError(err);
      }
    });
}
