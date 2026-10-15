# PROVIDER-022 — Ticket360

**Local issue ID:** PROVIDER-022. **Recorded:** 2026-10-15.

## Summary / user outcome

Support Ticket360 event links (`www.ticket360.com.br`). Ticket360 is a Brazilian ticketer for shows and festivals. It is a **separate source** from Sympla ([#188](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/issues/188)): sharing a country is not a duplicate. The sampled home page becomes a false stub today; event-page parsing is **unverified**.

**Related:** [#188](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/issues/188) (Sympla, a different Brazilian provider; share only the Brazilian timezone handling).
**Priority:** P2. Post-v1 / nice to have. **Required for v1:** No. **Status:** local draft, not published (no GitHub issue number; the duplicate search ran 2026-10-14, but the final live check was unavailable). **Owner role:** Product and frontend.

## Geographic coverage (evidence 2026-10-14)
<!-- geo-coverage:2026-10-14 -->

**Ticket360: international, non-US. Verified: Brazil.**

- The official [home page](https://www.ticket360.com.br/) (2026-10-14) lists current events in São Paulo, Rio de Janeiro, Minas Gerais and Bahia.
- Other countries are **unknown**. US: not evidenced.

Priority is unchanged: **P2**, post-v1 / nice to have; **Required for v1:** No.

## Shared context

See the [baseline and verification rules](../shared-context.md). Coverage evidence dates to 2026-10-14; the sampled development requests below date to 2026-10-15. Neither establishes production behavior.

## Probe notes (2026-10-15)

| Item | Result |
| --- | --- |
| Home page | 200, ~560 KB, Organization and WebSite JSON-LD; title "Ticket360 — Ingressos…" → "Ticket360". A **false stub** today |
| Event URL form | **Unverified.** Implementation task |

## Scope

- **Verification task first:** event URL form and structured data.
- `ticket360.ts`: recognise verified event paths. Home and listing pages are refused without a fetch.
- Brazilian local dates by venue state (America/Sao_Paulo, America/Bahia).

## Acceptance criteria

- [ ] Verified URL forms are recorded here before rules are merged.
- [ ] Recognition tests: event paths, home, listings and lookalikes.
- [ ] A **valid event page** fixture produces a stub with the title, local date, venue and city and `source: "Ticket360"`.
- [ ] Saved **non-event, listing, blocked or error** fixtures give a specific outcome (refusal, `not_found`, or `access_restricted` with the manual-details fallback) instead of a stub (home page).
- [ ] Offline in `npm test`.

## Validation plan / evidence required

Run `npm run lint`, `npm run typecheck`, `npm test` and `npm run build`. Offline tests use saved, sanitized fixtures and assert that no unexpected network request is made. Live checks happen only on Preview in live mode, with owner authorization. Before local completion, record the local implementation commit, fixture provenance and dates, and command results. A remote PR is not required by this local backlog. Creating this record does not claim implementation or passing tests.
