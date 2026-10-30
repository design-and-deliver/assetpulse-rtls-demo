# ADR 0007 — Remediation as its own page over a tenant-scoped store

**Status:** Accepted · 2026-10-30

## Context

A customer's security team needs to find vulnerable medical devices across all of its hospitals
and group them into remediation projects. That is a different job from the live floor demo: it
is about slicing a large fleet by many dimensions, not watching a few infusion pumps.

## Decision

- **Its own URL, `/riskradar` (originally `/remediation`, which now redirects), with no link from the console.** It is a second Vite entry
  (`web/remediation/index.html`), so the console's bundle and screen are unchanged. It shares the
  sandbox id `?h=`, which stands in for the customer (tenant).
- **Generic dimensions, not one kind of device.** Severity, status, hospital, device class, and
  manufacturer are each a filter, a facet count, and a grid column (`DIMENSIONS` in
  `packages/protocol/src/remediation.ts`). Adding a dimension is one entry there plus a column.
- **Filtering, sorting, and paging happen on the server.** Facet counts are taken under every
  _other_ active filter, so a second value in the same dimension still shows what it would add.
- **Projects can be made from a selection or from everything matching a filter**, capped at
  `MAX_PROJECT_DEVICES`. A device id the caller doesn't own is a 404, not a 403, so ids can't be
  probed. A device's status (Unplanned → Planned → Remediated) comes from its projects.
- **One store interface, two stores.** `MemoryStore` is the default. `SnowflakeStore` is used
  when the Snowflake layer is on and setup.sql's remediation tables exist. If they are missing,
  the page falls back to memory with one log line instead of failing. Every SQL statement binds
  the customer first, and column names come from fixed lookup tables, never from the request.
- **Demo data is generated per customer** (`server/src/remediation/fleet.ts`): deterministic
  from the id, with fictional hospitals, manufacturers, and CVE ids. Snowflake seeds a
  customer's fleet on its first visit.

## Consequences

- A real deployment replaces the generator with an ingest from the CMMS and a vulnerability feed,
  and replaces `?h=` with a customer id from a validated token.
- Snowflake answers a page in about a second (three statements in parallel). Fine for a
  workspace, but not for keystroke-speed filtering at scale. The next step there is a cached
  facet table or Hybrid Tables for the project writes.
- As in ADR 0006, scoping by customer is enforced in the app. A row access policy on the
  remediation tables would make the database enforce it too.
