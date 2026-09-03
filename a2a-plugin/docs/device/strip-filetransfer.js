const fs = require("fs");
const path = "/data/local/.openclaw/openclaw.json";
const bak = path + ".bak.before-no-tcp-" + Date.now();
const raw = fs.readFileSync(path, "utf8");
const cfg = JSON.parse(raw);
fs.writeFileSync(bak, raw);
const a2a = cfg?.plugins?.entries?.["a2a-gateway"]?.config;
if (!a2a) {
  console.error("no a2a-gateway config");
  process.exit(2);
}
const had = !!a2a.fileTransfer;
delete a2a.fileTransfer;
fs.writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n");
console.log(JSON.stringify({ ok: true, removedFileTransfer: had, backup: bak }));
