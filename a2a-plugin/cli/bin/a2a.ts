#!/usr/bin/env node
import { Command } from "commander";
import chalk from "chalk";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

const program = new Command()
  .name("a2a")
  .description("DevTools CLI for A2A protocol — httpie for agent-to-agent communication")
  .version(pkg.version)
  .option("--no-color", "disable colored output")
  .option("--json", "output raw JSON instead of formatted text")
  .option("--timeout <ms>", "global request timeout in ms", "30000");

// Apply --no-color before subcommands run
program.hook("preAction", (_thisCommand, actionCommand) => {
  const opts = program.opts();
  if (opts.color === false) {
    chalk.level = 0;
  }
  // Propagate global options so subcommands can read them
  (program as any)._globalOpts = opts;
});

// Register subcommands
import { register as registerHealth } from "../src/commands/health.js";
import { register as registerCard } from "../src/commands/card.js";
import { register as registerSend } from "../src/commands/send.js";
import { register as registerStatus } from "../src/commands/status.js";
import { register as registerDiscover } from "../src/commands/discover.js";
import { register as registerStream } from "../src/commands/stream.js";
import { register as registerBench } from "../src/commands/bench.js";
import { register as registerTrace } from "../src/commands/trace.js";

registerHealth(program);
registerCard(program);
registerSend(program);
registerStatus(program);
registerDiscover(program);
registerStream(program);
registerBench(program);
registerTrace(program);

program.parse();
