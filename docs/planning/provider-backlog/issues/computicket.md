# PROVIDER-012 — Computicket

**Status:** planned locally; not published to GitHub. **Recorded:** 2026-10-15.

## Summary / user outcome

Support Computicket event links (`computicket.com/event/{slug}/{uuid}`). Computicket sells tickets for concerts, theatre, sport and festivals in South Africa. A sampled event page has **no JSON-LD** and gives a title-only stub ("Maskandi Fest Cape Town at William Herbert Sports Ground") with no date.

**Priority:** P2. Post-v1 / nice to have. **Required for v1:** No. **Local issue ID:** PROVIDER-012. **Owner role:** Product and frontend. No exact duplicate was found in the captured 2026-10-14 inventory; current remote state has not been refreshed.

## Geographic coverage (verified 2026-10-14)
<!-- geo-coverage:2026-10-14 -->

**Computicket: international, non-US. Observed event inventory: South Africa.**

- Observed official listings: [The All Day Affair](https://computicket.com/event/the-all-day-affair/99d51bf0-ab7e-4d51-933e-f0a7121a0037) and [Maskandi Fest Cape Town](https://computicket.com/event/maskandi-fest-cape-town/2ab26e0b-37e0-4d17-8296-934bccd7e30f).
- Other countries are **unknown**. US: not evidenced.

Priority is unchanged: **P2**, post-v1 / nice to have; **Required for v1:** No.

## Shared context

See the [baseline and verification rules](../shared-context.md). Observations below retain their original 2026-10-14 date and are not a production test.

## Verified facts (2026-10-14)

Observations come from sampled development requests (curl with the app user agent, 2026-10-14), not from the production host; re-check before implementing.

| Item | Result |
| --- | --- |
| Event URL form | `computicket.com/event/{slug}/{uuid}` |
| Event page | Maskandi Fest: 200, ~132 KB, **no JSON-LD**. Title-only stub "Maskandi Fest Cape Town at William Herbert Sports Ground". No date |
| Venue | The venue appears in the title ("… at {venue}"). It must come from page data, not the slug, which can disagree. The data source is a **verification task** |

## Scope

- `computicket.ts`: recognise `computicket.com` `/event/{slug}/{uuid}`, canonicalised on the UUID. Home, category and search pages are refused without a fetch.
- Find a date and venue source (embedded data); otherwise use the manual-details fallback ([#144](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/issues/144)) with the title prefilled. Africa/Johannesburg local dates.
- Multi-performance events ask which date.

## Acceptance criteria

- [ ] Verified data source is recorded here before rules are merged.
- [ ] Recognition tests: UUID event paths (same UUID with different slugs), home, category and lookalikes.
- [ ] A **valid event page** fixture produces a stub with the title, local date, venue and city and `source: "Computicket"`, or the documented fallback without an invented date.
- [ ] Saved **non-event, listing, blocked or error** fixtures give a specific outcome (refusal, `not_found`, or `access_restricted` with the manual-details fallback) instead of a stub.
- [ ] Offline in `npm test`.

## Validation plan / evidence required

Run `npm run lint`, `npm run typecheck`, `npm test` and `npm run build`. Offline tests use saved, sanitized fixtures and assert that no unexpected network request is made. Live checks happen only on Preview in live mode, with owner authorization, and record their mode. Before local completion, record the local implementation commit, fixture provenance and dates, and command results. A remote PR is not required by this local backlog. Creating this record does not claim implementation or passing tests.
