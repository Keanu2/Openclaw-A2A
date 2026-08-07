# Internal Gateway Modules

These modules implement **OpenClaw gateway-to-gateway** communication extensions.
They are **NOT** part of the [A2A (Agent2Agent) protocol specification](https://a2a-protocol.org/latest/specification/).

## What's here

| Module | Purpose |
|---|---|
| `types-internal.ts` | Type definitions for all internal modules |
| `envelope.ts` | Custom `a2a/v1` envelope format with validation |
| `transport.ts` | Custom HTTP transport with `/a2a/v1/inbox` endpoint and `X-A2A-*` headers |
| `security.ts` | HMAC-SHA256 signing for gateway-to-gateway auth (A2A standard uses OAuth/API Key) |
| `routing.ts` | Route-key / agent-id based message routing |
| `outbox.ts` | Outbox pattern with exponential backoff retry |
| `idempotency.ts` | SHA-256 deduplication store |
| `metrics.ts` | Protocol metrics collector and structured logging |

## Why separate?

The standard A2A protocol surface (Agent Card, JSON-RPC, REST endpoints) is handled by
`@a2a-js/sdk` and the files in the parent `src/` directory. These internal modules extend
that with custom reliability and routing features for OpenClaw's gateway mesh.
