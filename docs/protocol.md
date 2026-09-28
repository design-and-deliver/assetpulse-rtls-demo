# AssetPulse wire protocol (v1)

The single source of truth is [`packages/protocol/src/frames.ts`](../packages/protocol/src/frames.ts)
(zod schemas) and [`constants.ts`](../packages/protocol/src/constants.ts). If this page and those
files disagree, the code wins. Please also fix this page.

## Connection

```
wss://<host>/ws?h=<hospitalId>
```

- `h` is the hospital sandbox id: exactly 8 characters matching `[a-z0-9]`. Every socket with
  the same `h` shares one server-authoritative world. When the console loads without an `h`, it
  generates one and writes it into the URL with `history.replaceState`.
- `/ws` shares the HTTP server's port. App Service exposes only one port.
- Every frame is a UTF-8 JSON text frame. A binary frame closes the socket.
- There is no auth. The hospital id is a sandbox key, not a secret. For where real auth would sit,
  see [ADR 0004](adr/0004-apim-entra-placement.md).

## Envelope

Every frame, in both directions, has this shape:

```json
{ "v": 1, "type": "<frame type>", "ts": 1759000000000, "...": "type-specific fields" }
```

`ts` is epoch milliseconds from the sender's clock. A frame whose `v` is not `1`, or that fails
its schema, closes the socket with **4400**.

## Topics

A socket gets only its `hello` until it sends `subscribe`. `subscribe` replaces the socket's
topic set; it does not add to it.

| Topic       | Receives                                  | Used by                 |
| ----------- | ----------------------------------------- | ----------------------- |
| `floor`     | `positions`, `asset_changed`, `par_alert` | ops console             |
| `role:ops`  | `work_order`                              | ops console             |
| `role:tech` | `work_order`                              | tech pager, `/tech` app |

`ack` goes only to the socket that sent the command. `hello` and `resync` go to one socket, or,
after a `reset`, to every socket in the world.

## Server → client frames

### Sequenced events (durable, replayable)

These frames carry `seq`: a per-world counter that starts at 1, has no gaps, and only increases.
Each world keeps the last **1,000** in a ring buffer. They are never dropped under backpressure.

| `type`          | Fields                                                 | Emitted when                         |
| --------------- | ------------------------------------------------------ | ------------------------------------ |
| `asset_changed` | `seq, assetId, from, to, status`                       | a pump moves zone or is restocked    |
| `par_alert`     | `seq, zoneId, state: BREACH\|CLEARED, clean, min, max` | the shelf crosses its minimum        |
| `work_order`    | `seq, order`                                           | an order is opened, accepted, closed |

- `status` is `CLEAN` (on the shelf) or `IN_USE` (in a patient room). It follows the zone.
- A restocked pump's `asset_changed` has `from: "RESTOCK"`.
- `order` mirrors ServiceNow `wm_order` and has these fields:
  - `number`: `WO0010001`, … counting up per world
  - `state`: `open|accepted|closed`
  - `short_description`
  - `assigned_to`
  - `location`
  - `priority`
  - `quantity`
  - `opened_at`
- ⛔ **Changes to these shapes are additive only.** During a deploy, the ring buffer can replay old
  frames to clients running a newer build.

### Snapshots

| `type`   | Fields                   | Sent                                                    |
| -------- | ------------------------ | ------------------------------------------------------- |
| `hello`  | `worldId, seq, snapshot` | first frame on every connection                         |
| `resync` | `seq, snapshot`          | a `resume` that can't be replayed, or after any `reset` |

A `snapshot` is `{ assets[], workOrders[], par }`, where `par` is
`{ zoneId, clean, min, max, state: OK|BREACH }`. The snapshot's `seq` is the newest event it
already includes.

### Positions (ephemeral, droppable)

```json
{
  "v": 1,
  "type": "positions",
  "ts": 0,
  "batch": [{ "assetId": "IVP-101", "x": 812, "y": 140, "zoneId": "CLEAN-UTIL" }]
}
```

- **No `seq`, by design.** The simulator ticks at 10 Hz, and each asset's latest position is
  coalesced and flushed to `floor` subscribers at **4 Hz**.
- **Backpressure:** if a socket's `bufferedAmount` is over **512 KiB**, the server skips that
  socket's flush and counts the skip in `/healthz` → `positionSkips`. The next flush carries
  newer positions, so nothing is lost that matters.
- Resume never replays positions. The next batch repaints the map.

### `ack`

```json
{ "v": 1, "type": "ack", "ts": 0, "cmdId": "c-42", "ok": false, "error": "ALREADY_ASSIGNED" }
```

## Client → server frames

| `type`      | Fields              |
| ----------- | ------------------- |
| `subscribe` | `topics: Topic[]`   |
| `resume`    | `lastSeq`           |
| `command`   | `cmdId, name, args` |

### Commands

| `name`       | `args`                    | Errors (`ack.error`)                          |
| ------------ | ------------------------- | --------------------------------------------- |
| `move_asset` | `{ assetId, toZoneId }`   | `NOT_FOUND`, `INVALID_TRANSITION` (same zone) |
| `accept_wo`  | `{ orderNumber, techId }` | `NOT_FOUND`, `ALREADY_ASSIGNED`               |
| `deliver_wo` | `{ orderNumber }`         | `NOT_FOUND`, `NOT_ASSIGNED` (still open)      |
| `reset`      | `{}`                      | none                                          |
| `ping`       | `{}`                      | none; it changes nothing                      |

- Args that fail their schema close the socket with 4400, the same as any malformed frame. A
  malformed frame is a client bug, not a user error. (`BAD_ARGS` is in the error enum for
  forward-compatibility, but the server never sends it today.)
- **Idempotency:** each world remembers the last **1,000** `cmdId`s and the `ack` each one got. A
  retried `cmdId` gets its original `ack` back and never runs twice. `ping` is not cached.
- **The race:** two techs send `accept_wo` for the same order. The first one wins
  (`ok: true`, and a `work_order` event with `assigned_to` set goes out). The second gets
  `ok: false, error: "ALREADY_ASSIGNED"`, and its card disappears when the `work_order` event
  arrives.
- **RTT:** every **5 s** the client sends `ping` and times how long its `ack` takes. That time is
  the RTT the console shows.

## Heartbeat

The server sends a WebSocket protocol-level ping to every socket every **15 s**. If a socket
hasn't answered the previous ping with a pong by the time the next one is due, the server
terminates it. Browsers answer pings automatically. The heartbeat only reaps dead connections.
Clients measure their own RTT with the `ping` command.

## Close codes

| Code   | Meaning                                                                  | Client should            |
| ------ | ------------------------------------------------------------------------ | ------------------------ |
| `4400` | missing or bad `h`, unparseable frame, wrong `v`, binary frame, bad args | not retry the same frame |
| `4503` | server is at 25 worlds and none are idle                                 | back off and retry       |
| `1011` | unexpected server error while handling a frame                           | reconnect                |

Worlds with no sockets for 15 minutes are garbage-collected. When a 26th world is requested, the
world that has been idle longest is evicted.

## Resume algorithm

The client tracks `lastSeq`, the highest `seq` it has applied.

1. **Connect:** the server sends `hello{seq, snapshot}`. On the first connection, the client
   applies the snapshot and sets `lastSeq = hello.seq`.
2. **Apply:** for each sequenced event, if `seq ≤ lastSeq`, drop it as a duplicate. Otherwise
   apply it and set `lastSeq = seq`.
3. **Disconnect:** reconnect after `min(10 s, 500 ms × 2^attempt) × (0.5 + random/2)`. That is
   exponential backoff with jitter, so a server restart doesn't cause a thundering herd. Commands
   still in flight fail with `DISCONNECTED`. The shipped client doesn't retry them automatically
   and leaves that to the user. A client that did retry would resend the same `cmdId`, and the
   server's command cache makes that safe.
4. **Reconnect:** send `subscribe` first, then `resume{lastSeq}`. The order matters, because the
   server filters the replay by the topics that are current when `resume` arrives.
5. **The server answers `resume`** synchronously, so no live event can arrive in the middle of the
   replay:
   - If `lastSeq` is still in the ring, the server replays every later event on the client's
     topics, in order.
   - Otherwise the server sends one `resync{seq, snapshot}`. That happens when `lastSeq` has been
     evicted, is older than a `reset` barrier, or is _ahead_ of the server (the server restarted
     and the world was recreated).
6. **On `resync`:** replace local state with the snapshot and set `lastSeq = resync.seq`, even if
   that is lower. The world was replaced.

A `reset` sets a barrier in the log and broadcasts a `resync` to every socket. A reset deletes the
pumps that restocks added, and no sequenced event can express a deletion. Replaying across the
reset would therefore rebuild state that no longer exists.

## Probing it by hand

```bash
npx wscat -c "wss://<host>/ws?h=probe001"
> {"v":1,"type":"subscribe","ts":0,"topics":["floor","role:ops"]}
> {"v":1,"type":"command","ts":0,"cmdId":"t1","name":"move_asset","args":{"assetId":"IVP-101","toZoneId":"ICU-301"}}
> {"v":1,"type":"resume","ts":0,"lastSeq":0}
```
