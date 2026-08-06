import { Command } from "commander";
import chalk from "chalk";
import Table from "cli-table3";
import {
  resolveTarget,
  loadPeers,
  PEERS_FILE,
} from "../lib/peers.js";
import {
  onlineStatus,
  latencyColor,
  printError,
  jsonOrPretty,
} from "../lib/format.js";

interface PingResult {
  online: boolean;
  latency: number;
  name?: string;
  description?: string;
  version?: string;
  error?: string;
}

async function pingPeer(
  url: string,
  token: string,
  timeoutMs: number,
): Promise<PingResult> {
  const cardUrl = url.replace(/\/+$/, "") + "/.well-known/agent-card.json";
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;

  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(cardUrl, { headers, signal: controller.signal });
    const latency = Date.now() - start;

    if (!res.ok) {
      return { online: false, latency, error: `HTTP ${res.status}` };
    }

    const card = await res.json() as Record<string, unknown>;
    return {
      online: true,
      latency,
      name: (card.name || card.agentName || "(unnamed)") as string,
      description: (card.description || "") as string,
      version: (card.version || "") as string,
    };
  } catch (err: unknown) {
    const latency = Date.now() - start;
    if ((err as Error).name === "AbortError") {
      return { online: false, latency, error: `timeout (${timeoutMs}ms)` };
    }
    const code = (err as any)?.cause?.code || "";
    if (code === "ECONNREFUSED") {
      return { online: false, latency, error: "connection refused" };
    }
    return { online: false, latency, error: (err as Error).message || String(err) };
  } finally {
    clearTimeout(timer);
  }
}

export function register(program: Command): void {
  program
    .command("health")
    .description("Check if an A2A peer is online by fetching its Agent Card")
    .argument("[target]", "peer alias or URL")
    .option("--all", "ping all configured peers")
    .option("--timeout <ms>", "request timeout in ms", "5000")
    .option("--json", "output raw JSON")
    .action(async (target: string | undefined, opts: Record<string, string | boolean>) => {
      const globalOpts = (program as any)._globalOpts ?? {};
      const jsonMode = Boolean(opts.json || globalOpts.json);
      const timeoutMs = Number(opts.timeout) || 5000;

      try {
        if (opts.all) {
          await runAll(timeoutMs, jsonMode);
          return;
        }

        if (!target) {
          console.error(chalk.red("Error:") + " <target> argument or --all is required");
          console.error("  Usage: a2a health <target>  or  a2a health --all");
          return;
        }

        await runSingle(target, timeoutMs, jsonMode);
      } catch (err) {
        printError(err);
      }
    });
}

async function runAll(timeoutMs: number, jsonMode: boolean): Promise<void> {
  const peers = loadPeers();
  const names = Object.keys(peers);

  if (names.length === 0) {
    console.error(`No peers configured. Create ${PEERS_FILE} with:`);
    console.error(`  { "AntiBot": { "url": "http://...", "token": "..." } }`);
    return;
  }

  const results = await Promise.all(
    names.map(async (name) => {
      const entry = peers[name];
      const url = typeof entry === "string" ? entry : (entry as any).url;
      const token = typeof entry === "object" ? (entry as any).token ?? "" : "";
      const result = await pingPeer(url, token, timeoutMs);
      return { name, url, result };
    }),
  );

  if (jsonMode) {
    console.log(JSON.stringify(results.map((r) => ({
      name: r.name,
      url: r.url,
      ...r.result,
    })), null, 2));
    return;
  }

  const table = new Table({
    head: ["Peer", "Status", "Latency", "Name", "Version"],
    style: { head: ["cyan"] },
  });

  for (const { name, result } of results) {
    table.push([
      name,
      onlineStatus(result.online),
      result.online ? latencyColor(result.latency) : chalk.dim("-"),
      result.name ?? (result.error ?? "-"),
      result.version ?? "-",
    ]);
  }

  console.log(table.toString());

  const onlineCount = results.filter((r) => r.result.online).length;
  console.log(`\n${onlineCount}/${results.length} peers online`);
}

async function runSingle(
  target: string,
  timeoutMs: number,
  jsonMode: boolean,
): Promise<void> {
  const { url, token } = resolveTarget(target);
  const result = await pingPeer(url, token, timeoutMs);

  if (jsonMode) {
    console.log(JSON.stringify({ target, url, ...result }, null, 2));
    return;
  }

  if (result.online) {
    const parts = [
      `${chalk.green("online")} ${chalk.dim(target)} (${latencyColor(result.latency)})`,
    ];
    if (result.name) parts[0] += ` — ${result.name}`;
    if (result.version) parts.push(`  version: ${result.version}`);
    if (result.description) parts.push(`  ${chalk.dim(result.description)}`);
    console.log(parts.join("\n"));
  } else {
    console.log(`${chalk.red("offline")} ${chalk.dim(target)} — ${result.error}`);
  }
}
