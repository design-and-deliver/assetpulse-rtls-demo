# AI-assisted development

I built AssetPulse with Claude Code as the main pair: it drafted most of the code, and I made
the decisions, checked the results, and signed off on the work. This page covers who did what,
the guardrails that made that safe, one case where the AI got it wrong, and what I would ask a
team to adopt.

## Who did what

**Claude Code drafted** nearly all of the code and prose:

- the protocol package, the server, the shared client, the web console, the Expo handheld
- the tests and the Playwright end-to-end spec
- the CI and deploy workflows
- these docs and the ADRs

It also did most of the verification: running the gates, driving Chrome against the built server,
and recording the README GIF.

**I owned the calls that needed judgment or accountability:**

- the plan's scope and its locked decisions, such as raw `ws` over SignalR and App Service B1
- the mid-project re-plan. The finished console read as too busy for its one job, so I cut it
  back to the original four-panel layout.
- approving every unplanned change before it landed
- the Azure portal steps. Some portal buttons don't respond to browser automation, so I clicked
  those myself.
- the final read of every user-facing page, including this one

## Guardrails

**A written plan, one substep per session.** Before any code, the plan split the work into 23
substeps. Each one listed its budget (files and time), the few things to read first, a
checklist, exact **Verify** commands, and a commit subject. A standing traps section held the
rules that are easy to break silently, such as "positions are never sequenced". Each session
ran one substep from a fresh context. It ended by appending a Ledger entry: the commit, any
deviations from the plan, and the gotchas found. The next session read the Ledger instead of
the chat. That kept context small, and it turned every surprise into a written, reviewable note
instead of something lost in scrollback.

**Tests are the gate, not the AI's report.** A substep is done only when its Verify commands pass:
typecheck, lint, 96 unit tests, the end-to-end spec, and a manual run in Chrome for anything
visual. An AI saying something works is not evidence that it does. A green command is.

**A complexity limit the AI can't argue with.** ESLint's `complexity` rule is an error at
a score of 10. Generated code tends to grow one large function full of defensive fallbacks. The
lint forces small helpers while the code is still being written, instead of in a cleanup pass that never
comes.

**Never fake a frame, a latency figure, or a metric.** This project started from an AI-generated
prototype that looked right but simulated the socket, with random latency numbers and
hand-written log lines. Here, every number on screen is measured:

- RTT comes from real `ping`/`ack` round trips.
- Frame counts come from actual `onmessage` calls.
- The wire drawer shows the raw `event.data`.

The rule is written into the plan's traps, so every session saw it before touching the UI.

## When the AI was wrong

The first console let you drag pumps around a floor map, and a hint told you to "drag within
Sterile Processing to mark it ready." The AI wrote both the hint and the drag handler, and the
handler ignored every drop into the zone the pump was already in. So the hint described an action
that could never work. Each piece looked fine when read by itself, and the web app had no unit
tests yet, so nothing failed.

The end-to-end spec caught it. The spec did what the hint said, and the pump never moved. The
fix (a small `dropTarget()` function with the first web unit test) went in as a separate commit,
which I approved. The lesson: the AI writes copy and code with equal confidence, and only a test
that uses the product as a person would checks that the two agree.

One gate failure was mine to own. CI had been red since the third substep, and nobody looked,
because every local run was green. A clean build ran the tooling project first, and that broke
module resolution for every later project. Warm local build caches skipped that step, so the bug
never showed locally. A gate that nobody watches doesn't gate anything.

## What I would coach a team to adopt

1. **Plan in small, checkable substeps, and keep a Ledger.** Writing down deviations is
   cheap. It's what lets a fresh session, or a teammate, continue without re-reading the
   whole chat.
2. **Make "done" a command, not a claim.** Every task names its Verify commands before work starts.
3. **Encode taste as lint.** Complexity limits and similar rules steer the AI while it writes
   code, not after.
4. **Put the non-negotiables in writing, next to the work.** Rules like "never fake a metric" and
   "the protocol package changes first" only hold when every session sees them.
5. **Keep a human on judgment and sign-off.** The AI drafts quickly. A person still owns scope,
   trade-offs, and the final call on anything a user will see.
6. **Watch CI from day one.** A red check left alone is worse than having no check.
