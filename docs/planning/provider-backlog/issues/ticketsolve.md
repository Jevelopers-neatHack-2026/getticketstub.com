# PROVIDER-004 — Ticketsolve

**Status:** planned locally; not published to GitHub. **Recorded:** 2026-10-15.

## Summary / user outcome

Support Ticketsolve venue box-office links (`{venue}.ticketsolve.com/shows/{show}/events/{event}`). Ticketsolve powers ticketing for theatres and arts venues in the UK and Ireland. Its links should produce a correct stub for the chosen performance. Parser behaviour on attendee pages is **unverified** (no venue subdomain was sampled this round).

**Priority:** P2. Post-v1 / nice to have. **Required for v1:** No. **Local issue ID:** PROVIDER-004. **Owner role:** Product and frontend. No exact duplicate was found in the captured 2026-10-14 inventory; current remote state has not been refreshed.

## Geographic coverage (verified 2026-10-14)
<!-- geo-coverage:2026-10-14 -->

**Ticketsolve: international, non-US. Verified operator footprint: United Kingdom and Ireland. Venue inventory: to sample.**

- [About Ticketsolve](https://ticketsolve.com/about) (read directly; 200) describes its UK and Ireland venue base.
- The operator footprint is distinct from actual sampled venue inventory, which is a verification task. US: not evidenced. Other countries are **unknown**.

Priority is unchanged: **P2**, post-v1 / nice to have; **Required for v1:** No.

## Shared context

See the [baseline and verification rules](../shared-context.md). Observations below retain their original 2026-10-14 date and are not a production test.

## Verified facts (2026-10-14)

Observations come from sampled development requests (curl with the app user agent, 2026-10-14), not from the production host; re-check before implementing.

| Item | Result |
| --- | --- |
| Attendee URL form | `{venue}.ticketsolve.com/shows/{show}/events/{event}`, per the official [web-developer integration guide](https://ticketsolve.zendesk.com/hc/en-us/articles/360057030432-How-to-integrate-your-website-with-Ticketsolve-A-guide-for-web-developers), which also documents a feed. **Not sampled** this round |
| Show vs event | `/shows/{show}` is a show page (multiple performances) and `/events/{event}` is one performance: **date selection** applies to show links |
| Marketing site | `ticketsolve.com/about` → "About": a **false stub** today |

## Scope

- **Verification task first:** sample two venue subdomains (UK and Ireland). Record `/shows/` and `/events/` pages, structured data, and whether the official feed gives event metadata under acceptable terms.
- `ticketsolve.ts`: recognise `{venue}.ticketsolve.com` show and event paths (lookalike-safe). `ticketsolve.com` marketing pages are refused without a fetch.
- Show links ask which performance; event links map one performance. Dates are Europe/London or Europe/Dublin local dates.

## Acceptance criteria

- [ ] Verified URL forms and data source are recorded here before rules are merged.
- [ ] Recognition tests: show paths, event paths, marketing pages and lookalikes.
- [ ] A **valid event page** fixture produces a stub with the title, local date, venue and city and `source: "Ticketsolve"` for a single performance. A show fixture gives a date choice.
- [ ] Saved **non-event, listing, blocked or error** fixtures give a specific outcome (refusal, `not_found`, or `access_restricted` with the manual-details fallback) instead of a stub (marketing page).
- [ ] Offline in `npm test`.

## Validation plan / evidence required

Run `npm run lint`, `npm run typecheck`, `npm test` and `npm run build`. Offline tests use saved, sanitized fixtures and assert that no unexpected network request is made. Live checks happen only on Preview in live mode, with owner authorization, and record their mode. Before local completion, record the local implementation commit, fixture provenance and dates, and command results. A remote PR is not required by this local backlog. Creating this record does not claim implementation or passing tests.
