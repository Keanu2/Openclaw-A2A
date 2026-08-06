import fs from "node:fs";

const p = process.argv[2] || "/data/local/.openclaw/openclaw.json";
const j = JSON.parse(fs.readFileSync(p, "utf8"));
j.plugins = j.plugins || {};
j.plugins.entries = j.plugins.entries || {};
const e = (j.plugins.entries["a2a-gateway"] = j.plugins.entries["a2a-gateway"] || {
  enabled: true,
});
e.config = e.config || {};
e.config.storage = e.config.storage || {};
e.config.storage.tasksDir = "/data/local/.openclaw/a2a-tasks";
e.config.observability = e.config.observability || {};
if (!e.config.observability.auditLogPath) {
  e.config.observability.auditLogPath = "/data/local/.openclaw/a2a-audit.jsonl";
}
fs.writeFileSync(p, JSON.stringify(j, null, 2));
console.log("tasksDir=", e.config.storage.tasksDir);
console.log("auditLogPath=", e.config.observability.auditLogPath);
