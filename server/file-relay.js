#!/usr/bin/env node
"use strict";

const net = require("node:net");

function positiveInteger(name, fallback) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

const HOST = process.env.A2A_FILE_RELAY_HOST || "127.0.0.1";
const PORT = positiveInteger("A2A_FILE_RELAY_PORT", 19182);
if (PORT > 65535) throw new Error("A2A_FILE_RELAY_PORT must be <= 65535");
const MAX_BYTES = positiveInteger("A2A_FILE_RELAY_MAX_BYTES", 1024 * 1024 * 1024);
const HEADER_BYTES = positiveInteger("A2A_FILE_RELAY_HEADER_BYTES", 16 * 1024);
const HEADER_MS = positiveInteger("A2A_FILE_RELAY_HEADER_MS", 10_000);
const PAIRING_MS = positiveInteger("A2A_FILE_RELAY_PAIRING_MS", 30_000);
const STALL_MS = positiveInteger(
  "A2A_FILE_RELAY_STALL_MS",
  process.env.A2A_FILE_RELAY_WAIT_MS || 2 * 60 * 1000,
);
const MAX_DURATION_MS = positiveInteger("A2A_FILE_RELAY_MAX_DURATION_MS", 2 * 60 * 60 * 1000);
const MAX_SESSIONS = positiveInteger("A2A_FILE_RELAY_MAX_SESSIONS", 128);
const MAX_CONNECTIONS = positiveInteger("A2A_FILE_RELAY_MAX_CONNECTIONS", 512);
const MAX_INFLIGHT_BYTES = positiveInteger(
  "A2A_FILE_RELAY_MAX_INFLIGHT_BYTES",
  Math.max(MAX_BYTES, 4 * 1024 * 1024 * 1024),
);

const sessions = new Map();
const sockets = new Set();
let inFlightBytes = 0;

const log = (event, details = {}) => process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), event, ...details })}\n`);
const line = (value) => `${JSON.stringify(value)}\n`;
const validId = (id) => typeof id === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(id);
const validTicket = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{32,256}$/.test(value);
const validDevice = (value) => typeof value === "string" && /^[A-Za-z0-9._:-]{1,256}$/.test(value);

function closeSocket(socket, response) {
  if (!socket || socket.destroyed) return;
  if (response !== undefined) socket.end(line(response));
  else socket.end();
  const timer = setTimeout(() => socket.destroy(), 1_000);
  timer.unref();
}

function readHeader(socket, onHeader, onFailure) {
  let buffered = Buffer.alloc(0);
  let settled = false;
  const cleanup = () => {
    socket.off("data", onData);
    socket.off("end", onEnd);
  };
  const fail = (error) => {
    if (settled) return;
    settled = true;
    cleanup();
    onFailure(error);
  };
  const onEnd = () => fail(new Error("socket ended before header"));
  const onData = (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    const newline = buffered.indexOf(10);
    if (newline < 0) {
      if (buffered.length > HEADER_BYTES) fail(new Error("header too large"));
      return;
    }
    if (newline > HEADER_BYTES) return fail(new Error("header too large"));
    settled = true;
    cleanup();
    socket.pause();
    try {
      const parsed = JSON.parse(buffered.subarray(0, newline).toString("utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("header must be an object");
      onHeader(parsed, buffered.subarray(newline + 1));
    } catch (error) {
      onFailure(error instanceof Error ? error : new Error(String(error)));
    }
  };
  socket.on("data", onData);
  socket.once("end", onEnd);
  socket.resume();
}

function clearSessionTimers(session) {
  clearTimeout(session.pairingTimer);
  clearTimeout(session.stallTimer);
  clearTimeout(session.deadlineTimer);
  session.pairingTimer = undefined;
  session.stallTimer = undefined;
  session.deadlineTimer = undefined;
}

function releaseSession(session) {
  if (sessions.get(session.id) === session) sessions.delete(session.id);
  clearSessionTimers(session);
  if (session.accountedBytes) {
    inFlightBytes = Math.max(0, inFlightBytes - session.accountedBytes);
    session.accountedBytes = 0;
  }
}

function destroySession(id, error) {
  const session = sessions.get(id);
  if (!session) return;
  const failedState = session.state;
  session.state = "FAILED";
  releaseSession(session);
  const response = { ok: false, id, code: "TRANSFER_FAILED", error: String(error.message || error) };
  closeSocket(session.sender, response);
  closeSocket(session.receiver, response);
  log("transfer_failed", { id, state: failedState, error: response.error });
}

function armStallTimer(session) {
  clearTimeout(session.stallTimer);
  session.stallTimer = setTimeout(
    () => destroySession(session.id, new Error(`${session.state.toLowerCase()} stalled`)),
    STALL_MS,
  );
  session.stallTimer.unref();
}

function waitForAck(session, payloadMs) {
  if (sessions.get(session.id) !== session) return;
  session.state = "WAIT_ACK";
  armStallTimer(session);
  session.sender.once("data", () => destroySession(session.id, new Error("sender wrote beyond declared size")));
  session.sender.resume();
  readHeader(
    session.receiver,
    (ack) => {
      if (sessions.get(session.id) !== session) return;
      const valid =
        ack.ok === true &&
        ack.transferId === session.id &&
        Number(ack.size) === session.size &&
        ack.sha256 === session.sha256;
      if (!valid) return destroySession(session.id, new Error(`invalid receiver ACK: ${JSON.stringify(ack)}`));
      session.state = "DONE";
      releaseSession(session);
      closeSocket(session.sender, ack);
      closeSocket(session.receiver);
      log("transfer_ack", { id: session.id, ok: true, relayPayloadMs: payloadMs });
    },
    (error) => destroySession(session.id, error),
  );
}

function startTransfer(session) {
  if (!session.sender || !session.receiver || session.state !== "PAIRING") return;
  clearTimeout(session.pairingTimer);
  session.state = "TRANSFERRING";
  session.remaining = session.size;
  session.startedNs = process.hrtime.bigint();
  session.deadlineTimer = setTimeout(
    () => destroySession(session.id, new Error("transfer absolute deadline exceeded")),
    MAX_DURATION_MS,
  );
  session.deadlineTimer.unref();
  armStallTimer(session);

  session.receiver.write(line({ type: "metadata", id: session.id, size: session.size, sha256: session.sha256 }));
  session.sender.write(line({ type: "ready", id: session.id }));
  log("transfer_started", { id: session.id, size: session.size, sourceDevice: session.sourceDevice, targetDevice: session.targetDevice });

  const completePayload = () => {
    if (session.state !== "TRANSFERRING") return;
    session.sender.off("data", consume);
    const payloadMs = Number(process.hrtime.bigint() - session.startedNs) / 1e6;
    log("payload_complete", { id: session.id, size: session.size, relayPayloadMs: payloadMs });
    waitForAck(session, payloadMs);
  };

  const consume = (chunk) => {
    if (sessions.get(session.id) !== session || session.state !== "TRANSFERRING") return;
    if (chunk.length > session.remaining) {
      return destroySession(session.id, new Error("sender wrote beyond declared size"));
    }
    session.remaining -= chunk.length;
    armStallTimer(session);
    if (chunk.length && !session.receiver.write(chunk)) {
      session.sender.pause();
      session.receiver.once("drain", () => {
        if (sessions.get(session.id) === session && session.state === "TRANSFERRING") session.sender.resume();
      });
    }
    if (session.remaining === 0) completePayload();
  };

  session.sender.on("data", consume);
  if (session.senderRemainder?.length) consume(session.senderRemainder);
  if (session.state === "TRANSFERRING" && session.remaining === 0) completePayload();
  // Registration parsing pauses the socket from inside its current `data`
  // callback. Resume on the next turn so Node cannot re-apply that pause after
  // startTransfer returns and silently stall the payload.
  if (session.state === "TRANSFERRING") {
    setImmediate(() => {
      if (sessions.get(session.id) === session && session.state === "TRANSFERRING") {
        session.sender.resume();
      }
    });
  }
}

function registerSocket(socket, header, remainder) {
  if (header.version !== 1 || !validId(header.id) || !validTicket(header.token) || !["sender", "receiver"].includes(header.role)) {
    closeSocket(socket, { ok: false, code: "INVALID_REGISTRATION", error: "invalid registration" });
    return;
  }
  if (!validDevice(header.sourceDevice) || !validDevice(header.targetDevice)) {
    closeSocket(socket, { ok: false, code: "INVALID_REGISTRATION", error: "invalid device identity" });
    return;
  }

  let session = sessions.get(header.id);
  if (!session) {
    if (sessions.size >= MAX_SESSIONS) {
      closeSocket(socket, { ok: false, code: "BUSY", error: "session limit reached" });
      return;
    }
    session = {
      id: header.id,
      token: header.token,
      state: "PAIRING",
      createdAt: Date.now(),
      accountedBytes: 0,
    };
    session.pairingTimer = setTimeout(
      () => destroySession(header.id, new Error("pairing timeout")),
      PAIRING_MS,
    );
    session.pairingTimer.unref();
    sessions.set(header.id, session);
  }
  if (session.token !== header.token) {
    closeSocket(socket, { ok: false, code: "TICKET_MISMATCH", error: "ticket mismatch" });
    return;
  }
  if (session.state !== "PAIRING") {
    closeSocket(socket, { ok: false, code: "DUPLICATE_ROLE", error: "transfer already started" });
    return;
  }

  if (header.role === "receiver") {
    if (session.receiver) {
      closeSocket(socket, { ok: false, code: "DUPLICATE_ROLE", error: "receiver already registered" });
      return;
    }
    session.receiver = socket;
    session.receiverSource = header.sourceDevice;
    session.receiverTarget = header.targetDevice;
    session.receiver.write(line({ type: "registered", id: header.id }));
    log("receiver_waiting", { id: header.id });
  } else {
    const size = Number(header.size);
    const sha256 = String(header.sha256 || "");
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_BYTES || !/^[a-f0-9]{64}$/.test(sha256)) {
      closeSocket(socket, { ok: false, code: "INVALID_METADATA", error: "invalid size or sha256" });
      return;
    }
    if (session.sender) {
      closeSocket(socket, { ok: false, code: "DUPLICATE_ROLE", error: "sender already registered" });
      return;
    }
    if (inFlightBytes + size > MAX_INFLIGHT_BYTES) {
      closeSocket(socket, { ok: false, code: "BUSY", error: "in-flight byte limit reached" });
      if (!session.receiver) releaseSession(session);
      return;
    }
    session.sender = socket;
    session.senderRemainder = remainder;
    session.size = size;
    session.sha256 = sha256;
    session.sourceDevice = header.sourceDevice;
    session.targetDevice = header.targetDevice;
    session.accountedBytes = size;
    inFlightBytes += size;
  }

  socket.setTimeout(0);
  socket.__a2aSessionId = header.id;
  socket.__a2aRole = header.role;
  if (session.sender && session.receiver) {
    if (session.sourceDevice !== session.receiverTarget || session.targetDevice !== session.receiverSource) {
      destroySession(header.id, new Error("device pairing mismatch"));
      return;
    }
  }
  startTransfer(session);
}

const server = net.createServer((socket) => {
  if (sockets.size >= MAX_CONNECTIONS) {
    closeSocket(socket, { ok: false, code: "BUSY", error: "connection limit reached" });
    return;
  }
  sockets.add(socket);
  socket.setNoDelay(true);
  socket.setTimeout(HEADER_MS, () => {
    if (!socket.__a2aSessionId) closeSocket(socket, { ok: false, code: "HEADER_TIMEOUT", error: "registration timeout" });
  });
  socket.on("error", (error) => {
    const id = socket.__a2aSessionId;
    if (id) destroySession(id, error);
    else log("connection_error", { error: String(error.message || error) });
  });
  socket.on("close", () => {
    sockets.delete(socket);
    const id = socket.__a2aSessionId;
    const session = id ? sessions.get(id) : undefined;
    if (session && session.state !== "DONE" && session.state !== "FAILED") {
      destroySession(id, new Error(`${socket.__a2aRole || "peer"} disconnected`));
    }
  });
  readHeader(
    socket,
    (header, remainder) => registerSocket(socket, header, remainder),
    (error) => closeSocket(socket, { ok: false, code: "INVALID_REGISTRATION", error: error.message }),
  );
});

server.on("error", (error) => {
  log("server_error", { error: String(error.message || error) });
  process.exitCode = 1;
});

server.listen(PORT, HOST, () => log("listening", {
  host: HOST,
  port: PORT,
  maxBytes: MAX_BYTES,
  maxSessions: MAX_SESSIONS,
  maxConnections: MAX_CONNECTIONS,
  maxInFlightBytes: MAX_INFLIGHT_BYTES,
}));

const shutdown = (signal) => {
  log("shutdown", { signal });
  for (const id of [...sessions.keys()]) destroySession(id, new Error("relay shutting down"));
  for (const socket of sockets) socket.destroy();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5_000).unref();
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
