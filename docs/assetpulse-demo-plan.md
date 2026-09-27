# AssetPulse — live RTLS WebSocket demo for the GeoSense Tech Lead role — plan

**Alias:** `assetpulse` · **Branch:** `plan/assetpulse` (cut from `main` in 1.1) · **Base:** `main`
· **Model floor:** Sonnet-class; substeps tagged `[opus]` carry design judgment (UI) — run those
on Opus-class · **Status:** IN PROGRESS — 9 of 20 done · **Authored against:** the JD PDF
(`~/OneDrive/Pictures/Screenshots 1/Gmail - Technical Team Lead _ Senior Software Engineer.pdf`)
and the Gemini brainstorm (`trimedx_clinical_asset_telemetry_bundle.html`, review in
`ARTICLES/great-idea-no-websocket.html`).

Abandoning this plan is one `git branch -D plan/assetpulse`, at any point.
`git log main..plan/assetpulse` is the plan's whole reviewable delta.

**Target environment:**
- **Authoring / dev machine (verified 2026-09-27):** Windows 11, Node v22.14.0, npm 10.9.2,
  git 2.49, gh 2.86 (logged in as `design-and-deliver`). **No `az` CLI installed.**
- **Deploy target (ASSUMPTION, verified in 5.2):** Azure App Service, Linux, Node 22 LTS,
  Basic B1, Web sockets = On, Always On = On.
- **Reviewer (ASSUMPTION):** the hiring manager on a desktop browser (Chrome/Edge) plus an
  iPhone or Android phone that scans the QR code. They install nothing. Phone vibration works
  only on Android (`navigator.vibrate` is not available on iOS Safari), so the visual alert must
  work without it.

## Goal

This demo gives the hiring manager one URL. It shows a live hospital floor where simulated RTLS
tags (IV pumps) move between rooms. The clean-utility room's PAR level drops below its minimum,
and a work order reaches **their own phone** (via a QR code). They accept and deliver the order,
and the desktop updates live. A "kill network" toggle proves that reconnect and resume lose
nothing.

This maps to the JD in four ways:
- **Domain:** GeoSense is RTLS for hospital equipment, and this is a small slice of it.
- **Stack:** React for the web, React Native (Expo) for the handheld, hosted on Azure. APIM,
  Snowflake, and ServiceNow appear as ADRs and adapter shapes.
- **Tech-lead craft:** ADRs, a shared contract package, tests, and CI.
- **AI-assisted adoption:** `docs/ai-assisted-dev.md`.

The WebSocket depth sits in the protocol itself:
- topic subscriptions
- a sequenced event stream kept separate from an ephemeral position stream
- coalescing and backpressure
- heartbeats
- resume from `lastSeq`
- idempotent commands with acks
- a clean loser in a race

## How to execute

Work one substep per fresh session. You can run several back-to-back while projected peak
context stays under ~170k. Each executing session reads only three things:
- **the ⛔ section** (`this doc:159-193`)
- **its own substep**
- **the Ledger tail**

Never read the whole doc.

- **First session (1.1):** creates the repo, the first commit on `main`, and then
  `git switch -c plan/assetpulse`.
- **Every later session:** starts with `git switch plan/assetpulse && git merge main`.
- **Every substep:** ends with its **Verify** commands (all green), a commit (subject given in
  the substep, trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`), and a Ledger
  entry. Then `/clear` + `/continue`.
- **Merging:** merge to `main` ONCE, in 5.5.
- **Pushing:** the GitHub repo stays **private** until 5.5.

**MVP cut line:** if time runs short, Phases 1–3 plus 5.2–5.3 make a complete, shippable demo
(desktop only, with the tech view as a web route). Phase 4 (React Native) is the JD-matching
upgrade. Nominal totals are ~12h for the MVP and ~18h for everything.

## Decisions (locked at authoring — no substep reopens these)

- **Name: "AssetPulse", repo `assetpulse-rtls-demo`.** It is never branded GeoSense or TRIMEDX:
  no logos, no `trimedx` hostnames. The README says "built as a conversation piece for the
  GeoSense Tech Lead role". Presenting it as their product would be presumptuous.
- **npm workspaces, not pnpm.** Expo's Metro bundler and pnpm's symlinked `node_modules` need
  extra config. A reviewer should run one `npm install`. Workspaces are `packages/*`, `server`,
  `web`, and `mobile`.
- **TypeScript strict, ESM, Node 22.** `"type": "module"` everywhere except `mobile/` (Expo
  default).
- **Raw `ws` 8.x on the server.** Not Socket.IO and not SignalR, because the demo's point is the
  protocol those libraries hide. ADR 0002 says when you *would* use Azure Web PubSub / SignalR
  Service.
- **zod schemas in `packages/protocol`** are the single source of truth for every frame. The
  envelope is `{ v: 1, type, ts }` plus fields. Unknown `v` means the server closes the socket
  with code 4400.
- **Two streams:**
  - **Events** are durable and replayable. They carry `seq` (monotonic per world), are stored in
    a ring buffer of the last 1,000, and are never dropped.
  - **Positions** are ephemeral. They have no `seq`, are coalesced, and are droppable under
    backpressure. Resume replays events only, and the next position batch repaints the map.
  - ADR 0003.
- **Server-authoritative world, one per hospital id.**
  - The URL carries `?h=<id>` (8 chars `[a-z0-9]`). With no `h`, the web app generates one and
    `history.replaceState`s it.
  - Max 25 live worlds. A world with zero sockets for 15 min is garbage-collected.
  - If the 26th world is requested, the oldest idle world is evicted. If none is idle, the
    server closes with code 4503.
- **Timing constants** (all in `packages/protocol/src/constants.ts`):
  - sim tick 100 ms (10 Hz)
  - position flush 250 ms (4 Hz)
  - heartbeat ping every 15 s; terminate if no pong by the next ping
  - backpressure: skip a position flush when `ws.bufferedAmount > 512 * 1024`
  - client reconnect delay `min(10000, 500 * 2 ** attempt) * (0.5 + Math.random() / 2)`
  - command-id LRU of 1,000 per world
- **Floor model is fixed data** in `packages/protocol/src/floor.ts`:
  - Floor "3 West" on a 1000×600 SVG coordinate space.
  - Zones: `ICU-301..304` and `MS-305..308` (patient rooms), `CLEAN-UTIL`, `SOILED-UTIL`,
    `SPD` (reprocessing, drawn as an off-floor box), and `HALL`.
  - Assets: 14 IV pumps, `IVP-101..114`.
  - PAR applies to IV pumps in `CLEAN-UTIL`: **min 3, max 8**.
  - Initial state: 8 CLEAN in `CLEAN-UTIL`, 4 IN_USE in rooms, 2 REPROCESSING in `SPD`.
- **Asset lifecycle (the state machine):**
  - `CLEAN` → `IN_USE` → `SOILED` → `REPROCESSING` → `READY` → `CLEAN`.
  - `CLEAN` is only in `CLEAN-UTIL`. `IN_USE` is in a patient room. `SOILED` is in
    `SOILED-UTIL`. `REPROCESSING` and `READY` are in `SPD`.
  - `READY` → `CLEAN` happens **only** when a tech delivers a work order.
  - Any other transition is rejected with `INVALID_TRANSITION`.
- **Sim timings (demo-time):**
  - Every 6–10 s (seeded RNG), a random room either requests a pump (`CLEAN` → `IN_USE`, if
    one is available) or discharges one (`IN_USE` → `SOILED`), with 50/50 odds.
  - `SOILED` → `REPROCESSING` 8 s later. `REPROCESSING` → `READY` 15 s later.
  - "Surge ICU" moves up to 4 `CLEAN` pumps into ICU rooms at once.
- **PAR rule:**
  - When `CLEAN` count < min, emit `par_alert{state:"BREACH"}` and create ONE open work order
    for that zone (there is never a second).
  - The work-order quantity is `max − cleanCount`, re-computed on accept.
  - Delivering moves `min(quantity, readyCount)` `READY` pumps to `CLEAN`, then closes the
    order. If the count is then ≥ min, emit `par_alert{state:"CLEARED"}`. Otherwise the next
    tick opens a new order.
- **Work-order shape mirrors ServiceNow `wm_order`:** `number` (`WO0010001`…, a sequential
  counter per world, never random), `state` (`open|accepted|closed`), `short_description`,
  `assigned_to`, `location`, `priority` (`2`), `quantity`, and `opened_at`. It goes through
  `server/src/adapters/servicenow-mock.ts`, which only logs and never calls a network.
- **History sink is Snowflake-shaped JSONL:** `server/data/history/<yyyy-mm-dd>.jsonl`, one row
  per sequenced event, with columns `EVENT_TS`, `HOSPITAL_ID`, `SEQ`, `EVENT_TYPE`, and
  `PAYLOAD` (object). It is gitignored and never read back by the app.
- **Demo bot:** if a work order stays `open` for 45 s with no tech socket subscribed to
  `role:tech`, a server-side bot accepts it. It delivers when `READY` ≥ 1. This keeps the
  loop alive with no phone.
- **Auth: none.** The hospital id is a sandbox key, not a secret. ADR 0004 covers where Entra
  ID + APIM would sit.
- **Web:** React 19 + Vite + TypeScript, CSS Modules with design tokens, light and dark themes,
  and a calm clinical palette. Only alerts use color urgently (alarm fatigue is a real clinical
  concern). The UI substep consults the `ux-decisions` skill first.
- **Mobile:** Expo (the SDK current at 4.1), single screen, no expo-router. It imports
  `@assetpulse/client`. `npx expo export --platform web` output is served by the server at
  `/tech`.
- **Tests:** Vitest for everything. Integration tests start the real server on port 0 and drive
  it with real `ws` clients. There is one Playwright e2e (5.1).
- **Hosting:** Azure App Service Linux B1, about $13/mo. Delete it after the hiring process.
  - Not Free F1: it has no Always On, so it sleeps and cold-starts on the manager's first click.
  - Not Render's free tier, for the same reason.
  - Deploy with GitHub Actions `azure/webapps-deploy@v3` and a publish-profile secret.
- **Repo:** `gh repo create` under the `design-and-deliver` account, **private** from 1.1 and
  flipped public in 5.5.
- **Kept out of the repo (gitignored):** `.claude/`, `ARTICLES/`, `archive/` (which holds the
  Gemini HTML), and `server/data/`.

## ⛔ Standing traps — read before ANY substep

- **Never fake a frame, a latency figure, or a metric.** The Gemini draft's fatal flaw was a
  simulated socket (`Math.random()` latency, hand-written "SEND >>" logs). Every number the UI
  shows is measured:
  - RTT comes from ping/pong timing.
  - Frame counts come from actual `onmessage`.
  - The wire drawer shows the raw `event.data` string.
- **Protocol drift:** a frame type is added in `packages/protocol` FIRST (schema, type, and a
  test), then used. Never inline a string literal `type: "..."` in server, web, or mobile.
  Import the constant.
- **Positions are never sequenced and events are never dropped.** An edit that routes an event
  through the position flush (or gives positions a `seq`) breaks resume silently. The resume
  test in 2.2 is the guard.
- **Any change to a sequenced event's shape is additive-only** once 2.1 lands. The ring buffer
  replays old frames to clients that may be on a newer build during a deploy.
- **One open work order per zone.** Guard in the World model (1.3), not in the UI.
- **Sim determinism:** all randomness goes through the seeded RNG in `server/src/world/rng.ts`
  (1.4). `Math.random()` in `server/src/world/**` makes tests flaky. The only allowed
  `Math.random` is client reconnect jitter.
- **Windows dev machine:** use `cross-env` for env vars in npm scripts, and never `rm -rf` in
  scripts (use `rimraf`). Paths in tests use `path.join` / `fileURLToPath`.
- **Expo + monorepo:** Metro must resolve `@assetpulse/client` from the workspace. If it fails,
  the fix is `mobile/metro.config.js` with `watchFolders` = repo root and
  `resolver.nodeModulesPaths` = [`mobile/node_modules`, root `node_modules`]. Never copy the
  client source into `mobile/`.
- **App Service WebSockets are OFF by default.** A deploy that serves HTTP fine but whose `wss://`
  hangs means the toggle is off. It is not a code bug. Check the toggle before debugging (5.2).
- **App Service sets `PORT`.** The server must listen on `process.env.PORT ?? 8787`, and `/ws`
  must share the HTTP server (no second port).
- **`az` CLI is not installed.** Azure steps are `[INTERACTIVE ONLY]` portal steps done with the
  user. Never script around the missing CLI.
- **The JD PDF contains the recruiter's contact details.** Never copy it into the repo. Cite only
  the stack and role facts in docs.

## Phase 1 — Contract + pure world model (no sockets)

### ☑ 1.1 · L · ~1h — Repo scaffold, git, workspaces, tooling, private GitHub repo

**Budget:** files 1 (verbatim batch) · new 12 (+0 test) · trips ≈ 18
**Read:** this doc (Decisions + ⛔ + this substep only).

- [x] Move `trimedx_clinical_asset_telemetry_bundle.html` → `archive/`.
- [x] Create the root `package.json`: `private`, workspaces `["packages/*","server","web","mobile"]`,
  and the scripts `build`, `test` (`vitest run`), `typecheck` (`tsc -b`), `lint` (`eslint .`),
  and `dev` (`concurrently` server + web). Leave `mobile` out of the workspaces array until 4.1
  (an empty dir breaks `npm install`).
- [x] Create `tsconfig.base.json` (strict, ES2022, `moduleResolution: bundler`), `vitest.workspace.ts`,
  `eslint.config.js` (typescript-eslint recommended + `complexity: ["error", 10]`),
  `.prettierrc`, `.editorconfig`, `.nvmrc` (`22`), and `.gitignore` (node_modules, dist, the
  Decisions' gitignore list, `.env*`).
- [x] Create a `README.md` stub (title and one line) and `LICENSE` (MIT, Andrew Ciccarelli, 2026).
- [x] Create `.github/workflows/ci.yml`: on push/PR, Node 22, `npm ci`, typecheck, lint, test.
- [x] Run `npm install -D typescript vitest eslint typescript-eslint prettier concurrently cross-env rimraf`.
- [x] Run `git init -b main`, commit `chore: scaffold monorepo`, then `git switch -c plan/assetpulse`.
- [x] Run `gh repo create design-and-deliver/assetpulse-rtls-demo --private --source . --push`,
  then push `plan/assetpulse`.

**Verify:** `npm run typecheck && npm run lint && npm test -- --passWithNoTests`, then
`gh repo view --json visibility` returns `PRIVATE`, then `git status` is clean.
**Commit:** the `main` commit above. This substep's plan tick goes in a second commit,
`plan: tick 1.1 + ledger`, on the branch.

### ☑ 1.2 · M · ~45m — `packages/protocol`: envelope, frames, floor, constants

**Budget:** files 1 · new 4 (+1 test) · trips ≈ 12
**Read:** this doc (Decisions: "Two streams", "Floor model", "Work-order shape").

- [x] Create `packages/protocol/{package.json,tsconfig.json}` for `@assetpulse/protocol` (dep: `zod`).
- [x] `src/constants.ts`: every timing constant from Decisions, `PROTOCOL_VERSION = 1`,
  and the close codes `4400` (bad version/frame) and `4503` (capacity).
- [x] `src/floor.ts`: zones as `{id, kind: "room"|"clean"|"soiled"|"spd"|"hall", label, rect}`,
  laid out on 1000×600, plus the `PAR = { zone: "CLEAN-UTIL", min: 3, max: 8 }` config and the
  initial asset table.
- [x] `src/frames.ts`, with each frame in its own zod schema and a discriminated union:
  - **Server → client:**
    - `hello{worldId, seq, snapshot}` (snapshot = assets, workOrders, par)
    - `positions{batch:[{assetId,x,y,zoneId}]}`, which has **no seq**
    - sequenced (`seq:number`): `asset_changed{assetId, from, to, status}`,
      `par_alert{zoneId, state, clean, min, max}`, `work_order{order}`
    - `ack{cmdId, ok, error?}`
    - `resync{snapshot, seq}`
  - **Client → server:**
    - `subscribe{topics}` with topic literals `"floor"`, `"role:tech"`, `"role:ops"`
    - `resume{lastSeq}`
    - `command{cmdId, name, args}`, where `name` is one of `move_asset`, `surge`, `reset`,
      `accept_wo`, `deliver_wo`
- [x] Export `parseClientFrame` / `parseServerFrame` (return `{ok, frame} | {ok:false, error}`).
- [x] `test/frames.test.ts`: round-trip every frame, reject unknown `type`, reject `v:2`.

**Verify:** `npm test -w @assetpulse/protocol && npm run typecheck`
**Commit:** `feat(protocol): frame schemas, floor model, constants`

### ☑ 1.3 · M · ~1h — World model: lifecycle, PAR, work orders (pure)

**Budget:** files 2 · new 2 (+1 test) · trips ≈ 14
**Read:** `packages/protocol/src/{floor,frames,constants}.ts` (whole, each < 200 lines).

- [x] `server/` workspace skeleton (`package.json` for `@assetpulse/server`, deps: `@assetpulse/protocol`, `ws`).
- [x] `server/src/world/world.ts`: `class World` holding assets, open orders, `seq`, and `woCounter`.
  Methods return **event lists** and never emit themselves: `moveAsset`, `surge`, `reset`,
  `acceptOrder(orderNumber, techId)`, `deliverOrder(orderNumber)`, and `evaluatePar()`.
  Transition table per Decisions. Violations throw a typed `WorldError(code)` with codes
  `INVALID_TRANSITION`, `NOT_FOUND`, `ALREADY_ASSIGNED`, `NOT_ASSIGNED`, `NOTHING_READY`.
- [x] `server/test/world.test.ts`, covering:
  - the lifecycle happy path
  - an illegal transition
  - a PAR breach creating exactly one order
  - a second breach not creating a duplicate
  - a second accept → `ALREADY_ASSIGNED`
  - partial delivery (READY < quantity)
  - `CLEARED` emitted only when ≥ min
  - order numbers sequential

**Verify:** `npm test -w @assetpulse/server && npm run typecheck && npm run lint`
**Commit:** `feat(server): pure world model with PAR + work orders`

### ☑ 1.4 · M · ~45m — Seeded simulator: timers, random events, positions

**Budget:** files 2 · new 2 (+1 test) · trips ≈ 12
**Read:** `server/src/world/world.ts` (whole).

- [x] `server/src/world/rng.ts`: mulberry32 seeded RNG.
- [x] `server/src/world/simulator.ts`: `tick(dtMs)` advances the timers (SOILED→REPROCESSING 8 s,
  REPROCESSING→READY 15 s), fires the random room event every 6–10 s, and runs the demo bot per
  Decisions (it needs a `hasTech()` callback). It returns `{events, positions}`. Positions:
  each asset jitters inside its zone rect (±6 units per tick, clamped). A zone change tweens
  over 1.5 s along a straight line through the `HALL` centroid.
- [x] `server/test/simulator.test.ts`: the same seed gives an identical event sequence over 600
  ticks; timers fire at the exact tick; the bot accepts only after 45 s with `hasTech()=false`.

**Verify:** `npm test -w @assetpulse/server && npm run lint`
**Commit:** `feat(server): deterministic simulator`

### ☑ 1.5 · M · ~45m — Event log ring buffer, command LRU, history sink

**Budget:** files 1 · new 3 (+1 test) · trips ≈ 12
**Read:** `server/src/world/world.ts:1-60` (types only).

- [x] `server/src/world/event-log.ts`: `append(event)` assigns `seq`, keeps the last 1,000, and
  `since(lastSeq)` returns the events, or `null` if `lastSeq` is older than the buffer (which
  means a resync is needed).
- [x] `server/src/world/command-cache.ts`: LRU(1000) of `cmdId → ack`.
- [x] `server/src/adapters/history-sink.ts`: an appending JSONL writer (async queue with no awaits
  in the hot path), plus `server/src/adapters/servicenow-mock.ts` (logs `wm_order` payloads).
- [x] Tests: seq monotonic, `since` boundary cases (0, exact edge, evicted), LRU eviction order,
  and a sink row that has exactly the five Snowflake columns.

**Verify:** `npm test -w @assetpulse/server && npm run typecheck`
**Commit:** `feat(server): event log, command cache, history + ServiceNow adapters`

## Phase 2 — WebSocket server

### ☑ 2.1 · L · ~1.5h — ws server: hello, subscribe, commands + acks, worlds per hospital

**Budget:** files 4 · new 3 (+1 test) · trips ≈ 22
**Read:** `server/src/world/*.ts` (signatures via `grep -n "export"`), `packages/protocol/src/frames.ts`.

- [x] `server/src/hub/world-registry.ts`: get-or-create a World per `h`. Handles cap/evict/GC
  (Decisions) and owns one `setInterval` tick per world, which is stopped on GC.
- [x] `server/src/hub/connection.ts`: per-socket state `{worldId, topics:Set, lastSentSeq}`.
  - Parse with `parseClientFrame`; an invalid frame gets close 4400.
  - A `command` checks the LRU first (replaying the cached ack if hit), else runs it on the
    World, broadcasts the resulting events, and sends an `ack`.
  - A `WorldError` becomes `ack{ok:false, error: code}`.
- [x] Topic routing: `work_order` goes to `role:tech` + `role:ops`; `asset_changed` / `par_alert`
  go to `floor`.
- [x] `server/src/index.ts`: `http.createServer` + `new WebSocketServer({ server, path: "/ws" })`,
  listening on `process.env.PORT ?? 8787`, plus `GET /healthz` → `{ok, worlds, sockets}`.
- [x] `server/test/ws.integration.test.ts` (real sockets, port 0), covering:
  - hello snapshot
  - subscribe filtering (a tech gets `work_order`, not `positions`, unless it subscribed to
    `floor`)
  - an ack round-trip
  - a duplicate `cmdId` returns the same ack without re-applying
  - **race:** two techs `accept_wo` simultaneously, so exactly one `ok:true` and one
    `ALREADY_ASSIGNED`
  - two hospitals isolated

**Verify:** `npm test -w @assetpulse/server && npm run typecheck && npm run lint`
**Commit:** `feat(server): ws hub with topics, acks, idempotent commands`

### ☑ 2.2 · L · ~1.5h — Delivery quality: coalescing, backpressure, heartbeat, resume

**Budget:** files 3 · new 1 (+1 test) · trips ≈ 22
**Read:** `server/src/hub/connection.ts`, `server/src/hub/world-registry.ts` (whole).

- [x] Coalescing: the world accumulates the latest position per asset, and every 250 ms it sends
  one `positions` frame per `floor` subscriber.
- [x] Backpressure: skip that client's flush when `bufferedAmount > 512KB`, and count skips in
  `/healthz`. Events are always sent.
- [x] Heartbeat: `ws.ping()` every 15 s. If no `pong` arrived since the last ping, call
  `terminate()`. The server only reaps. The client measures its own RTT (3.1), so no
  server-side RTT field exists.
- [x] Resume: a `resume{lastSeq}` replays `eventLog.since(lastSeq)` filtered by topics, else
  sends `resync{snapshot, seq}`.
- [x] `server/test/delivery.integration.test.ts`, covering:
  - ≤ 5 `positions` frames per second per client
  - a slow client (pause the socket's underlying stream) gets skips but receives every event
  - resume after missing 20 events gets exactly those 20, in order
  - resume from an evicted seq gets a `resync`
  - a dead socket (no pong) is terminated (use fake timers)

**Verify:** `npm test -w @assetpulse/server && npm run lint`
**Commit:** `feat(server): coalescing, backpressure, heartbeat, resume`

### ☑ 2.3 · S · ~20m — Static serving + dev script

**Budget:** files 2 · new 0 (+0 test) · trips ≈ 6
**Read:** `server/src/index.ts`.

- [x] Serve `web/dist` at `/` and `mobile/dist` at `/tech` (use `sirv`; SPA fallback on both),
  but only if the dirs exist.
- [x] Root `dev` runs `server` (tsx watch) plus `web` (vite, proxying `/ws` to 8787).

**Verify:** `npm run build -w @assetpulse/server && node server/dist/index.js` then (second shell)
`curl -s localhost:8787/healthz` returns `{"ok":true`, then stop the server.
**Commit:** `feat(server): static hosting for web + tech builds`

## Phase 3 — Web ops console

### ☑ 3.1 · M · ~1h — `packages/client`: resilient socket shared by web + mobile

**Budget:** files 1 · new 3 (+1 test) · trips ≈ 14
**Read:** `packages/protocol/src/{frames,constants}.ts`.

- [x] `@assetpulse/client`, framework-free, using only the global `WebSocket` (it must run in
  the browser and in React Native).
- [x] `createClient({url, hospitalId, topics})` → `{ on(type, fn), send(command) →
  Promise<ack>, state$, stats, kill(ms) }`. It:
  - auto-reconnects with backoff + jitter (Decisions)
  - sends `resume{lastSeq}` on reconnect
  - rejects pending command promises on disconnect with `DISCONNECTED`
  - measures `stats.rttMs` itself via a `ping`-style command round trip
  - exposes `stats.framesIn` and `stats.lastFrameRaw[]` (last 200 raw strings for the wire
    drawer)
  - `kill(ms)` closes the socket and blocks reconnect for `ms`
- [x] Add `"ping"` to the command names in protocol (a protocol change first, with a test,
  per ⛔).
- [x] Tests with a fake WebSocket: the backoff sequence stays in bounds, a resume is sent with
  the right seq, pending acks are rejected on close, and kill blocks reconnect.

**Verify:** `npm test -w @assetpulse/client -w @assetpulse/protocol && npm run typecheck`
**Commit:** `feat(client): resilient ws client with resume + acks`

### ☑ 3.2 · L · ~1.5h — Floor map UI — [opus]

**Budget:** files 2 · new 4 (+0 test) · trips ≈ 20
**Read:** `packages/protocol/src/floor.ts`; `ux-decisions` skill index plus any file on alerts,
color, or dark mode.

- [x] `web/` Vite React-TS app (`@assetpulse/web`) with CSS Modules, tokens in `src/theme.css`,
  and light/dark via `prefers-color-scheme` plus a toggle.
- [x] `FloorMap.tsx`: SVG zones from `floor.ts`, asset dots colored by status (with a
  shape/letter too, so status isn't hue-only), and positions interpolated between 4 Hz frames
  with `requestAnimationFrame`.
- [x] `ParGauge` on `CLEAN-UTIL` (clean / min / max), an alert rail listing open work orders,
  and a connection pill (`live · 23 ms` from `stats.rttMs`, `reconnecting…`, `resyncing…`).
- [x] Calm palette. Only a PAR breach uses the alert color, with no infinite pulsing animations.

**Verify:** `npm run build -w @assetpulse/web && npm run typecheck && npm run lint`, then a manual
check with `npm run dev`: the map animates and the pill shows a measured RTT.
**Commit:** `feat(web): live floor map`

### ☐ 3.3 · M · ~1h — Interactions: drag, surge, wire drawer, kill network

**Budget:** files 3 · new 2 (+0 test) · trips ≈ 15
**Read:** `web/src/FloorMap.tsx`, `packages/client/src/index.ts` (exports).

- [ ] Drag an asset dot to a zone (pointer events) sends `move_asset`. Update optimistically. On
  `ack.ok=false`, snap back and show a toast with the error code in plain words.
- [ ] Toolbar: **Surge ICU**, **Reset**, and **Kill network 10 s**.
- [ ] `WireDrawer.tsx`: a collapsible list of `stats.lastFrameRaw` with direction, time, and
  type, plus a filter toggle to hide `positions`.
- [ ] A "missed while offline: N events replayed" toast after a resume.

**Verify:** `npm run build -w @assetpulse/web && npm run lint`, then manually: kill the network,
wait, and see the replay toast count > 0 with the map consistent. Drag to an illegal zone and
see the snap-back.
**Commit:** `feat(web): commands, wire drawer, network kill`

### ☐ 3.4 · S · ~20m — "Be the tech" QR panel + web fallback tech view

**Budget:** files 2 · new 1 (+0 test) · trips ≈ 6
**Read:** `web/src/App.tsx`.

- [ ] A `qrcode` package QR for `${origin}/tech?h=${hospitalId}`.
- [ ] Until Phase 4 lands, `/tech` is served by a minimal web route in `web/`
  (`TechFallback.tsx`: list open orders, Accept, Deliver). Phase 4 replaces it.

**Verify:** `npm run build -w @assetpulse/web`, then manually: open `/tech?h=…` in a second
window, and a breach there shows the order. Accept it, and the desktop shows it assigned.
**Commit:** `feat(web): QR hand-off + fallback tech view`

## Phase 4 — Tech handheld (React Native / Expo)

### ☐ 4.1 · L · ~1.5h — Expo app in the monorepo, web export builds

**Budget:** files 3 · new 4 (+0 test) · trips ≈ 20
**Read:** ⛔ "Expo + monorepo" trap; `packages/client/src/index.ts` (exports).

- [ ] `npx create-expo-app@latest mobile --template blank-typescript`, then add `mobile` to the
  root workspaces.
- [ ] `metro.config.js` per the ⛔ trap if resolution fails.
- [ ] `App.tsx` connects via `@assetpulse/client` with `topics: ["role:tech"]` and reads `h` from
  the URL on web (or the deep link on native).
- [ ] Add a `build:web` script: `expo export --platform web --output-dir dist`.

**Verify:** `npm run build:web -w mobile` produces `mobile/dist/index.html`, then `npm run
typecheck`. Manually, `npx expo start --web` shows "connected".
**Commit:** `feat(mobile): expo tech handheld scaffold`

### ☐ 4.2 · M · ~1h — Work-order inbox: alert, accept, deliver, lose-the-race

**Budget:** files 2 · new 2 (+0 test) · trips ≈ 14
**Read:** `mobile/App.tsx`.

- [ ] Show a card for each open order (number, quantity, location). A new order triggers
  `Vibration.vibrate()` (guarded, since iOS web is a no-op) plus a visual flash.
- [ ] **Accept** sends `accept_wo`, then shows **Delivered**, which sends `deliver_wo`.
  `ALREADY_ASSIGNED` shows "Taken by another tech" and removes the card.
- [ ] A connection banner shows while reconnecting.

**Verify:** `npm run build:web -w mobile && npm run typecheck`, then manually: two tech tabs
accept at once, and exactly one wins.
**Commit:** `feat(mobile): work-order inbox with ack handling`

### ☐ 4.3 · S · ~20m — Serve the Expo build at `/tech`, retire the fallback

**Budget:** files 3 · new 0 (+0 test) · trips ≈ 8
**Read:** `server/src/index.ts`, `web/src/App.tsx` (the route to the fallback).

- [ ] The root `build` builds protocol → client → server → web → mobile web.
- [ ] Delete `TechFallback.tsx` and its route (re-verify with
  `grep -rn TechFallback web/src` = 0 hits).

**Verify:** `npm run build && node server/dist/index.js`, then `/tech?h=test` renders the Expo
app, and `grep -rn TechFallback web/src` is empty.
**Commit:** `feat: serve RN tech app at /tech`

## Phase 5 — Ship

### ☐ 5.1 · M · ~45m — One Playwright e2e over the whole loop

**Budget:** files 1 · new 2 (+1 test) · trips ≈ 14
**Read:** none beyond the ⛔ section.

- [ ] `e2e/loop.spec.ts`: start the built server; the console page hits Surge, and the tech
  page (a second context) sees the order. Accept, then Deliver, and the console PAR shows
  `CLEARED`. Kill network, then a replay toast appears.
- [ ] Add it to CI as a separate job (`npx playwright install --with-deps chromium`).

**Verify:** `npx playwright test`
**Commit:** `test(e2e): full dispatch loop`

### ☐ 5.2 · M · ~1h — Azure App Service deploy — [INTERACTIVE ONLY]

**Budget:** files 1 · new 1 (+0 test) · trips ≈ 12
**Read:** ⛔ App Service traps.

- [ ] **With the user, in the Azure portal:** create a Linux Web App (Node 22 LTS, B1). In
  Configuration → General settings, set **Web sockets = On** and **Always On = On**. Set the
  startup command to `node server/dist/index.js`. Download the publish profile, then run
  `gh secret set AZURE_WEBAPP_PUBLISH_PROFILE < profile.PublishSettings` and delete the file.
- [ ] `.github/workflows/deploy.yml`: on push to `main` (and `workflow_dispatch`), build, then
  `azure/webapps-deploy@v3`.
- [ ] Trigger it once via `workflow_dispatch` on the plan branch.

**Verify:** `curl -s https://<app>.azurewebsites.net/healthz` returns `ok:true`, then
`npx wscat -c "wss://<app>.azurewebsites.net/ws?h=probe"` receives `hello`. Record the URL in
the Ledger.
**Commit:** `ci: azure app service deploy`

### ☐ 5.3 · M · ~1h — README, protocol doc, ADRs

**Budget:** files 1 · new 7 (+0 test) · trips ≈ 12
**Read:** `packages/protocol/src/frames.ts`, Ledger (for the live URL).

- [ ] `README.md`:
  - a 30-second pitch, the live URL, a QR image, and a GIF (recorded with the user)
  - an architecture diagram (Mermaid)
  - "what to try" (surge, phone, kill network, open DevTools → WS)
  - run locally
- [ ] `docs/protocol.md`: every frame, the topics, close codes, and the resume algorithm.
- [ ] `docs/adr/`, each ≤ 1 page: 0001 WebSockets vs SSE vs polling · 0002 raw `ws` vs SignalR
  / Azure Web PubSub · 0003 two streams (sequenced events vs droppable positions) · 0004 where
  APIM + Entra ID would sit (WebSocket passthrough API, JWT validation) · 0005 ServiceNow
  `wm_order` + Snowflake sink as adapters.

**Verify:** `npx markdown-link-check README.md docs/**/*.md` shows no dead links; the Mermaid
renders on GitHub (check after push).
**Commit:** `docs: readme, protocol, ADRs`

### ☐ 5.4 · S · ~30m — `docs/ai-assisted-dev.md`

**Budget:** files 1 · new 1 (+0 test) · trips ≈ 5
**Read:** Ledger (the whole thing — it is the source material).

- [ ] Write it honestly and briefly:
  - which parts Claude Code drafted
  - the guardrails: this plan's format, tests-as-gate, the complexity lint, "never fake a
    metric"
  - one case where the AI output was wrong and how the gate caught it (take it from the Ledger)
  - what you would coach a team to adopt
- [ ] No prompt dumps.

**Verify:** a read-through by the user (this doc speaks for them).
**Commit:** `docs: ai-assisted development notes`

### ☐ 5.5 · S · ~20m — Merge once, go public, tag

**Budget:** files 0 · new 0 (+0 test) · trips ≈ 8
**Read:** none.

- [ ] `git switch main && git merge --no-ff plan/assetpulse`, then push. Deploy runs from `main`.
- [ ] `gh repo edit --visibility public --accept-visibility-change-consequences`, then set the
  description, topics (`websocket rtls react-native azure healthcare`), and homepage = live URL.
- [ ] `git tag v1.0.0 && git push --tags`.

**Verify:** `gh repo view --json visibility,homepageUrl`, then open the live URL in a private
window plus a phone. The whole loop works.
**Commit:** the merge commit.

## Deferred (considered, deliberately not planned)

- **Real auth (Entra ID / JWT) and APIM in front.** APIM Developer tier costs money and adds
  nothing a reviewer can see. ADR 0004 covers it instead.
- **Real ServiceNow or Snowflake calls.** The payload shapes show the knowledge; live accounts
  add cost and secrets.
- **Horizontal scale (Redis pub/sub or Azure Web PubSub fan-out).** A single instance is honest
  for a demo. ADR 0002 names the scale-out path. Don't add a Redis dependency.
- **Native app store builds (EAS).** Expo Go plus the web export covers it; the reviewer
  installs nothing.
- **The Gemini page's "Visual Iterations" post-mortem section and "Copy Claude Prompt" button.**
  They were cut on purpose; see the review article.
- **Binary frames / MessagePack.** JSON keeps the wire drawer readable, which is the demo's point.

## Ledger

- 2026-09-27 — plan authored (Opus). Toolchain verified on dev machine (see Target environment).
  User confirmed 2026-09-27: Azure App Service B1 (~$13/mo), GitHub account
  `design-and-deliver`, full plan including Phase 4 (RN). Ready for 1.1.
- 2026-09-27 — 1.1 done, `fe65c82` on `main` [1 session · ~30 trips · peak ~95k · L holds].
  Deviations:
  - Tooling resolved to TS 6.0, ESLint 10, Vitest 5. Vitest 5 has no workspace file and errors
    on a `projects` list that matches nothing, so `vitest.config.ts` lists only workspaces that
    exist. No edit is needed when server/web appear.
  - `tsc -b` needs at least one reference, so `tsconfig.tools.json` (covers `vitest.config.ts`)
    is referenced. Later substeps ADD their tsconfig to the root `references`.
  - ESLint ignores `.claude/**` (local hooks).
  - `mobile` is also left out of `workspaces` until 4.1.
  - `CLAUDE.md` is gitignored (autoconfig boilerplate pointing at gitignored `.claude/`).
    Decide in 5.4 whether to commit a project CLAUDE.md.
  - The plan doc IS tracked, and it names local paths and the JD. **5.5 must scrub it or move it
    to `.claude/plans/` before going public.**
  BLOCKED (partial):
  - The `main` push was rejected because the gh token lacks the `workflow` scope (ci.yml).
    `plan/assetpulse` pushed, so GitHub's default branch is currently `plan/assetpulse`.
  - Recovery: the user runs `gh auth refresh -h github.com -s workflow`, then
    `git push -u origin main && gh repo edit --default-branch main`.
- 2026-09-27 — 1.2 done, `2f4634e` [same session as 1.1 · ~14 trips · M holds]. 27 tests green.
  - zod resolved to 4.6. Packages run by Node use `module/moduleResolution: NodeNext` (imports
    carry `.js`), overriding the base's `bundler`.
  - Protocol `exports` has a `source` condition → `src/index.ts`, and `default` → `dist`.
    **Later:** server (tsx), web (vite), and vitest configs should set `resolve.conditions:
    ['source']` (or build protocol first). Otherwise they import a stale or missing `dist`.
  - Each new workspace needs a `"test": "vitest run"` script plus its tsconfig added to the root
    `references` (the plan's `npm test -w` Verify commands rely on it).
  - Command args are validated per-command in `parseClientFrame` (`args:` error prefix), and
    `ClientFrame` is typed as a discriminated union on `name`.
  - Error codes live in `ERROR_CODES` (`frames.ts`). 1.3's `WorldError` codes must use that list.
  - Test files are not in any tsconfig, so tsc doesn't typecheck them (vitest runs them). Revisit
    if type drift in tests bites.
  - Still open from 1.1: `main` isn't pushed (gh `workflow` scope).
- 2026-09-27 — 1.1 BLOCKED resolved: gh token now has `workflow`. `main` pushed (`fe65c82`), GitHub default branch set to `main`, repo still PRIVATE. Next: 1.3.
- 2026-09-27 — 1.3 done, `3f5dd10` [1 session · ~12 trips · M holds]. 13 server tests green (40 total).
  - **`seq` is NOT held by the World** (deviation from the 1.3 bullet). Methods return
    `WorldEvent` = a `SequencedEvent` minus `v`/`ts`/`seq`; 1.5's event log stamps `seq` on
    append, so there is exactly one counter. `woCounter` stays in the World.
  - `moveAsset(id, zone)` is the single lifecycle step: legal iff the zone's kind matches the
    NEXT status's home. So REPROCESSING→READY is `moveAsset(id, 'SPD')` and SOILED→REPROCESSING
    is also `moveAsset(id, 'SPD')` — 1.4's timers use those. READY has no move (deliver only).
  - Only `evaluatePar()` opens orders (BREACH + `work_order`); moves/surge never do. 1.4's tick
    must call it after its own events. `deliverOrder` emits CLEARED itself.
  - Closed orders leave the map → a closed number is `NOT_FOUND`. `reset()` closes active
    orders but keeps `woCounter` running (numbers never reused). `World({ now })` injects the clock.
  - Server workspace: `server/vitest.config.ts` sets `resolve.conditions` + `ssr.resolve.conditions`
    to `['source']` — verified: tests pass with protocol `dist/` removed. Web (3.x) needs the same.
    `tsconfig.tools.json` now also covers `server/vitest.config.ts`.
- 2026-09-27 — 1.4 done, `dc068d3` [1 session · ~8 trips · M holds]. 11 simulator tests green (24 server).
  - `new Simulator(world, { seed, hasTech })`; `tick(dtMs)` → `{ events, positions }`. It reads
    the World only via `snapshot()` (before and after each tick), so changes made by commands
    between ticks start their timers/tweens from the tick that sees them. 2.1 needs no hooks.
  - Tick order: timers → room event → bot → `evaluatePar()`. Bot delivers on a LATER tick than
    it accepts (deliveries run before accepts), and only orders it accepted (`BOT_TECH_ID`).
  - Bot wait clock counts only no-tech time: any tick with `hasTech()` true restarts it.
  - `positions` lists all 14 assets every tick, rounded to 0.1. 2.2's coalescer keeps the latest
    per asset. Positions share the one RNG with events (still deterministic per seed).
- 2026-09-27 — 1.5 done, `922bef7` [1 session · ~7 trips · M holds]. 12 new tests green (36 server).
  - `new EventLog({ capacity?, now? })`: `append(WorldEvent)` stamps `v`/`ts`/`seq` and returns
    the wire-ready `SequencedEvent`; `log.seq` is the hello/resync seq. `since(n)` → `[]` at the
    head, `null` if `n` was evicted OR `n > log.seq` (client ahead after a restart → resync).
  - `CommandCache` stores the full `Ack` frame (`Extract<ServerFrame,{type:'ack'}>`); `get`
    refreshes recency.
  - `HistorySink(dir?)`: `record(hospitalId, event)` is sync; `await sink.flush()` on shutdown.
    Default dir `server/data/history` resolved from `import.meta.url`. File date = UTC of `EVENT_TS`.
    `PAYLOAD` excludes `v`, `ts`, `seq`, `type`.
  - `ServiceNowMock.submit(hospitalId, order)`: POST when `open`, PATCH `?number=` otherwise;
    `opened_at` in glide format, plus `u_hospital_id`. 2.1 wires both adapters to `work_order`.
- 2026-09-27 — 2.1 done, `ad25282` [1 session · ~10 trips · L holds]. 11 new tests green (47 server).
  - Files: `hub/world-registry.ts` (`WorldHub` + `WorldRegistry`), `hub/connection.ts`, `app.ts`
    (`startApp({port?, sink?, serviceNow?, now?, maxWorlds?, idleMs?, tickMs?, sweepMs?,
    seedFor?})` → `{port, registry, sink, close()}`), `index.ts` (entry; SIGINT/SIGTERM →
    `app.close()`, which flushes the history sink).
  - `WorldHub.publish` is the single path for every event: log → sink → ServiceNow (work_order)
    → topic fan-out. Positions go out **every sim tick** to `floor` via `sendPositions` — 2.2
    replaces that with the 250 ms coalesced flush + backpressure.
  - Topics start EMPTY; `subscribe` REPLACES the set. Only `hello` is sent before subscribing.
  - `resume` is parsed and ignored (a stub case in `Connection.handle`) — 2.2 implements it.
    `Connection.lastSentSeq` is already tracked in `send`.
  - The command cache is per WORLD, so cmdIds must be world-unique (3.1: `crypto.randomUUID()`).
    The race test first failed on per-client cmdId counters colliding.
  - Bad `h` → close 4400; world cap with none idle → 4503. Seeds = FNV-1a of the hospital id.
- 2026-09-27 — 2.2 done, `d8ac8c0` [1 session · ~12 trips · L holds]. 6 new tests green (53 server).
  - Coalescing: `tick()` fills `pendingPositions` (Map by assetId); `flushPositions()` runs on
    its own `flushMs` timer (default `POSITION_FLUSH_MS`) and sends one shared frame per
    `floor` subscriber. Events still go straight through `publish` — never via the flush.
  - Backpressure: `Subscriber` gained `bufferedAmount` (Connection proxies `ws.bufferedAmount`).
    Skips count in `registry.stats.positionSkips` (server-wide, survives world eviction) →
    `/healthz` now returns `{ok, worlds, sockets, positionSkips}`.
  - Heartbeat: `hub/heartbeat.ts` `startHeartbeat(() => wss.clients, heartbeatMs?)` — WeakSet
    of sockets awaiting a pong; still awaiting at the next beat → `terminate()`. Timer unref'd;
    `app.close()` stops it. `AppOptions.heartbeatMs` added.
  - Resume: `WorldHub.replay(lastSeq, topics)` → missed events filtered by `EVENT_TOPICS`, or a
    single `resync{seq, snapshot}` when `log.since` returns null. Sent synchronously in
    `Connection.handle`, so live events cannot interleave. Topics apply AT resume time — 3.1's
    client must `subscribe` before `resume`.
  - New options: `RegistryOptions.flushMs`, `.eventLogSize` (tests use 5 to force eviction).
  - Deviation: the slow-client test attaches a fake `Subscriber` with a high `bufferedAmount`
    to the real app's hub instead of pausing a real socket stream — a paused stream only shows
    `bufferedAmount` after MBs of kernel buffer fill, which made it slow and nondeterministic.
  - `TestClient` / `delay` / `Frame` moved to `server/test/support/test-client.ts`, shared by
    both integration files. Tests needing an exact event count pass `tickMs: 3_600_000`
    (frozen sim); surge + reset each emit exactly 4 `asset_changed`.
- 2026-09-27 — 2.3 done, `ebcc1b6` [1 session · ~8 trips · S holds]. 53 server tests green.
  - Static hosting lives in `app.ts` (not `index.ts`, which only boots): `sirv` with
    `single: true` per dir, each built only if the dir exists at startup. Default dirs resolve
    `../../web/dist` and `../../mobile/dist` from `import.meta.url` (same hop from `src` and
    `dist`); `AppOptions.webDir` / `.techDir` override them. `/tech`, `/tech/…`, `/tech?…` strip
    the prefix; `/technology` falls through to web. Missing dir → 404, `/healthz` unaffected.
  - Server `dev` = `tsx watch src/index.ts` (`tsx` added as a devDep). Root `dev` already ran
    server + web via `concurrently` since 1.1 — but the `web` workspace doesn't exist yet, so
    root `dev` fails on the web half until 3.x creates it. The vite `/ws` → 8787 proxy goes in
    `web/vite.config.ts` when that workspace is created (3.2 or earlier).
  - Verify deviation: a backgrounded `node server/dist/index.js` + `kill` was denied (as in
    2.2). Ran a self-terminating script instead against `server/dist/app.js` on :8787:
    `/healthz` → `{"ok":true,…}`, and with temp dirs every SPA route above returned the
    right index.
- 2026-09-27 — 3.1 done, `c6086d8` [1 session · ~12 trips · M holds]. 94 tests green (13 client).
  - Protocol: `ping` added to `COMMAND_NAMES` (args `{}`) + round-trip test; `CLIENT_PING_MS`
    (5 s) and `WIRE_LOG_SIZE` (200) added to constants. Server `apply` returns `[]` for ping, and
    `WorldHub.execute` bypasses the command LRU for pings so they never evict real cmdIds.
  - `@assetpulse/client` (`packages/client/src/client.ts`): `createClient({url, hospitalId,
    topics, WebSocket?, random?, now?, pingMs?})` appends `?h=`. Needs only a `WebSocketLike`
    (browser / RN / Node 22 global); tsconfig adds `lib: DOM` for timers.
  - API deviations from the substep text: `stats.lastFrameRaw` is `{dir, ts, raw}[]` (3.3's wire
    drawer needs direction + time); `state$` is a tiny `{value, subscribe}` observable with states
    `connecting|open|reconnecting|killed|closed`; `send` resolves with the ack (check `ok`) and
    rejects `ClientError('DISCONNECTED')` if not open or on drop; `close()` added; stats also
    carry `framesOut`, `reconnects`, `lastSeq`.
  - Seq rules: `hello` sets `lastSeq` only on first connect (a reconnect hello must not skip the
    replay); `resync` sets it unconditionally (may go backwards when the world was replaced);
    sequenced events with `seq <= lastSeq` are dropped, not emitted. On open: `subscribe`, then
    `resume{lastSeq}` if any, then a ping.
  - Gotcha: client tests import `@assetpulse/protocol` via its `dist` — run
    `npm run build -w @assetpulse/protocol` after a protocol change or new constants read as
    `undefined`. Fake timers need integer delays, so the jitter-bound test uses r=0.996, not 0.999.
- 2026-09-27 — 3.2 done, `802bc09` [1 session · ~20 trips · L holds]. 94 tests green; web build,
  typecheck, lint clean.
  - `web/` = `@assetpulse/web` (React 19.3, Vite 8, `@vitejs/plugin-react` 6). `vite.config.ts`
    proxies `/ws` → `ws://localhost:8787`; root `dev` now runs both halves. `web/tsconfig.json`
    is a `tsc -b` reference (emitDeclarationOnly into `node_modules/.cache/tsc`);
    `web/vite.config.ts` is typechecked via `tsconfig.tools.json`.
  - One client per page, created in `main.tsx` outside React (StrictMode can't double-open).
    `store.ts` folds frames into an immutable snapshot for `useSyncExternalStore`; positions go
    to `PositionTracker` (tween from drawn point to reported point over `POSITION_FLUSH_MS`), and
    `FloorMap` writes `transform` on each dot `<g>` in a rAF loop, so motion never re-renders.
  - `par_alert` fires only on BREACH/CLEARED, so its `clean` goes stale: the gauge counts CLEAN
    assets live (same rule as the server's `cleanCount`); the breach color follows `par.state`.
  - Pill: `live · N ms` from `stats.rttMs` (read on each ack), `reconnecting…`, `offline` for
    `killed`, and `resyncing…` from a reconnect's `open` until the first ack. The replay is
    written before the ping, so that ack marks the end of it.
  - Status = hue + letter (C/U/S/P/R) + legend. Breach = `--alert` stroke/fill on CLEAN-UTIL with a
    2-iteration pulse; reduced-motion kills it. Theme: OS default, toggle persisted (try/catch).
  - Verify deviation: ran the built server (`node server/dist/index.js`, serving `web/dist`)
    instead of `npm run dev`, checked in Chrome: `?h=` minted, `live · 4 ms`, 14 dots, events
    changed status within 12 s, dark mode OK, no console errors. Gotcha: the automation tab is
    `visibilityState: hidden`, so rAF is paused there and JS-sampled transforms don't move;
    screenshots (which paint) showed the dots moving.
  - Not seen live: a PAR breach (the sim never dropped below min in the window). 3.3's Surge
    button makes it easy to trigger and eyeball.
