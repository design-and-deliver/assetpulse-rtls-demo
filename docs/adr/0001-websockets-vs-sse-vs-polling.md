# ADR 0001 — WebSockets, not SSE or polling

**Status:** Accepted · 2026-09-27

## Context

This demo needs two kinds of traffic:

- **Server → client:** 4 Hz position batches plus discrete events (PAR breaches and work-order
  changes) that must reach every screen watching a hospital within a frame.
- **Client → server:** a tech's `accept_wo` must reach the server, and the tech must learn whether
  they won the race for the order, on the same connection that tells everyone else the order is
  taken.

## Options

|                    | Latency         | Bidirectional                       | Resume                         | Ops cost                               |
| ------------------ | --------------- | ----------------------------------- | ------------------------------ | -------------------------------------- |
| Short/long polling | ≥ poll interval | via separate POSTs                  | natural (`?since=`)            | simplest; wastes requests at 4 Hz      |
| SSE                | push            | no; commands go over separate POSTs | built in (`Last-Event-ID`)     | plain HTTP; works through most proxies |
| **WebSockets**     | push            | yes, one socket                     | hand-built (`resume{lastSeq}`) | needs WS-aware proxies and a heartbeat |

## Decision

Use WebSockets. With one socket, a command's `ack` and the resulting broadcast travel on the same
ordered channel. The "clean loser" guarantee is then easy to reason about: the losing tech's
`ack{ok:false}` and the winner's `work_order` event both arrive in the order the server decided.
At 4 Hz times many assets, polling means paying for a request per tick per client.

## Consequences

- Resume has to be built by hand (sequenced events, a ring buffer, `resume{lastSeq}`). SSE would
  have provided it through `Last-Event-ID`. The upside is that the resume is visible in code and
  tests. See [the resume algorithm](../protocol.md#resume-algorithm).
- A server heartbeat (15 s) is needed to reap half-open sockets that the OS never reports.
- Corporate proxies that strip `Upgrade` would break the demo. In that environment, SSE plus POST
  is the fallback, and the protocol's event/command split would map onto it unchanged.
