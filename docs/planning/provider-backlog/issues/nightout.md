# PROVIDER-003 — NIGHTOUT

**Status:** planned locally; not published to GitHub. **Recorded:** 2026-10-15.

## Summary / user outcome

Give NIGHTOUT event links (`nightout.com/events/…`) dedicated, tested support. NIGHTOUT is a consumer ticket marketplace operated by Ticketsauce, with primary and possibly resale inventory. A sampled event page publishes a schema.org TheaterEvent that the generic parser reads (**existing generic support**). This issue covers the **buyer domain only**: no ticketsauce.com SaaS integration.

**Related:** [#151](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/issues/151) (generic-parser regression fixtures; NIGHTOUT resale inventory may overlap Vivid Seats there) and the resale issues [#183](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/issues/183)/#184: only the stub source differs, so no duplicate resale logic.
**Priority:** P2. Post-v1 / nice to have. **Required for v1:** No. **Local issue ID:** PROVIDER-003. **Owner role:** Product and frontend. No exact duplicate was found in the captured 2026-10-14 inventory; current remote state has not been refreshed.

## Geographic coverage (verified 2026-10-14)
<!-- geo-coverage:2026-10-14 -->

**NIGHTOUT: US plus international. Verified: United States and Canada (Toronto).**

- The official [nightout.com home page](https://nightout.com/) lists US and Toronto, Canada events (research-agent-verified 2026-10-14).
- [Privacy policy](https://nightout.com/privacy-policy): operated by Ticketsauce. That is context, not coverage evidence.
- Other countries are **unknown**.

Priority is unchanged: **P2**, post-v1 / nice to have; **Required for v1:** No.

## Shared context

See the [baseline and verification rules](../shared-context.md). Observations below retain their original 2026-10-14 date and are not a production test.

## Verified facts (2026-10-14)

Observations come from sampled development requests (curl with the app user agent, 2026-10-14), not from the production host; re-check before implementing.

| Item | Result |
| --- | --- |
| Event URL form | `nightout.com/events/v/{slug-with-venue-city-date}/tickets`, e.g. `/the-unauthorized-hallmark-ish-parody-musical-thalian-hall-wilmington-2026-12-03/tickets`. Other forms and redirects or canonicals (with and without `/tickets`) are **unverified** |
| Event page | 200, parsed as `schema_org` (Event + TheaterEvent): "The Unauthorized Hallmark(ish) Parody Musical", `startDate` `2026-12-03T19:30-05:00`, Place "Thalian Hall" (EventVenue), performer present |

## Scope

- `nightout.ts`: recognise `nightout.com` `/events/…` event paths, canonicalised to one URL (verify `/tickets` and other suffixes). Home, city and category pages are refused without a fetch.
- Map the local date with the offset, the venue and the city.
- No ticketsauce.com organiser or SaaS integration.

## Acceptance criteria

- [ ] Recognition and canonicalisation tests: event paths with and without `/tickets`, city pages and lookalikes.
- [ ] The valid event fixture preserves the title, local date `2026-12-03`, Thalian Hall as the venue and `source: "NIGHTOUT"`. Populate Wilmington only if verified page data provides the city; otherwise leave it unset rather than infer it from the URL slug.
- [ ] Saved **non-event, listing, blocked or error** fixtures give a specific outcome (refusal, `not_found`, or `access_restricted` with the manual-details fallback) instead of a stub.
- [ ] Added to the [#151](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/issues/151) regression suite.
- [ ] Offline in `npm test`.

## Validation plan / evidence required

Run `npm run lint`, `npm run typecheck`, `npm test` and `npm run build`. Offline tests use saved, sanitized fixtures and assert that no unexpected network request is made. Live checks happen only on Preview in live mode, with owner authorization, and record their mode. Before local completion, record the local implementation commit, fixture provenance and dates, and command results. A remote PR is not required by this local backlog. Creating this record does not claim implementation or passing tests.
