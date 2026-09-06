"use strict";

const fs = require("node:fs");
const path = require("node:path");

const [configPath, receiveDir, mode = "auto"] = process.argv.slice(2);
if (!configPath || !receiveDir) {
  throw new Error("usage: node configure-file-transfer.cjs CONFIG_PATH RECEIVE_DIR [mode]");
}
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const plugin = config.plugins?.entries?.["a2a-gateway"]?.config;
if (!plugin) throw new Error("a2a-gateway config not found");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backup = path.join(path.dirname(configPath), `openclaw.json.before-a2a-ft-${stamp}`);
fs.copyFileSync(configPath, backup);
plugin.fileTransfer = {
  enabled: true,
  mode,
  host: "121.37.53.35",
  port: 8001,
  serverName: "a2a-file.invalid",
  certificateSha256: "439e94b1c0b6cf14fabcc0224e5b921ae583518e0838ea8a9b8e642538fd929a",
  receiveDir,
  maxFileSizeBytes: 1073741824,
  maxConcurrentReceives: 4,
  maxInFlightBytes: 2147483648,
  connectTimeoutMs: 15000,
  transferTimeoutMs: 1800000,
  inlinePreferredBelowBytes: 1048576,
  quic: {
    enabled: true,
    binary: "/data/local/tmp/a2a-rcp/rcp-raw-stream-v7",
    extraEnv: {
      LD_LIBRARY_PATH: "/system/lib64/ndk:/data/local/tmp/a2a-rcp",
    },
    relayHost: "121.37.53.35",
    relayPort: 8008,
  },
};
fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ ok: true, configPath, backup, mode, fileTransfer: plugin.fileTransfer })}\n`);
