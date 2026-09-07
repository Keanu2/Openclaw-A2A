#!/usr/bin/env node
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const [peer, filePath] = process.argv.slice(2);
if (!peer || !filePath) process.exit(2);

function extractResult(output) {
  const marker = "Gateway call: a2a.send_file";
  const markerIndex = output.lastIndexOf(marker);
  const start = output.indexOf("{", markerIndex);
  if (markerIndex < 0 || start < 0) throw new Error("gateway result JSON not found");
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < output.length; index += 1) {
    const char = output[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) return JSON.parse(output.slice(start, index + 1));
  }
  throw new Error("gateway result JSON incomplete");
}

const params = JSON.stringify({ peer, path: filePath, name: path.basename(filePath) });
const started = Date.now();
const call = spawnSync("/data/local/npm/bin/openclaw", [
  "gateway", "call", "a2a.send_file",
  "--timeout", "600000",
  "--params", params,
], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
const output = `${call.stdout || ""}\n${call.stderr || ""}`;
let compact;
try {
  const value = extractResult(output);
  compact = {
    processStatus: call.status,
    elapsedMs: Date.now() - started,
    ok: value.ok,
    error: value.error,
    transferId: value.transferId,
    transport: value.transport,
    size: value.size,
    sha256: value.sha256,
    hashMs: value.hashMs,
    dataCommitted: value.dataCommitted,
    notificationOk: value.notificationOk,
    controlPrepareMs: value.controlPrepareMs,
    senderSetupMs: value.senderSetupMs,
    senderPayloadMs: value.senderPayloadMs,
    senderAckWaitMs: value.senderAckWaitMs,
    transferMs: value.transferMs,
    taskState: value.response?.status?.state,
  };
} catch (error) {
  compact = {
    processStatus: call.status,
    elapsedMs: Date.now() - started,
    ok: false,
    error: `${error.message}; output tail: ${output.slice(-1200)}`,
  };
}
console.log(`BENCH_RESULT=${JSON.stringify(compact)}`);
process.exit(call.status === 0 ? 0 : 1);
