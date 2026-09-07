#!/usr/bin/env node
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const HDC = "C:\\Users\\1\\tools\\hdc\\hdc.exe";
const DEVICE_NODE = "/data/local/tools/node-v24.2.0-openharmony-arm64/bin/node";
const SEND_SCRIPT = "/data/local/tmp/device-send-file-benchmark.cjs";
const STATE_DIR = "/data/local/tmp/a2a-tcp-received/.a2a-transfer-state";
const OUTPUT = path.resolve(__dirname, "../docs/test-data/TCP-REAL-DEVICE-2026-09-03.jsonl");

const devices = {
  Phone2: {
    serial: "53V0224C19002918",
    peer: "HW-Phone1",
    sourceDevice: "HW-Phone2",
    hashes: {
      10: "7cdbd15e5e7ab19fb847f5f7c43646e52f6104b324949b0a1e983eb7a4083bd9",
      100: "156dceaf3c1d03905302213c31ea84ed594a897f15be3319873d2340222a518e",
    },
  },
  Phone1: {
    serial: "FMR0223926019410",
    peer: "HW-Phone2",
    sourceDevice: "HW-Phone1",
    hashes: {
      10: "fcb25248c2adfb2f850d57d0544815a10ff291c7a4110222558cfa0cab887abe",
      100: "dae3cd24348210c18a516be5714ae061b31c30f7c92eb18f9889cc366bf9b215",
    },
  },
};

function run(executable, args) {
  return new Promise((resolve) => {
    const child = spawn(executable, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => resolve({ code: null, stdout, stderr, error: error.message }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function extractGatewayResult(output) {
  const compact = output.match(/^BENCH_RESULT=(\{.*\})$/m);
  if (compact) return JSON.parse(compact[1]);
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
  throw new Error("gateway result JSON was incomplete");
}

async function readReceiverEvidence(receiverSerial, transferId) {
  const stateResult = await run(HDC, ["-t", receiverSerial, "shell", `cat ${STATE_DIR}/${transferId}.json`]);
  if (stateResult.code !== 0) throw new Error(`receiver state read failed: ${stateResult.stderr || stateResult.stdout}`);
  const record = JSON.parse(stateResult.stdout.trim());
  const quotedPath = `'${String(record.path).replaceAll("'", "'\\''")}'`;
  const hashResult = await run(HDC, ["-t", receiverSerial, "shell", `sha256sum ${quotedPath}`]);
  if (hashResult.code !== 0) throw new Error(`receiver sha256sum failed: ${hashResult.stderr || hashResult.stdout}`);
  return { record, diskSha256: hashResult.stdout.trim().split(/\s+/)[0] };
}

async function main() {
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, "", "utf8");
  const order = ["Phone2", "Phone1"];
  let ordinal = 0;
  for (const sizeMiB of [10, 100]) {
    for (const senderName of order) {
      const sender = devices[senderName];
      const receiverName = senderName === "Phone2" ? "Phone1" : "Phone2";
      const receiver = devices[receiverName];
      for (let sample = 1; sample <= 5; sample += 1) {
        ordinal += 1;
        const sourcePath = `/data/local/tmp/a2a-tcp-benchmark/payload-${sizeMiB}m.txt`;
        process.stdout.write(`[${ordinal}/20] ${senderName}->${receiverName} ${sizeMiB}MiB run ${sample} ... `);
        const startedAt = new Date().toISOString();
        const command = `${DEVICE_NODE} ${SEND_SCRIPT} ${sender.peer} ${sourcePath}`;
        const sent = await run(HDC, ["-t", sender.serial, "shell", command]);
        const combined = `${sent.stdout}\n${sent.stderr}`;
        let result;
        let parseError;
        try { result = extractGatewayResult(combined); } catch (error) { parseError = error.message; }
        let evidence;
        let evidenceError;
        if (result?.transferId) {
          try { evidence = await readReceiverEvidence(receiver.serial, result.transferId); }
          catch (error) { evidenceError = error.message; }
        }
        const elapsedMatch = combined.match(/elapsed_ms:\s*(\d+)/);
        const expectedSha256 = sender.hashes[sizeMiB];
        const taskState = result?.taskState || result?.response?.status?.state;
        const success = sent.code === 0
          && result?.ok === true
          && result?.dataCommitted === true
          && result?.notificationOk === true
          && taskState === "completed"
          && result?.sha256 === expectedSha256
          && ["DATA_COMMITTED", "COMPLETED"].includes(evidence?.record?.state)
          && evidence?.diskSha256 === expectedSha256;
        const row = {
          ordinal,
          startedAt,
          direction: `${senderName}->${receiverName}`,
          sourceDevice: sender.sourceDevice,
          targetDevice: receiver.sourceDevice,
          sizeMiB,
          sample,
          success,
          processExitCode: sent.code,
          elapsedMs: result?.elapsedMs ?? (elapsedMatch ? Number(elapsedMatch[1]) : null),
          transferId: result?.transferId || null,
          transport: result?.transport || null,
          hashMs: result?.hashMs ?? null,
          controlPrepareMs: result?.controlPrepareMs ?? null,
          senderSetupMs: result?.senderSetupMs ?? null,
          senderPayloadMs: result?.senderPayloadMs ?? null,
          senderAckWaitMs: result?.senderAckWaitMs ?? null,
          transferMs: result?.transferMs ?? null,
          dataCommitted: result?.dataCommitted === true,
          notificationOk: result?.notificationOk === true,
          taskState: taskState || null,
          receiverState: evidence?.record?.state || null,
          receiverPath: evidence?.record?.path || null,
          expectedSha256,
          receiverDiskSha256: evidence?.diskSha256 || null,
          error: result?.error || parseError || evidenceError || (success ? null : combined.slice(-2000)),
        };
        fs.appendFileSync(OUTPUT, `${JSON.stringify(row)}\n`, "utf8");
        process.stdout.write(`${success ? "PASS" : "FAIL"} elapsed=${row.elapsedMs ?? "?"}ms transfer=${row.transferMs ?? "?"}ms id=${row.transferId ?? "?"}\n`);
      }
    }
  }
  console.log(`Results: ${OUTPUT}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
