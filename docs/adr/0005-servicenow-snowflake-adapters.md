# ADR 0005 — ServiceNow `wm_order` and a Snowflake sink as adapters

**Status:** Accepted (as mocks) · 2026-09-27

## Context

The target stack names ServiceNow (work management) and Snowflake (analytics). The demo shouldn't
call either one, since it has no credentials and must never create real tickets. The shapes
should still be real, so that wiring them up means swapping an adapter, not redesigning.

## Decision

Both hang off the one `publish` path in `WorldHub`, so they see exactly what clients see, in
`seq` order.

- **`server/src/adapters/servicenow-mock.ts`:** the work-order schema mirrors `wm_order`
  (`number`, `state`, `short_description`, `assigned_to`, `location`, `priority`, `quantity`,
  `opened_at`). The adapter builds the Table API request a real integration would send and
  **logs** it:
  - a new order becomes `POST /api/now/table/wm_order`
  - any later change becomes `PATCH /api/now/table/wm_order?number=WO…`
  - dates use ServiceNow's glide format (`yyyy-MM-dd HH:mm:ss`, UTC)
  - the hospital goes in a custom `u_hospital_id` field
- **`server/src/adapters/history-sink.ts`:** appends one JSONL row per sequenced event to
  `server/data/history/<yyyy-mm-dd>.jsonl`, with the columns `EVENT_TS`, `HOSPITAL_ID`, `SEQ`,
  `EVENT_TYPE`, and `PAYLOAD` (an object). That shape loads directly with Snowflake
  `COPY INTO … FILE_FORMAT = (TYPE = JSON)` into a table with a `VARIANT` payload column, or
  with Snowpipe from a stage. The app never reads it back.

## Consequences

- To go live, swap in a real adapter behind the same interface: an OAuth ServiceNow client with
  retries, or a stage upload plus Snowpipe. The world, protocol, and clients don't change.
- **Outbound calls must never block the socket path.** A real ServiceNow adapter would queue
  requests (an outbox) and treat a ServiceNow outage as a delay, not as a failed `accept_wo`.
- `(HOSPITAL_ID, SEQ)` is a natural idempotency key for both sinks, because `seq` has no gaps
  within a world's lifetime.
