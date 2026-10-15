# PROVIDER-018 — LOKET

**Local issue ID:** PROVIDER-018. **Recorded:** 2026-10-15.

## Summary / user outcome

Give LOKET event links (`www.loket.com/event/{slug}`) dedicated, tested support. LOKET is an Indonesian ticketer. A sampled event page publishes a schema.org Event that the generic parser reads (**existing generic support**). Its dates use a **non-ISO format** with a timezone name. Continuous multi-day events need their full range preserved; separate performances require a date choice.

**Related:** [#151](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/issues/151) (generic-parser regression fixtures).
**Priority:** P2. Post-v1 / nice to have. **Required for v1:** No. **Status:** local draft, not published (no GitHub issue number; the duplicate search ran 2026-10-14, but the final live check was unavailable). **Owner role:** Product and frontend.

## Geographic coverage (evidence 2026-10-14)
<!-- geo-coverage:2026-10-14 -->

**LOKET: international, non-US. Verified: Indonesia.**

- Official listing (2026-10-14): [Jakarta Game On (JAGO) 2026](https://www.loket.com/event/jakarta-game-on-jago-2026-wld), Oct 16–18, The Brickhall Jakarta. Organiser page: [event management](https://www.loket.com/event-management).
- Other countries are **unknown**. US: not evidenced.

Priority is unchanged: **P2**, post-v1 / nice to have; **Required for v1:** No.

## Shared context

See the [baseline and verification rules](../shared-context.md). Coverage evidence dates to 2026-10-14; the sampled development requests below date to 2026-10-15. Neither establishes production behavior.

## Probe notes (2026-10-15)

| Item | Result |
| --- | --- |
| Event page | 200, parsed as `schema_org`: "JAKARTA GAME ON [JAGO] 2026", `startDate` "2026-10-16 10:00:00 Asia/Jakarta", `endDate` "2026-10-18 21:00:00 Asia/Jakarta", Place "The Brickhall at Fatmawati City Center", organizer, offers |
| Date format | `YYYY-MM-DD HH:MM:SS {IANA zone}` is not ISO 8601. `slice(0,10)` happens to work, but any real date parsing must handle it |
| Extra JSON-LD | An ItemList (related events) is present alongside the Event |

## Scope

- `loket.ts`: recognise `loket.com` and `www.loket.com` `/event/{slug}`. Organiser, listing and marketing pages (`/event-management`) are refused without a fetch.
- Parse the timezone-suffixed date format. Preserve the range for continuous multi-day events; ask which performance when distinct dated performances are listed.
- Ignore ItemList nodes for the event.

## Acceptance criteria

- [ ] Recognition tests: event slugs, `/event-management`, listings and lookalikes.
- [ ] A **valid event page** fixture produces a stub with the title, local date range, venue and city and `source: "LOKET"` (JAGO, The Brickhall, Jakarta), preserving the Oct 16–18 span. A separate fixture with distinct performances requires an explicit selection.
- [ ] A date-format fixture covers the `Asia/Jakarta` suffix.
- [ ] Saved **non-event, listing, blocked or error** fixtures give a specific outcome (refusal, `not_found`, or `access_restricted` with the manual-details fallback) instead of a stub.
- [ ] Added to the [#151](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/issues/151) regression suite.
- [ ] Offline in `npm test`.

## Validation plan / evidence required

Run `npm run lint`, `npm run typecheck`, `npm test` and `npm run build`. Offline tests use saved, sanitized fixtures and assert that no unexpected network request is made. Live checks happen only on Preview in live mode, with owner authorization. Before local completion, record the local implementation commit, fixture provenance and dates, and command results. A remote PR is not required by this local backlog. Creating this record does not claim implementation or passing tests.
