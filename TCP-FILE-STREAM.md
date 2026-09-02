# TCP byte-stream file transfer snapshot

Private snapshot of the A2A TLS/TCP file data plane.

- Base branch: `feature/a2a-tcp-file-stream-v1` (`682d484`, 2026-08-18)
- This snapshot also includes the 2026-09-02 urgent correctness fixes

Control plane remains the existing A2A tunnel. File bytes go through an independent TLS/TCP File Relay, not A2A JSON.

## Docs

- [a2a-plugin/docs/TCP-FILE-STREAM-CODE-REVIEW-2026-09-02.md](a2a-plugin/docs/TCP-FILE-STREAM-CODE-REVIEW-2026-09-02.md) — audit baseline
- [a2a-plugin/docs/TCP-FILE-STREAM-URGENT-FIXES-2026-09-02.md](a2a-plugin/docs/TCP-FILE-STREAM-URGENT-FIXES-2026-09-02.md) — what this snapshot fixed

## Status

Emergency non-auth defects are converged and have basic regression coverage. This is **not** production-ready: inbound prepare auth (`TCP-002`), device credentials / WSS (`TCP-003`), capability negotiation, and dual-device soak tests are still open.

## Layout

| Path | Role |
|------|------|
| `a2a-plugin/src/file-transfer.ts` | sender/receiver TCP client, prepare/status/cancel |
| `a2a-plugin/src/file-transfer-store.ts` | durable JSON transfer records |
| `a2a-plugin/src/file-transfer-types.ts` | shared types and error categories |
| `server/file-relay.js` | TLS pairing relay |
| `server/file-relay.test.cjs` | relay protocol tests |
| `server/a2a-file-relay.service` | systemd unit with resource limits |
