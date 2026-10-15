# PROVIDER-005 — Ticketline

**Status:** planned locally; not published to GitHub. **Recorded:** 2026-10-15.

## Summary / user outcome

Support Ticketline event links (`www.ticketline.co.uk`). Ticketline is a UK ticketer for gigs, sport and comedy. Today its **listing pages become stubs for the wrong event** (9 Event nodes, the first taken), and a sampled order link redirects to a cookie-error page that becomes a "Ticketline" stub.

**Related:** [#151](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/issues/151) (generic-parser hardening: pages with many Event nodes are listings).
**Priority:** P2. Post-v1 / nice to have. **Required for v1:** No. **Local issue ID:** PROVIDER-005. **Owner role:** Product and frontend. No exact duplicate was found in the captured 2026-10-14 inventory; current remote state has not been refreshed.

## Geographic coverage (verified 2026-10-14)
<!-- geo-coverage:2026-10-14 -->

**Ticketline: international, non-US. Observed event inventory: United Kingdom.**

- Official listings [on sale today](https://www.ticketline.co.uk/event/on-sale-today) and [coming soon](https://www.ticketline.co.uk/event/coming-soon) show Bath, Manchester and London events (read directly; 200).
- Other regions are **unknown**. US: not evidenced.

Priority is unchanged: **P2**, post-v1 / nice to have; **Required for v1:** No.

## Shared context

See the [baseline and verification rules](../shared-context.md). Observations below retain their original 2026-10-14 date and are not a production test.

## Verified facts (2026-10-14)

Observations come from sampled development requests (curl with the app user agent, 2026-10-14), not from the production host; re-check before implementing.

| Item | Result |
| --- | --- |
| Listing page | `/event/on-sale-today`: 200 with **9 Event nodes**. The app takes the first, "Team Bath NXT Gen 2027 Season Ticket" (a season ticket, not an event), so the listing gives a **wrong-event stub** |
| Order link | `/order/tickets/{id}/{slug-with-venue-and-datetime}` (from the listing JSON-LD) → 3 redirects → `/error/no-cookie` (200, title "Ticketline"): a **false stub** today |
| Event page form | **Unverified.** A non-order event page form, if one exists, is an implementation task. The order slug includes date and time (e.g. `…-2027-06-19-15-00-00`) |
| Dates | Listing JSON-LD uses `+00:00` offsets: convert to Europe/London |

## Scope

- `ticketline.ts`: recognise verified event paths and `/order/tickets/{id}/{slug}` links (canonicalise on the id). `/event/on-sale-today`, `/event/coming-soon` and other listings are refused without a fetch.
- For order links: do not follow the checkout redirect into the cookie-error page. Use a verified event page or the listing data for that id, or fall back to the manual-details fallback ([#144](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/issues/144)) with date and venue left blank until a supported source verifies them. A slug may prefill these fields only after the exact mapping has been verified against an event page.
- Season tickets and passes are not single events: refuse them or ask the customer.

## Acceptance criteria

- [ ] Verified event and order URL forms are recorded here before rules are merged.
- [ ] Recognition tests: event, order, listing, season-ticket and lookalike URLs.
- [ ] A **valid event page** fixture produces a stub with the title, local date, venue and city and `source: "Ticketline"`.
- [ ] Saved **non-event, listing, blocked or error** fixtures give a specific outcome (refusal, `not_found`, or `access_restricted` with the manual-details fallback) instead of a stub. The 9-node listing fixture never yields "Team Bath NXT Gen 2027 Season Ticket", and the cookie-error fixture never yields "Ticketline".
- [ ] Offline in `npm test`.

## Validation plan / evidence required

Run `npm run lint`, `npm run typecheck`, `npm test` and `npm run build`. Offline tests use saved, sanitized fixtures and assert that no unexpected network request is made. Live checks happen only on Preview in live mode, with owner authorization, and record their mode. Before local completion, record the local implementation commit, fixture provenance and dates, and command results. A remote PR is not required by this local backlog. Creating this record does not claim implementation or passing tests.
