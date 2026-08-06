/**
 * `a2a discover` — Scan the local network for A2A agents via mDNS (DNS-SD).
 *
 * Sends a PTR query for `_a2a._tcp.local` and collects SRV + TXT responses
 * within a configurable timeout window. Results are displayed as a table or
 * emitted as JSON.
 */

import { Command } from "commander";
import chalk from "chalk";
import Table from "cli-table3";
// @ts-expect-error — multicast-dns has no bundled type declarations
import mdns from "multicast-dns";
import { printError, latencyColor } from "../lib/format.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DiscoveredAgent {
  name: string;
  host: string;
  port: number;
  protocol: string;
  path: string;
  url: string;
}

// ---------------------------------------------------------------------------
// mDNS scanner
// ---------------------------------------------------------------------------

const SERVICE_TYPE = "_a2a._tcp.local";

function parseTxtData(data: Buffer[] | Buffer | string): Map<string, string> {
  const result = new Map<string, string>();
  const chunks = Array.isArray(data) ? data : [data];
  for (const chunk of chunks) {
    const str = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
    const eqIdx = str.indexOf("=");
    if (eqIdx > 0) {
      result.set(
        str.slice(0, eqIdx).trim().toLowerCase(),
        str.slice(eqIdx + 1).trim(),
      );
    }
  }
  return result;
}

async function scanMdns(timeoutMs: number): Promise<DiscoveredAgent[]> {
  const browser = mdns();
  const agents = new Map<string, DiscoveredAgent>();

  // Track SRV and TXT records keyed by instance name
  const srvMap = new Map<string, { host: string; port: number }>();
  const txtMap = new Map<string, Map<string, string>>();

  return new Promise<DiscoveredAgent[]>((resolve) => {
    const timer = setTimeout(() => {
      browser.destroy();
      resolve([...agents.values()]);
    }, timeoutMs);

    browser.on("response", (response: any) => {
      const allRecords = [
        ...(response.answers ?? []),
        ...(response.additionals ?? []),
      ];

      for (const record of allRecords) {
        const rname: string = record.name ?? "";

        if (record.type === "SRV") {
          srvMap.set(rname, {
            host: record.data?.target ?? "",
            port: record.data?.port ?? 0,
          });
        }

        if (record.type === "TXT" && record.data) {
          txtMap.set(rname, parseTxtData(record.data));
        }
      }

      // Merge SRV + TXT into discovered agents
      for (const [instanceName, srv] of srvMap) {
        if (agents.has(instanceName)) continue;
        if (!srv.host || !srv.port) continue;

        const txt = txtMap.get(instanceName) ?? new Map<string, string>();
        const protocol = txt.get("protocol") ?? "jsonrpc";
        const path = txt.get("path") ?? "/.well-known/agent-card.json";
        const name = txt.get("name") ?? instanceName.split(".")[0] ?? "unknown";

        agents.set(instanceName, {
          name,
          host: srv.host,
          port: srv.port,
          protocol,
          path,
          url: `http://${srv.host}:${srv.port}`,
        });
      }
    });

    // Send PTR query
    browser.query({
      questions: [{ name: SERVICE_TYPE, type: "PTR" }],
    });
  });
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export function register(program: Command): void {
  program
    .command("discover")
    .description("Scan the local network for A2A agents via mDNS (DNS-SD)")
    .option("--timeout <ms>", "scan duration in ms", "3000")
    .option("--json", "output raw JSON")
    .action(async (opts: Record<string, string | boolean>) => {
      const globalOpts = (program as any)._globalOpts ?? {};
      const jsonMode = Boolean(opts.json || globalOpts.json);
      const timeoutMs = Number(opts.timeout) || 3000;

      try {
        process.stderr.write(
          chalk.dim(`Scanning for A2A agents (${timeoutMs}ms)...\n`),
        );

        const agents = await scanMdns(timeoutMs);

        if (agents.length === 0) {
          console.log(chalk.yellow("No A2A agents found on the local network."));
          console.log(
            chalk.dim(
              "  Tip: ensure agents advertise via mDNS (_a2a._tcp.local)",
            ),
          );
          return;
        }

        if (jsonMode) {
          console.log(JSON.stringify(agents, null, 2));
          return;
        }

        const table = new Table({
          head: ["Name", "Host", "Port", "Protocol", "URL"],
          style: { head: ["cyan"] },
        });

        for (const agent of agents) {
          table.push([
            chalk.green(agent.name),
            agent.host,
            String(agent.port),
            agent.protocol,
            chalk.dim(agent.url),
          ]);
        }

        console.log(table.toString());
        console.log(`\n${chalk.green(String(agents.length))} agent(s) discovered`);
      } catch (err) {
        printError(err);
      }
    });
}
