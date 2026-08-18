#!/usr/bin/env node
"use strict";

const net = require("node:net");

const HOST = process.env.A2A_FILE_RELAY_HOST || "127.0.0.1";
const PORT = Number(process.env.A2A_FILE_RELAY_PORT || 19182);
const MAX_BYTES = Number(process.env.A2A_FILE_RELAY_MAX_BYTES || 1024 * 1024 * 1024);
const WAIT_MS = Number(process.env.A2A_FILE_RELAY_WAIT_MS || 30 * 60 * 1000);
const sessions = new Map();

const log = (event, details = {}) => process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), event, ...details })}\n`);
const line = (value) => `${JSON.stringify(value)}\n`;
const validId = (id) => typeof id === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(id);
const validTicket = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{32,256}$/.test(value);

function readHeader(socket, callback) {
  let buffered = Buffer.alloc(0);
  const onData = (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    if (buffered.length > 16 * 1024) return socket.destroy(new Error("header too large"));
    const newline = buffered.indexOf(10);
    if (newline < 0) return;
    socket.off("data", onData);
    try {
      callback(JSON.parse(buffered.subarray(0, newline).toString("utf8")), buffered.subarray(newline + 1));
    } catch (error) {
      socket.destroy(error);
    }
  };
  socket.on("data", onData);
}

function destroySession(id, error) {
  const session = sessions.get(id);
  if (!session) return;
  sessions.delete(id);
  clearTimeout(session.timer);
  if (error) {
    const response = line({ ok: false, error: String(error.message || error) });
    if (session.sender && !session.sender.destroyed) session.sender.end(response);
    if (session.receiver && !session.receiver.destroyed) session.receiver.end(response);
    log("transfer_failed", { id, error: String(error.message || error) });
  }
}

function startTransfer(session) {
  if (!session.sender || !session.receiver || session.started) return;
  session.started = true;
  session.remaining = session.size;
  session.startedNs = process.hrtime.bigint();
  session.receiver.write(line({ type: "metadata", id: session.id, size: session.size, sha256: session.sha256 }));
  session.sender.write(line({ type: "ready", id: session.id }));
  log("transfer_started", { id: session.id, size: session.size, sourceDevice: session.sourceDevice, targetDevice: session.targetDevice });

  const consume = (chunk) => {
    if (session.remaining <= 0) return;
    const take = Math.min(chunk.length, session.remaining);
    session.remaining -= take;
    if (!session.receiver.write(chunk.subarray(0, take))) {
      session.sender.pause();
      session.receiver.once("drain", () => session.sender.resume());
    }
    if (chunk.length > take) return destroySession(session.id, new Error("sender wrote beyond declared size"));
    if (session.remaining === 0) {
      session.sender.off("data", consume);
      const payloadMs = Number(process.hrtime.bigint() - session.startedNs) / 1e6;
      log("payload_complete", { id: session.id, size: session.size, relayPayloadMs: payloadMs });
      readHeader(session.receiver, (ack) => {
        session.sender.end(line(ack));
        session.receiver.end();
        clearTimeout(session.timer);
        sessions.delete(session.id);
        log("transfer_ack", { id: session.id, ok: Boolean(ack.ok), relayPayloadMs: payloadMs });
      });
    }
  };
  session.sender.on("data", consume);
  if (session.senderRemainder?.length) consume(session.senderRemainder);
}

const server = net.createServer((socket) => {
  socket.setNoDelay(true);
  socket.setTimeout(WAIT_MS, () => socket.destroy(new Error("socket timeout")));
  readHeader(socket, (header, remainder) => {
    if (header.version !== 1 || !validId(header.id) || !validTicket(header.token) || !["sender", "receiver"].includes(header.role)) {
      return socket.end(line({ ok: false, error: "invalid registration" }));
    }
    let session = sessions.get(header.id);
    if (!session) {
      session = {
        id: header.id,
        token: header.token,
        createdAt: Date.now(),
        timer: setTimeout(() => destroySession(header.id, new Error("pairing timeout")), WAIT_MS),
      };
      sessions.set(header.id, session);
    }
    if (session.token !== header.token) return socket.end(line({ ok: false, error: "ticket mismatch" }));
    if (header.role === "receiver") {
      if (session.receiver) return socket.end(line({ ok: false, error: "receiver already registered" }));
      session.receiver = socket;
      session.receiverSource = header.sourceDevice;
      session.receiverTarget = header.targetDevice;
      log("receiver_waiting", { id: header.id });
    } else {
      const size = Number(header.size);
      const sha256 = String(header.sha256 || "");
      if (!Number.isSafeInteger(size) || size < 0 || size > MAX_BYTES || !/^[a-f0-9]{64}$/.test(sha256)) {
        return socket.end(line({ ok: false, error: "invalid size or sha256" }));
      }
      if (session.sender) return socket.end(line({ ok: false, error: "sender already registered" }));
      session.sender = socket;
      session.senderRemainder = remainder;
      session.size = size;
      session.sha256 = sha256;
      session.sourceDevice = header.sourceDevice;
      session.targetDevice = header.targetDevice;
    }
    if (session.sender && session.receiver) {
      if (session.sourceDevice !== session.receiverTarget || session.targetDevice !== session.receiverSource) {
        return destroySession(header.id, new Error("device pairing mismatch"));
      }
    }
    socket.on("error", (error) => destroySession(header.id, error));
    socket.on("close", () => {
      const current = sessions.get(header.id);
      if (current && current.remaining > 0) destroySession(header.id, new Error(`${header.role} disconnected`));
    });
    startTransfer(session);
  });
});

server.listen(PORT, HOST, () => log("listening", { host: HOST, port: PORT, maxBytes: MAX_BYTES }));

const shutdown = (signal) => {
  log("shutdown", { signal });
  for (const id of sessions.keys()) destroySession(id, new Error("relay shutting down"));
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5_000).unref();
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
