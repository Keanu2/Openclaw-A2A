"use strict";

const fs = require("node:fs");
const path = require("node:path");

const [configPath, receiveDir] = process.argv.slice(2);
if (!configPath || !receiveDir) throw new Error("usage: node configure-file-transfer.cjs CONFIG_PATH RECEIVE_DIR");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const plugin = config.plugins?.entries?.["a2a-gateway"]?.config;
if (!plugin) throw new Error("a2a-gateway config not found");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backup = path.join(path.dirname(configPath), `openclaw.json.before-a2a-tcp-${stamp}`);
fs.copyFileSync(configPath, backup);
plugin.fileTransfer = {
  enabled: true,
  host: "121.37.53.35",
  port: 8001,
  serverName: "a2a-file.invalid",
  certificateSha256: "6086a975186fe2e7edec1307e929c0d191551860bed571fa8820d56464e10a6b",
  receiveDir,
  maxFileSizeBytes: 1073741824,
  connectTimeoutMs: 15000,
  transferTimeoutMs: 1800000,
};
fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ ok: true, configPath, backup, fileTransfer: plugin.fileTransfer })}\n`);
