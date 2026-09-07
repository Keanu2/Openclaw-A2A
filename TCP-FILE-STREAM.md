# TCP/QUIC byte-stream file transfer snapshot

Private snapshot of the A2A file data plane (control = A2A tunnel).

- `v1.5.0`: TLS/TCP streaming + 2026-09-02 urgent fixes
- `v1.5.1`: contract (attemptId/transports) + `quic-v7` provider; device bidir acceptance
- `v1.6.0`: unified `fileTransfer.mode` + Agent Card selection (`auto`/`quic`/`tcp`/`base64`); single send path
- `v1.6.1`: wait for receiver `DATA_COMMITTED` before `a2a-transfer://`; status `RECEIVING`
- `v1.6.2`: TCP commit falls back when HarmonyOS `Docs/OPENCLAW` rejects `link(2)` (`EPERM` → rename/copy)

Plugin package version: **`openclaw-a2a@1.6.2`**. Changelog: `a2a-plugin/CHANGELOG.md`.

| Doc | Role |
|-----|------|
| `a2a-plugin/docs/FILE-TRANSFER-UNIFIED-PLAN.md` | Unified mode+Card design (shipped 1.6.0+) |
| `a2a-plugin/docs/FILE-TRANSFER-1.6.0-DEVICE-ACCEPTANCE-2026-09-03.md` | 1.6.0 device matrix |
| `a2a-plugin/docs/FILE-TRANSFER-1.6.1-DEVICE-ACCEPTANCE-2026-09-04.md` | 1.6.1 notify race |
| `a2a-plugin/docs/FILE-TRANSFER-1.6.2-DEVICE-ACCEPTANCE-2026-09-07.md` | 1.6.2 Docs/OPENCLAW hard-link |
| `a2a-plugin/docs/FILE-TRANSFER-1.5.1-DEVICE-ACCEPTANCE-2026-09-03.md` | 1.5.1 QUIC/TCP bidir |

| Path | Role |
|------|------|
| `a2a-plugin/` | Client plugin (TCP + QUIC providers) |
| `server/file-relay.js` | TLS pairing relay (server) |
