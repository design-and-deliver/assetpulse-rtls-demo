# ADR 0006 — Snowflake + Cortex as an opt-in cold path

**Status:** Accepted (sandbox; not enabled in production) · 2026-10-22

## Context

ADR 0005 shaped history for Snowflake but never sent it. The next step is to load it for real
and put Cortex on top: plain-English questions about the floor's history (Cortex Analyst) and a
shift summary (`AI_SUMMARIZE_AGG`). The live demo at assetpulse.proswitch.ai must not change
until this is promoted on purpose.

## Decision

- **Off by default.** Nothing runs unless `SNOWFLAKE_ENABLED=1` and every credential is set
  (`server/src/snowflake/config.ts`). Off means no extra sink, and `/api/insights/status`
  answers `{ enabled: false }` so the console never renders the panel.
- **No new dependency.** Snowflake is called over HTTPS with `fetch`: key-pair JWT auth, the
  SQL API for statements, and the Cortex Analyst REST endpoint (`server/src/snowflake/rest.ts`).
  The deploy bundle (which ships only `ws`, `sirv`, `zod`) is unchanged.
- **Cold path, never the hot path.** `SnowflakeSink.record` only pushes to an array. A timer
  sends 200-row batches as one `INSERT … SELECT … PARSE_JSON(…) FROM VALUES`. A failed batch is
  requeued and logged; the queue is capped, dropping the oldest rows. `TeeSink` keeps local
  JSONL history writing even if Snowflake is down.
- **Generated SQL is checked before it runs.** We run Analyst's SQL with our own role, so the
  server only runs a single `SELECT`/`WITH` that names this hospital's id
  (`refusalFor` in `server/src/snowflake/insights.ts`). The role itself can only insert events
  and read three views (`docs/snowflake/setup.sql`).
- **Credits are bounded.** One Cortex call per hospital every 3 s, an X-Small warehouse that
  suspends after 60 s, and a resource monitor on the warehouse.

## Consequences

- Promotion is a config change: set the env vars on App Service. Rolling back is unsetting them.
- Plain INSERTs are fine at demo volume. At real RTLS volume, switch to Snowpipe Streaming (or
  stage files + Snowpipe) and dedupe on `(HOSPITAL_ID, SEQ)`.
- The hospital-id check is a guardrail, not row-level security. A multi-tenant version would
  put a row access policy on `EVENTS` keyed to the caller, so the database enforces it.
- Flips if: the target stack drops Snowflake, or Cortex isn't available in the account's region
  (cross-region inference is the first fallback).
