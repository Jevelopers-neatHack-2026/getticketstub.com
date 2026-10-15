# PROVIDER-006 — Eventfinda

**Status:** planned locally; not published to GitHub. **Recorded:** 2026-10-15.

## Summary / user outcome

Support Eventfinda event links (`eventfinda.co.nz`, `eventfinda.com.au`). Eventfinda is a large NZ and Australian event listing and ticketing site. It is partly **first-party ticketing** and partly an **aggregator** that links out to other ticketers. On sampled development requests, both domains returned an AWS WAF challenge (HTTP **202** with an empty page), which the app's `res.ok` check treats as success.

**Related:** [#144](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/issues/144) (bot-block detection and manual-details fallback); [#164](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/issues/164) (Etix, the same AWS WAF 202 pattern).
**Priority:** P2. Post-v1 / nice to have. **Required for v1:** No. **Local issue ID:** PROVIDER-006. **Owner role:** Product and frontend. No exact duplicate was found in the captured 2026-10-14 inventory; current remote state has not been refreshed.

## Geographic coverage (verified 2026-10-14)
<!-- geo-coverage:2026-10-14 -->

**Eventfinda: international, non-US. Verified: New Zealand and Australia.**

- Official listings: [Maungawhau Market, Auckland](https://www.eventfinda.co.nz/2026/maungawhau-market/auckland.amp) and [Melbourne EV Show, Ascot Vale](https://www.eventfinda.com.au/2026/melbourne-ev-show/melbourne/ascot-vale) (research-agent-verified 2026-10-14).
- Other countries are **unknown**. US: not evidenced.

Priority is unchanged: **P2**, post-v1 / nice to have; **Required for v1:** No.

## Shared context

See the [baseline and verification rules](../shared-context.md). Observations below retain their original 2026-10-14 date and are not a production test.

## Verified facts (2026-10-14)

Observations come from sampled development requests (curl with the app user agent, 2026-10-14), not from the production host; re-check before implementing.

| Item | Result |
| --- | --- |
| Event URL form | `www.eventfinda.{co.nz,com.au}/{year}/{slug}/{city}[/{suburb}]`, with `.amp` variants |
| Sampled response | Both URLs: **202 with `x-amzn-waf-action: challenge`**, ~2 KB, no title. `fetchPage` treats 2xx as OK, so the parser sees an empty page; the exact customer-visible outcome is a **verification task** (likely a generic or empty result) |
| First-party vs outbound | Whether an event is ticketed by Eventfinda or links to another ticketer is **unverified** per event. An outbound ticketer link does **not** imply a new integration; it can be handed to that provider's issue if one exists |

## Scope

- Eventfinda entry in the [#144](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/issues/144) registry: recognise both domains with `/{year}/{slug}/…` paths (canonicalise `.amp`). Listing, category and location pages are refused without a fetch.
- Treat a 202 WAF challenge as `access_restricted`, never as a parsed page. Show an Eventfinda-specific message plus the fallback, prefilled from the slug, year and city.
- **Verification tasks:** readability from the production host, structured data if readable, and how to detect outbound-ticketer events.

## Acceptance criteria

- [ ] Recognition tests: both domains, `.amp`, suburb variants, listings and lookalikes.
- [ ] A saved 202 challenge fixture is `access_restricted` with the prefilled fallback, and never a parsed empty page.
- [ ] A **valid event page** fixture produces a stub with the title, local date, venue and city and `source: "Eventfinda"`, if a readable page is obtained.
- [ ] Saved **non-event, listing, blocked or error** fixtures give a specific outcome (refusal, `not_found`, or `access_restricted` with the manual-details fallback) instead of a stub.
- [ ] Offline in `npm test`.

## Validation plan / evidence required

Run `npm run lint`, `npm run typecheck`, `npm test` and `npm run build`. Offline tests use saved, sanitized fixtures and assert that no unexpected network request is made. Live checks happen only on Preview in live mode, with owner authorization, and record their mode. Before local completion, record the local implementation commit, fixture provenance and dates, and command results. A remote PR is not required by this local backlog. Creating this record does not claim implementation or passing tests.
