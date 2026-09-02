# TCP/QUIC byte-stream file transfer snapshot

Private snapshot of the A2A file data plane (control = A2A tunnel).

- `v1.5.0`: TLS/TCP streaming + 2026-09-02 urgent fixes
- `v1.5.1`: contract (attemptId/transports) + `quic-v7` provider; device bidir acceptance

See `a2a-plugin/docs/FILE-TRANSFER-1.5.1-DEVICE-ACCEPTANCE-2026-09-03.md`.

| Path | Role |
|------|------|
| `a2a-plugin/` | Client plugin (TCP + QUIC providers) |
| `server/file-relay.js` | TLS pairing relay (server) |
