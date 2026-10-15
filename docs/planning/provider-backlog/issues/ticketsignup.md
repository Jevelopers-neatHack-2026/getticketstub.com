# PROVIDER-002 — TicketSignup

**Status:** planned locally; not published to GitHub. **Recorded:** 2026-10-15.

## Summary / user outcome

Give TicketSignup event links (`www.ticketsignup.io/TicketEvent/{slug}`) dedicated, tested support. TicketSignup sells tickets for festivals and community events. A sampled event page publishes a schema.org Event that the generic parser reads (**existing generic support**). What's missing is **dedicated regression coverage**: city-only Place names, multi-day events and custom domains.

**Related:** [#151](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/issues/151) (generic-parser regression fixtures). [PROVIDER-013: RunSignup](runsignup.md) (RunSignup, a related company): share verified canonicalisation where sensible, but TicketSignup ticket events and RunSignup race URLs stay separate.
**Priority:** P2. Post-v1 / nice to have. **Required for v1:** No. **Local issue ID:** PROVIDER-002. **Owner role:** Product and frontend. No exact duplicate was found in the captured 2026-10-14 inventory; current remote state has not been refreshed.

## Geographic coverage (verified 2026-10-14)
<!-- geo-coverage:2026-10-14 -->

**TicketSignup: US verified. International inventory unknown.**

- Observed official listings: [Carolina BalloonFest](https://www.ticketsignup.io/TicketEvent/CarolinaBalloonFest) (Statesville, NC, Oct 16–18) and [Shinerfest 2026](https://www.ticketsignup.io/TicketEvent/Shinerfest2026) (Shiner, TX, Oct 24).
- Other countries are **unknown**.

Priority is unchanged: **P2**, post-v1 / nice to have; **Required for v1:** No.

## Shared context

See the [baseline and verification rules](../shared-context.md). Observations below retain their original 2026-10-14 date and are not a production test.

## Verified facts (2026-10-14)

Observations come from sampled development requests (curl with the app user agent, 2026-10-14), not from the production host; re-check before implementing.

| Item | Result |
| --- | --- |
| Event page | `/TicketEvent/CarolinaBalloonFest`: 200, parsed as `schema_org`: "2026 E.P.I.C. Studios Carolina BalloonFest", `startDate` `2026-10-16T00:00:00-04:00`, `endDate` `2026-10-18T23:59:59-04:00`, Place "Statesville" (city only, no venue) |
| Custom domains | Organisers may use custom domains. These are **not** promised without evidence; recognition is limited to `ticketsignup.io` until verified |

## Scope

- `ticketsignup.ts`: recognise `ticketsignup.io` and `www.ticketsignup.io` `/TicketEvent/{slug}`. Other pages are refused without a fetch.
- Map the local date with the offset. Show multi-day events as a range. A city-only Place is shown as the city, not as a venue.
- **Verification tasks:** custom-domain detection, and whether `startDate` midnight values mean "all day".

## Acceptance criteria

- [ ] Recognition tests: `/TicketEvent/` paths, other pages and lookalikes.
- [ ] The BalloonFest fixture preserves the title, the local `2026-10-16` through `2026-10-18` range, Statesville as the city and `source: "TicketSignup"`. A city-only Place leaves the venue unset; no venue is invented.
- [ ] Saved **non-event, listing, blocked or error** fixtures give a specific outcome (refusal, `not_found`, or `access_restricted` with the manual-details fallback) instead of a stub.
- [ ] Added to the [#151](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/issues/151) regression suite.
- [ ] Offline in `npm test`.

## Validation plan / evidence required

Run `npm run lint`, `npm run typecheck`, `npm test` and `npm run build`. Offline tests use saved, sanitized fixtures and assert that no unexpected network request is made. Live checks happen only on Preview in live mode, with owner authorization, and record their mode. Before local completion, record the local implementation commit, fixture provenance and dates, and command results. A remote PR is not required by this local backlog. Creating this record does not claim implementation or passing tests.
