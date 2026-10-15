# PROVIDER-015 — TicketSwap

**Local issue ID:** PROVIDER-015. **Recorded:** 2026-10-15.

## Summary / user outcome

Support TicketSwap event links. TicketSwap is a fan-to-fan resale marketplace, so one event has many listings: the stub should describe the **event**, and links to different listings for the same event should dedupe ([#141](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/issues/141)). Being a resale site does not by itself mean it is blocked. On a sampled request, however, a TicketSwap page returned a **202 "Verifying" challenge page**, which the app accepts as 2xx and would turn into a "Verifying" stub.

**Related:** [#144](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/issues/144) (bot-block detection and manual-details fallback), based on the observed challenge page; [#141](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/issues/141) (bulk paste dedupe on the canonical event).
**Priority:** P2. Post-v1 / nice to have. **Required for v1:** No. **Status:** local draft, not published (no GitHub issue number; the duplicate search ran 2026-10-14, but the final live check was unavailable). **Owner role:** Product and frontend.

## Geographic coverage (evidence 2026-10-14)
<!-- geo-coverage:2026-10-14 -->

**TicketSwap: US plus international. Observed: United States and Netherlands; "42 countries" claimed.**

- Official pages (2026-10-14): [United States](https://www.ticketswap.com/united-states) and [Amsterdam, Netherlands](https://www.ticketswap.com/event-tickets/l/netherlands/amsterdam).
- [TicketSwap press "About"](https://press.ticketswap.com/about/) claims 42 countries. Individual countries other than the US and the Netherlands are **unverified**.

Priority is unchanged: **P2**, post-v1 / nice to have; **Required for v1:** No.

## Shared context

See the [baseline and verification rules](../shared-context.md). Coverage evidence dates to 2026-10-14; the sampled development requests below date to 2026-10-15. Neither establishes production behavior.

## Probe notes (2026-10-15)

| Item | Result |
| --- | --- |
| Location page | `/event-tickets/l/netherlands/amsterdam`: **202**, ~2 KB, title "Verifying" (a bot-verification page). The app accepts 2xx, so this is a **false "Verifying" stub** today |
| Event URL forms | **Unverified** (event, listing and location forms). Implementation task |

## Scope

- `ticketswap.ts`: first verify event-detail and individual resale-offer URL forms and a stable event identifier. Only then canonicalise verified offer links to their event for dedupe, retaining each original URL as provenance. Location, city and search pages are refused without a fetch.
- Treat a verification or challenge page (any status) as `access_restricted`, with a TicketSwap-specific message and the manual-details fallback ([#144](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/issues/144)).
- **Verification tasks:** URL forms, readability from the production host, and structured data on event pages.

## Acceptance criteria

- [ ] Verified URL forms are recorded here before rules are merged.
- [ ] Recognition and canonicalisation tests use verified event-detail and resale-offer forms, location pages and lookalikes. The sampled city-page challenge does not verify event or offer URL forms.
- [ ] A **valid event page** fixture produces a stub with the title, local date and available venue/city and `source: "TicketSwap"`, if a readable page is obtained. Missing fields stay unset.
- [ ] After verifying a stable event identity, two actual offer links for that event dedupe to one stub and retain both source URLs. Different events with similar titles stay separate.
- [ ] A saved 202 "Verifying" fixture is `access_restricted` and never a stub.
- [ ] Saved **non-event, browse listing, blocked or error** fixtures give a specific outcome (refusal, `not_found`, or `access_restricted` with the manual-details fallback) instead of a stub. An individual resale offer can resolve to an event only through a verified identity mapping.
- [ ] Offline in `npm test`.

## Validation plan / evidence required

Run `npm run lint`, `npm run typecheck`, `npm test` and `npm run build`. Offline tests use saved, sanitized fixtures and assert that no unexpected network request is made. Live checks happen only on Preview in live mode, with owner authorization. Before local completion, record the local implementation commit, fixture provenance and dates, and command results. A remote PR is not required by this local backlog. Creating this record does not claim implementation or passing tests.
