# PROVIDER-013 — RunSignup

**Status:** planned locally; not published to GitHub. **Recorded:** 2026-10-15.

## Summary / user outcome

**Conditional:** support RunSignup race links (`runsignup.com/Race/{state}/{city}/{slug}`) **only if** the owner decides that races and runs are TicketStub keepsakes. A sampled race page publishes a schema.org SportsEvent that the generic parser reads today (**existing generic support**), so race links already produce stubs.

**Owner/product decision required before implementation:** are race and running keepsakes in scope? Creating this issue does **not** decide that. If they are out of scope, the outcome is a clear "races aren't supported" refusal. Record the decision here. It also governs race entries on Webtickets ([PROVIDER-011: Webtickets](webtickets.md)).
**Data rule:** public event metadata only. No participant PII, registration or checkout flows, and no results scraping.

**Related:** [PROVIDER-002: TicketSignup](ticketsignup.md) (TicketSignup, a related company): share verified canonicalisation where sensible, with separate URL spaces. [#151](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/issues/151) (generic-parser regression fixtures).
**Priority:** P2. Post-v1 / nice to have. **Required for v1:** No. **Local issue ID:** PROVIDER-013. **Owner role:** Product and frontend. No exact duplicate was found in the captured 2026-10-14 inventory; current remote state has not been refreshed.

## Geographic coverage (verified 2026-10-14)
<!-- geo-coverage:2026-10-14 -->

**RunSignup: US verified. International inventory unknown.**

- Official [race search](https://runsignup.com/races) and the observed [Get Basted Turkey Trot](https://runsignup.com/Race/GA/Cumming/GetBastedTurkeyTrot) (Cumming, GA) (read directly; 200).
- Other countries are **unknown**.

Priority is unchanged: **P2**, post-v1 / nice to have; **Required for v1:** No.

## Shared context

See the [baseline and verification rules](../shared-context.md). Observations below retain their original 2026-10-14 date and are not a production test.

## Verified facts (2026-10-14)

Observations come from sampled development requests (curl with the app user agent, 2026-10-14), not from the production host; re-check before implementing.

| Item | Result |
| --- | --- |
| Race URL form | `runsignup.com/Race/{state}/{city}/{slug}`; sub-pages (results, register, donate) are non-event pages |
| Race page | 200, parsed as `schema_org` (SportsEvent): "Get Basted Turkey Trot 5K, 10K, 15K, Half", `startDate` `2026-11-22T08:00:00-05:00`, Place "Cumming" (city only), organizer present |
| Today | Race links already become stubs through the generic path, regardless of the scope decision |

## Scope

- **First:** the owner records the scope decision.
- **If in scope:** `runsignup.ts` recognises `/Race/{state}/{city}/{slug}` (and `/Race/{id}` forms if verified). Results, registration, donation and participant pages are refused without a fetch. Map the local date and the city; multi-distance races are one event.
- **If out of scope:** recognise race links and refuse them with a clear message (no stub).

## Acceptance criteria

- [ ] The scope decision is recorded here before any rule is merged.
- [ ] Recognition tests: race pages, results, registration and participant pages, and lookalikes.
- [ ] If in scope: the Turkey Trot fixture produces the title, local date `2026-11-22`, Cumming as the city and `source: "RunSignup"`; its city-only Place leaves the venue unset. If out of scope: the race fixture gives the refusal message.
- [ ] Saved **non-event, listing, blocked or error** fixtures give a specific outcome (refusal, `not_found`, or `access_restricted` with the manual-details fallback) instead of a stub (results and registration pages).
- [ ] No test or code path reads participant data or results.
- [ ] Offline in `npm test`.

## Validation plan / evidence required

Run `npm run lint`, `npm run typecheck`, `npm test` and `npm run build`. Offline tests use saved, sanitized fixtures and assert that no unexpected network request is made. Live checks happen only on Preview in live mode, with owner authorization, and record their mode. Before local completion, record the local implementation commit, fixture provenance and dates, and command results. A remote PR is not required by this local backlog. Creating this record does not claim implementation or passing tests.
