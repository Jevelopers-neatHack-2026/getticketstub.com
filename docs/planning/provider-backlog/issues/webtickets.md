# PROVIDER-011 — Webtickets

**Status:** planned locally; not published to GitHub. **Recorded:** 2026-10-15.

## Summary / user outcome

Support Webtickets event links across its country domains (`webtickets.co.za`, `webtickets.com.na`, `webtickets.co.bw`, `webtickets.mw`). Webtickets sells tickets for concerts, theatre, sport and festivals in southern Africa. A sampled South African event page has **no JSON-LD** and gives a title-only stub with no date.

**Product scope:** vouchers, deals and non-event listings are refused. **Race entries** follow the same owner decision as RunSignup ([PROVIDER-013: RunSignup](runsignup.md)).

**Related:** [PROVIDER-013: RunSignup](runsignup.md) (race-entry scope decision).
**Priority:** P2. Post-v1 / nice to have. **Required for v1:** No. **Local issue ID:** PROVIDER-011. **Owner role:** Product and frontend. No exact duplicate was found in the captured 2026-10-14 inventory; current remote state has not been refreshed.

## Geographic coverage (verified 2026-10-14)
<!-- geo-coverage:2026-10-14 -->

**Webtickets: international, non-US. Official country catalogues: South Africa, Namibia, Botswana, Malawi.**

- Official catalogues: [webtickets.co.za](https://webtickets.co.za/v2/category.aspx?itemid=0&location=0&when=anytime) (read directly; 200), [webtickets.com.na](https://www.webtickets.com.na/), [webtickets.co.bw](https://www.webtickets.co.bw/) and [webtickets.mw](https://www.webtickets.mw/) (research-agent-verified 2026-10-14).
- Each country's event inventory beyond its catalogue is **to sample**. US: not evidenced.

Priority is unchanged: **P2**, post-v1 / nice to have; **Required for v1:** No.

## Shared context

See the [baseline and verification rules](../shared-context.md). Observations below retain their original 2026-10-14 date and are not a production test.

## Verified facts (2026-10-14)

Observations come from sampled development requests (curl with the app user agent, 2026-10-14), not from the production host; re-check before implementing.

| Item | Result |
| --- | --- |
| Event URL form (ZA) | `webtickets.co.za/v2/event.aspx?itemid={id}` → 1 redirect → `www.webtickets.co.za/…` |
| Event page | `itemid=1593370369`: 200, **no JSON-LD**. Title-only stub "+LIVE+ at SunBet Arena". No date |
| Catalogue | `/v2/category.aspx…` → "Webtickets Online": a **false stub** today |
| Other TLDs | Event URL forms on `.com.na`, `.co.bw` and `.mw`: **unverified** |

## Scope

- `webtickets.ts`: treat the four country domains as candidate hosts. Enable a host/path rule only after an actual attendee event URL and redirects on that host are verified. The sampled South African `event.aspx?itemid=` form does not establish forms on the other country domains. Canonicalise verified events on both domain and id. Category, voucher and deal pages are refused without a fetch.
- Use a date and venue source (embedded data); otherwise use the manual-details fallback ([#144](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/issues/144)). Local dates per country (Africa/Johannesburg, Windhoek, Gaborone, Blantyre).
- Race entries follow [PROVIDER-013: RunSignup](runsignup.md)'s decision.

## Acceptance criteria

- [ ] Verified URL forms per domain are recorded here before rules are merged.
- [ ] Recognition tests for each domain, `itemid` canonicalisation, category, voucher and deal pages, and lookalikes.
- [ ] A **valid event page** fixture produces a stub with the title, local date, venue and city and `source: "Webtickets"`, or the documented fallback without an invented date.
- [ ] Saved **non-event, listing, blocked or error** fixtures give a specific outcome (refusal, `not_found`, or `access_restricted` with the manual-details fallback) instead of a stub (catalogue page).
- [ ] Offline in `npm test`.

## Validation plan / evidence required

Run `npm run lint`, `npm run typecheck`, `npm test` and `npm run build`. Offline tests use saved, sanitized fixtures and assert that no unexpected network request is made. Live checks happen only on Preview in live mode, with owner authorization, and record their mode. Before local completion, record the local implementation commit, fixture provenance and dates, and command results. A remote PR is not required by this local backlog. Creating this record does not claim implementation or passing tests.
