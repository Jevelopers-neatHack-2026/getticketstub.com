# PROVIDER-019 — SM Tickets

**Local issue ID:** PROVIDER-019. **Recorded:** 2026-10-15.

## Summary / user outcome

Support SM Tickets event links (`www.smtickets.com/events/view/{id}`). SM Tickets is a major Philippine ticketer. In an earlier check (2026-10-14) the event page was queue-gated. On the sampled request (2026-10-15) the event link **redirected to the home page**, which today becomes a false "SM Tickets" stub. Runtime parsing of event pages is **unverified**.

**Access rule:** public event metadata only. Never bypass or automate a queue or waiting room.

**Related:** [#144](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/issues/144) (bot-block detection and manual-details fallback), based on the queue gate and redirect.
**Priority:** P2. Post-v1 / nice to have. **Required for v1:** No. **Status:** local draft, not published (no GitHub issue number; the duplicate search ran 2026-10-14, but the final live check was unavailable). **Owner role:** Product and frontend.

## Geographic coverage (evidence 2026-10-14)
<!-- geo-coverage:2026-10-14 -->

**SM Tickets: international, non-US. Verified: Philippines.**

- Official listing (2026-10-14): [event 15166](https://www.smtickets.com/events/view/15166) (queue-gated then; its Philippine location was seen via the search index).
- Other countries are **unknown**. US: not evidenced.

Priority is unchanged: **P2**, post-v1 / nice to have; **Required for v1:** No.

## Shared context

See the [baseline and verification rules](../shared-context.md). Coverage evidence dates to 2026-10-14; the sampled development requests below date to 2026-10-15. Neither establishes production behavior.

## Probe notes (2026-10-15)

| Item | Result |
| --- | --- |
| Event link | `/events/view/15166` → 1 redirect → `www.smtickets.com/` (200, "SM Tickets – Buy Event Tickets Online"). A **false stub** today |
| Cause | Unknown: an expired event, a queue, or a session redirect. **Verify** |

## Scope

- `smtickets.ts`: recognise `/events/view/{id}`. Home and listing pages are refused without a fetch.
- A redirect from an event link to the home page or a queue is `not_found` or `access_restricted` (never a stub), with the manual-details fallback ([#144](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/issues/144)). No queue automation.
- **Verification tasks:** a readable live event page from the production host, its structured data, and Asia/Manila dates.

## Acceptance criteria

- [ ] Recognition tests: event ids, home, listings and lookalikes.
- [ ] A saved redirect-to-home fixture never yields "SM Tickets".
- [ ] A **valid event page** fixture produces a stub with the title, local date, venue and city and `source: "SM Tickets"`, if a readable page is obtained.
- [ ] Saved **non-event, listing, blocked or error** fixtures give a specific outcome (refusal, `not_found`, or `access_restricted` with the manual-details fallback) instead of a stub.
- [ ] Offline in `npm test`.

## Validation plan / evidence required

Run `npm run lint`, `npm run typecheck`, `npm test` and `npm run build`. Offline tests use saved, sanitized fixtures and assert that no unexpected network request is made. Live checks happen only on Preview in live mode, with owner authorization. Before local completion, record the local implementation commit, fixture provenance and dates, and command results. A remote PR is not required by this local backlog. Creating this record does not claim implementation or passing tests.
