"use strict";

const assert = require("node:assert/strict");
const { createHash, randomBytes } = require("node:crypto");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { test } = require("node:test");

const relayPath = path.join(__dirname, "file-relay.js");

function connect(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port }, () => resolve(socket));
    socket.once("error", reject);
  });
}

function lineReader(socket) {
  let buffer = Buffer.alloc(0);
  return () => new Promise((resolve, reject) => {
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const newline = buffer.indexOf(10);
      if (newline < 0) return;
      const line = buffer.subarray(0, newline);
      buffer = buffer.subarray(newline + 1);
      socket.off("data", onData);
      resolve({ json: JSON.parse(line.toString("utf8")), remainder: buffer });
    };
    socket.on("data", onData);
    socket.once("error", reject);
  });
}

test("pairs sender and receiver, streams bytes, and returns receiver ACK", async () => {
  const port = 21982 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, [relayPath], {
    env: { ...process.env, A2A_FILE_RELAY_PORT: String(port), A2A_FILE_RELAY_WAIT_MS: "10000" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("relay start timeout")), 5000);
      child.stdout.on("data", (chunk) => {
        if (chunk.toString().includes('"event":"listening"')) { clearTimeout(timer); resolve(); }
      });
      child.once("error", reject);
    });
    const payload = randomBytes(1024 * 1024);
    const sha256 = createHash("sha256").update(payload).digest("hex");
    const id = "test-transfer";
    const token = randomBytes(32).toString("base64url");
    const receiver = await connect(port);
    const sender = await connect(port);
    const readReceiver = lineReader(receiver);
    const readSender = lineReader(sender);
    receiver.write(`${JSON.stringify({ version: 1, role: "receiver", id, token, sourceDevice: "pc", targetDevice: "phone" })}\n`);
    sender.write(`${JSON.stringify({ version: 1, role: "sender", id, token, sourceDevice: "phone", targetDevice: "pc", size: payload.length, sha256 })}\n`);
    const metadata = await readReceiver();
    assert.equal(metadata.json.type, "metadata");
    const ready = await readSender();
    assert.equal(ready.json.type, "ready");
    const chunks = [metadata.remainder];
    let size = metadata.remainder.length;
    const received = new Promise((resolve, reject) => {
      receiver.on("data", (chunk) => {
        chunks.push(chunk);
        size += chunk.length;
        if (size >= payload.length) resolve(Buffer.concat(chunks).subarray(0, payload.length));
      });
      receiver.once("error", reject);
    });
    sender.write(payload);
    const actual = await received;
    assert.deepEqual(actual, payload);
    receiver.write(`${JSON.stringify({ ok: true, size: payload.length, sha256 })}\n`);
    const ack = await readSender();
    assert.equal(ack.json.ok, true);
    receiver.destroy();
    sender.destroy();
  } finally {
    child.kill("SIGTERM");
  }
});
