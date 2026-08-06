import chalk from "chalk";
import Table from "cli-table3";

export function statusColor(state: string): string {
  switch (state) {
    case "completed":
      return chalk.green(state);
    case "failed":
      return chalk.red(state);
    case "canceled":
    case "rejected":
      return chalk.red(state);
    case "working":
    case "submitted":
      return chalk.yellow(state);
    case "input-required":
    case "auth-required":
      return chalk.magenta(state);
    default:
      return chalk.gray(state);
  }
}

export function latencyColor(ms: number): string {
  const text = `${ms}ms`;
  if (ms < 100) return chalk.green(text);
  if (ms < 500) return chalk.yellow(text);
  return chalk.red(text);
}

export function onlineStatus(online: boolean): string {
  return online ? chalk.green("online") : chalk.red("offline");
}

export function printAgentCard(card: any): void {
  const table = new Table();
  table.push(
    { Name: card.name ?? "(unnamed)" },
    { Version: card.version ?? "-" },
    { Description: card.description ?? "-" },
    { URL: card.url ?? "-" },
    { Protocol: card.protocolVersion ?? "-" },
  );

  if (card.capabilities) {
    const caps = Object.keys(card.capabilities)
      .filter((k) => card.capabilities[k])
      .join(", ");
    table.push({ Capabilities: caps || "none" });
  }

  if (card.skills?.length) {
    const skills = card.skills
      .map((s: any) => s.name || s.id || "?")
      .join(", ");
    table.push({ Skills: skills });
  }

  console.log(table.toString());
}

export function printTaskStatus(task: any): void {
  const state = task?.status?.state ?? "unknown";
  const text = extractText(task?.status?.message?.parts);
  const ts = task?.status?.timestamp ?? "";

  let line = `[${statusColor(state)}] task=${chalk.dim(task.id)}`;
  if (task.contextId) line += ` context=${chalk.dim(task.contextId)}`;
  if (ts) line += ` ${chalk.dim(`(${ts})`)}`;
  console.log(line);
  if (text) console.log(text);
}

export function extractText(parts: any[] | undefined): string | undefined {
  if (!Array.isArray(parts)) return undefined;
  for (const p of parts) {
    if (p?.kind === "text" && typeof p.text === "string") return p.text;
  }
  return undefined;
}

export function printError(err: unknown): void {
  const msg = (err as any)?.message ?? String(err);
  const code = (err as any)?.cause?.code ?? (err as any)?.code ?? "";

  if (code === "ECONNREFUSED" || msg.includes("ECONNREFUSED")) {
    console.error(chalk.red("Connection refused") + " — peer is not reachable.");
    console.error(chalk.dim("  Check if the peer is running and the URL is correct."));
    return;
  }
  if (code === "ETIMEDOUT" || msg.includes("ETIMEDOUT")) {
    console.error(chalk.red("Connection timed out") + " — peer is not responding.");
    return;
  }
  if (code === "ENOTFOUND" || msg.includes("ENOTFOUND")) {
    console.error(chalk.red("DNS lookup failed") + " — hostname not found.");
    return;
  }
  if (msg.includes("401") || msg.includes("Unauthorized")) {
    console.error(chalk.red("Auth failed (401)") + " — token is invalid or expired.");
    return;
  }

  console.error(chalk.red("Error:"), msg);
}

export function jsonOrPretty(data: unknown, jsonMode: boolean): void {
  if (jsonMode) {
    console.log(JSON.stringify(data, null, 2));
  }
}
