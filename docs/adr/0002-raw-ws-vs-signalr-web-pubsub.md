# ADR 0002 — Raw `ws`, not Socket.IO, SignalR, or Azure Web PubSub

**Status:** Accepted · 2026-09-27

## Context

The demo exists to show WebSocket engineering on the hiring team's stack. Libraries like
Socket.IO and SignalR, and the managed services built on them, hide exactly the parts worth
discussing: framing, reconnect, resume, backpressure, and heartbeats.

## Decision

Use `ws` 8.x on Node 22 and a hand-written protocol with zod schemas in `packages/protocol`. The
client is a small library, `packages/client`, that is shared by the React console and the Expo
handheld. It uses only the standard `WebSocket` API, so it runs unchanged in browsers and React
Native.

## When I would choose otherwise

- **Azure Web PubSub:** fan-out to tens of thousands of connections, or many App Service
  instances. A single Node process holds world state in memory, so this demo scales up, not out.
  Web PubSub moves the connections off the app, and the app publishes to groups over REST. Topics
  here map one to one onto Web PubSub groups (`h:<id>:floor`, `h:<id>:role:tech`). The event log
  and resume would still live in the app, or in a store the app writes before publishing.
- **Azure SignalR Service:** the same reasoning, for a .NET backend.
- **Socket.IO:** a team that wants rooms, acks, and reconnect off the shelf, and that accepts a
  non-standard wire format. Its reconnect doesn't replay missed events, so a sequenced log would
  still be needed.

## Consequences

- Everything a managed service provides is now code this repo owns: heartbeat, backoff with
  jitter, command idempotency, resume, and backpressure. Each piece is small, and each has tests
  that use real sockets.
- There is one process per hospital world. Scaling out would mean sticky routing by `h`, or
  moving world state and the event log to a shared store.
