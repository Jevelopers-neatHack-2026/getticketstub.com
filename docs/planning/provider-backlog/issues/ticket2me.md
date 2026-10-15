# PROVIDER-020 — Ticket2Me

**Local issue ID:** PROVIDER-020. **Recorded:** 2026-10-15.

## Summary / user outcome

Support Ticket2Me event links (`ticket2me.net/event/{id}`). Ticket2Me is a Philippine ticketer for concerts, shows and talks. On a sampled request, the event page was a ~5 KB **JavaScript shell** titled "Ticket2Me", which today becomes a false stub.

**Priority:** P2. Post-v1 / nice to have. **Required for v1:** No. **Status:** local draft, not published (no GitHub issue number; the duplicate search ran 2026-10-14, but the final live check was unavailable). **Owner role:** Product and frontend.

## Geographic coverage (evidence 2026-10-14)
<!-- geo-coverage:2026-10-14 -->

**Ticket2Me: international, non-US. Verified: Philippines.**

- Official listing (2026-10-14): [event 23079](https://ticket2me.net/event/23079), Aristo Sham at the Ayala Museum, Makati, Nov 21, 2026.
- Other countries are **unknown**. US: not evidenced.

Priority is unchanged: **P2**, post-v1 / nice to have; **Required for v1:** No.

## Shared context

See the [baseline and verification rules](../shared-context.md). Coverage evidence dates to 2026-10-14; the sampled development requests below date to 2026-10-15. Neither establishes production behavior.

## Probe notes (2026-10-15)

| Item | Result |
| --- | --- |
| Event page | `/event/23079`: 200, ~5 KB, no JSON-LD, title "Ticket2Me". A **false stub** today |
| Data source | A client API or rendered data source for the title, date and venue is **unverified** |

## Scope

- `ticket2me.ts`: recognise `ticket2me.net` `/event/{id}`. Other pages are refused without a fetch.
- **Verification task first:** a supported data source. Otherwise use a Ticket2Me-specific message with the manual-details fallback ([#144](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/issues/144)). The brand title is never a stub.
- Asia/Manila local dates.

## Acceptance criteria

- [ ] Recognition tests: event ids, other pages and lookalikes.
- [ ] A saved shell fixture never yields "Ticket2Me".
- [ ] A **valid event page** fixture produces a stub with the title, local date, venue and city and `source: "Ticket2Me"` (Ayala Museum, Makati, `2026-11-21`), or the documented fallback.
- [ ] Saved **non-event, listing, blocked or error** fixtures give a specific outcome (refusal, `not_found`, or `access_restricted` with the manual-details fallback) instead of a stub.
- [ ] Offline in `npm test`.

## Validation plan / evidence required

Run `npm run lint`, `npm run typecheck`, `npm test` and `npm run build`. Offline tests use saved, sanitized fixtures and assert that no unexpected network request is made. Live checks happen only on Preview in live mode, with owner authorization. Before local completion, record the local implementation commit, fixture provenance and dates, and command results. A remote PR is not required by this local backlog. Creating this record does not claim implementation or passing tests.
