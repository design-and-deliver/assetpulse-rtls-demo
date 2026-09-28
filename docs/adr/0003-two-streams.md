# ADR 0003 — Two streams: sequenced events and droppable positions

**Status:** Accepted · 2026-09-27

## Context

An RTLS feed mixes two kinds of data with opposite delivery needs:

- **Positions** are high-rate and superseded almost at once. A dot's position from 250 ms ago is
  worthless once a newer one exists.
- **State changes** are rare and must not be lost: a pump leaving the shelf, a PAR breach, a work
  order being opened or taken. If a screen misses "WO0010001 accepted", two techs walk to the
  same room.

A single stream forces one policy on both. If every frame is sequenced, the ring buffer fills
with positions, resume replays thousands of stale coordinates, and a slow client can never catch
up. If every frame is droppable, events get lost.

## Decision

- **Events** (`asset_changed`, `par_alert`, `work_order`) carry a per-world `seq`, are appended
  to a ring of 1,000, go out immediately, and are never skipped.
- **Positions** carry no `seq`. The server keeps the latest position per asset, flushes one
  coalesced batch at 4 Hz, and skips a client's flush whenever its `bufferedAmount` is over
  512 KiB.
- Resume replays events only. The next position batch repaints the map.

## Consequences

- A slow or throttled client degrades gracefully. Its dots stutter, but its state is exact.
- An invariant can break silently: routing an event through the position flush, or giving
  positions a `seq`, breaks resume without failing to compile. The resume integration test
  guards it, and it is a standing rule in the plan.
- Event shapes are additive-only, because the ring can replay frames written by an older build
  during a deploy.
- A deletion (a `reset` removing restocked pumps) can't be expressed as an event. A reset
  therefore sets a replay barrier and broadcasts `resync`.
