"use strict";

const assert = require("node:assert/strict");
const { createHash, randomBytes } = require("node:crypto");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { test } = require("node:test");

const relayPath = path.join(__dirname, "file-relay.js");

function within(promise, label, ms = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timeout`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

function connect(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port }, () => resolve(socket));
    socket.once("error", reject);
  });
}

function lineReader(socket) {
  let buffer = Buffer.alloc(0);
  return () => new Promise((resolve, reject) => {
    const takeLine = () => {
      const newline = buffer.indexOf(10);
      if (newline < 0) return false;
      const line = buffer.subarray(0, newline);
      buffer = buffer.subarray(newline + 1);
      resolve({ json: JSON.parse(line.toString("utf8")), remainder: buffer });
      return true;
    };
    if (takeLine()) return;
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const onError = (error) => { cleanup(); reject(error); };
    const onClose = () => { cleanup(); reject(new Error("socket closed before line")); };
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (takeLine()) cleanup();
    };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

async function startRelay(extraEnv = {}) {
  const port = 22000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [relayPath], {
    env: {
      ...process.env,
      A2A_FILE_RELAY_PORT: String(port),
      A2A_FILE_RELAY_STALL_MS: "3000",
      A2A_FILE_RELAY_PAIRING_MS: "3000",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  let stdout = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`relay start timeout: ${stderr}`)), 5000);
    const onExit = (code) => {
      clearTimeout(timer);
      reject(new Error(`relay exited during start (${code}): ${stderr}`));
    };
    child.once("exit", onExit);
    child.stdout.on("data", (chunk) => {
      if (chunk.toString().includes('"event":"listening"')) {
        clearTimeout(timer);
        child.off("exit", onExit);
        resolve();
      }
    });
  });
  return { child, port, getStderr: () => stderr, getStdout: () => stdout };
}

async function stopRelay(relay) {
  if (relay.child.exitCode !== null) return;
  relay.child.kill("SIGTERM");
  await new Promise((resolve) => relay.child.once("exit", resolve));
}

function registration(id, token, role, size = 0, sha256 = createHash("sha256").digest("hex")) {
  return {
    version: 1,
    role,
    id,
    token,
    sourceDevice: role === "sender" ? "phone" : "pc",
    targetDevice: role === "sender" ? "pc" : "phone",
    ...(role === "sender" ? { size, sha256 } : {}),
  };
}

async function runTransfer(port, payload, id = `test-${randomBytes(5).toString("hex")}`) {
  const sha256 = createHash("sha256").update(payload).digest("hex");
  const token = randomBytes(32).toString("base64url");
  const receiver = await connect(port);
  const sender = await connect(port);
  const readReceiver = lineReader(receiver);
  const readSender = lineReader(sender);
  receiver.write(`${JSON.stringify(registration(id, token, "receiver"))}\n`);
  sender.write(`${JSON.stringify(registration(id, token, "sender", payload.length, sha256))}\n`);
  const registered = await within(readReceiver(), "receiver registration");
  assert.equal(registered.json.type, "registered");
  const metadata = await within(readReceiver(), "metadata");
  assert.equal(metadata.json.type, "metadata");
  assert.equal(metadata.json.id, id);
  const ready = await within(readSender(), "ready");
  assert.equal(ready.json.type, "ready");

  let actual = metadata.remainder;
  if (payload.length > actual.length) {
    const received = new Promise((resolve, reject) => {
      const chunks = [actual];
      let size = actual.length;
      receiver.on("data", function onData(chunk) {
        chunks.push(chunk);
        size += chunk.length;
        if (size >= payload.length) {
          receiver.off("data", onData);
          resolve(Buffer.concat(chunks).subarray(0, payload.length));
        }
      });
      receiver.once("error", reject);
    });
    sender.write(payload);
    actual = await within(received, "payload");
  }
  assert.deepEqual(actual, payload);
  receiver.write(`${JSON.stringify({ ok: true, transferId: id, size: payload.length, sha256 })}\n`);
  const ack = await within(readSender(), "ack");
  assert.equal(ack.json.ok, true);
  assert.equal(ack.json.transferId, id);
  receiver.destroy();
  sender.destroy();
}

test("pairs sender and receiver, streams bytes, and returns receiver ACK", async () => {
  const relay = await startRelay();
  try {
    await runTransfer(relay.port, randomBytes(1024 * 1024)).catch((error) => {
      error.message += `\nrelay stdout:\n${relay.getStdout()}\nrelay stderr:\n${relay.getStderr()}`;
      throw error;
    });
  } finally {
    await stopRelay(relay);
  }
});

test("completes a zero-byte transfer", async () => {
  const relay = await startRelay();
  try {
    await runTransfer(relay.port, Buffer.alloc(0));
  } finally {
    await stopRelay(relay);
  }
});

test("rejects an oversized registration without crashing the relay", async () => {
  const relay = await startRelay({ A2A_FILE_RELAY_HEADER_BYTES: "1024" });
  try {
    const socket = await connect(relay.port);
    const read = lineReader(socket);
    socket.write(`${"x".repeat(2048)}\n`);
    const response = await read();
    assert.equal(response.json.ok, false);
    assert.equal(response.json.code, "INVALID_REGISTRATION");
    socket.destroy();
    assert.equal(relay.child.exitCode, null, relay.getStderr());
    await runTransfer(relay.port, Buffer.from("relay-still-alive"));
  } finally {
    await stopRelay(relay);
  }
});

test("fails the sender promptly when receiver disconnects after payload", async () => {
  const relay = await startRelay();
  try {
    const payload = Buffer.from("payload-before-receiver-disconnect");
    const sha256 = createHash("sha256").update(payload).digest("hex");
    const id = `disconnect-${randomBytes(5).toString("hex")}`;
    const token = randomBytes(32).toString("base64url");
    const receiver = await connect(relay.port);
    const sender = await connect(relay.port);
    const readReceiver = lineReader(receiver);
    const readSender = lineReader(sender);
    receiver.write(`${JSON.stringify(registration(id, token, "receiver"))}\n`);
    sender.write(`${JSON.stringify(registration(id, token, "sender", payload.length, sha256))}\n`);
    await readReceiver();
    await readReceiver();
    await readSender();
    sender.write(payload);
    receiver.destroy();
    const failure = await readSender();
    assert.equal(failure.json.ok, false);
    assert.match(failure.json.error, /receiver disconnected|ECONNRESET/);
    sender.destroy();
  } finally {
    await stopRelay(relay);
  }
});
