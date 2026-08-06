import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { AuditLogger } from "../src/audit.js";

let tmpDir: string;
let auditPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-test-"));
  auditPath = path.join(tmpDir, "audit.jsonl");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("AuditLogger", () => {
  it("creates audit file on first write", () => {
    const logger = new AuditLogger(auditPath);
    logger.recordInbound("task-1", "ctx-1", "completed", 150);
    logger.close();
    assert.ok(fs.existsSync(auditPath));
  });

  it("writes JSONL format (one JSON object per line)", () => {
    const logger = new AuditLogger(auditPath);
    logger.recordInbound("task-1", "ctx-1", "completed", 100);
    logger.recordInbound("task-2", "ctx-2", "failed", 200);
    logger.close();

    const lines = fs.readFileSync(auditPath, "utf-8").trim().split("\n");
    assert.equal(lines.length, 2);
    const entry1 = JSON.parse(lines[0]);
    assert.equal(entry1.direction, "inbound");
    assert.equal(entry1.taskId, "task-1");
    assert.equal(entry1.status, "completed");
    assert.equal(entry1.durationMs, 100);
  });

  it("recordOutbound writes peer and statusCode", () => {
    const logger = new AuditLogger(auditPath);
    logger.recordOutbound("AWS-bot", true, 200, 350);
    logger.close();

    const lines = fs.readFileSync(auditPath, "utf-8").trim().split("\n");
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.direction, "outbound");
    assert.equal(entry.peer, "AWS-bot");
    assert.equal(entry.status, "success");
    assert.equal(entry.statusCode, 200);
    assert.equal(entry.durationMs, 350);
  });

  it("recordOutbound failure", () => {
    const logger = new AuditLogger(auditPath);
    logger.recordOutbound("peer-x", false, 500, 1200);
    logger.close();

    const lines = fs.readFileSync(auditPath, "utf-8").trim().split("\n");
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.status, "failure");
    assert.equal(entry.statusCode, 500);
  });

  it("recordSecurityEvent writes detail", () => {
    const logger = new AuditLogger(auditPath);
    logger.recordSecurityEvent("http", "invalid token");
    logger.close();

    const lines = fs.readFileSync(auditPath, "utf-8").trim().split("\n");
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.direction, "inbound");
    assert.equal(entry.type, "security");
    assert.equal(entry.status, "rejected");
    assert.equal(entry.detail, "http: invalid token");
  });

  it("tail returns last N entries in reverse order", async () => {
    const logger = new AuditLogger(auditPath);
    logger.recordInbound("task-1", "ctx-1", "completed", 100);
    logger.recordInbound("task-2", "ctx-2", "completed", 200);
    logger.recordInbound("task-3", "ctx-3", "failed", 300);
    logger.close();

    const result = await logger.tail(2);
    assert.equal(result.length, 2);
    assert.equal(result[0].taskId, "task-3"); // newest first
    assert.equal(result[1].taskId, "task-2");
  });

  it("tail returns empty array when file does not exist", async () => {
    const logger = new AuditLogger(path.join(tmpDir, "nonexistent.jsonl"));
    const result = await logger.tail();
    assert.equal(result.length, 0);
  });

  it("tail defaults to 50 entries", async () => {
    const logger = new AuditLogger(auditPath);
    for (let i = 0; i < 60; i++) {
      logger.recordInbound(`task-${i}`, `ctx-${i}`, "completed", i * 10);
    }
    logger.close();

    const result = await logger.tail();
    assert.equal(result.length, 50);
    assert.equal(result[0].taskId, "task-59"); // newest first
  });

  it("each entry has ISO timestamp", () => {
    const logger = new AuditLogger(auditPath);
    logger.recordInbound("task-1", "ctx-1", "completed", 100);
    logger.close();

    const lines = fs.readFileSync(auditPath, "utf-8").trim().split("\n");
    const entry = JSON.parse(lines[0]);
    assert.ok(entry.ts);
    assert.ok(!isNaN(Date.parse(entry.ts)));
  });

  it("creates parent directories if they do not exist", () => {
    const deepPath = path.join(tmpDir, "a", "b", "c", "audit.jsonl");
    const logger = new AuditLogger(deepPath);
    logger.recordInbound("task-1", "ctx-1", "completed", 100);
    logger.close();
    assert.ok(fs.existsSync(deepPath));
  });
});
