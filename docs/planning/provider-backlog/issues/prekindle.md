# PROVIDER-014 — Prekindle

**Local issue ID:** PROVIDER-014. **Recorded:** 2026-10-15.

## Summary / user outcome

Support Prekindle event links (`www.prekindle.com/event/{id}-{slug}`). Prekindle is a US ticketer for independent venues and concerts. On a sampled request, an event link redirected to the **venue page**, whose JSON-LD lists 8 events. The generic parser took the first, so the link became a stub for a **different event**.

**Related:** [#151](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/issues/151) (generic-parser hardening: listing pages with many Event nodes).
**Priority:** P2. Post-v1 / nice to have. **Required for v1:** No. **Status:** local draft, not published (no GitHub issue number; the duplicate search ran 2026-10-14, but the final live check was unavailable). **Owner role:** Product and frontend.

## Geographic coverage (evidence 2026-10-14)
<!-- geo-coverage:2026-10-14 -->

**Prekindle: US verified. Other countries unverified.**

- Official listings (2026-10-14): [Amyl and the Sniffers, Dallas](https://www.prekindle.com/event/92913-amyl-and-the-sniffers-dallas) and the [Prekindle home page](https://www.prekindle.com/wicket/bookmarkable/com.prekindle.webapp.pages.HomePage).
- Other countries are **unverified**.

Priority is unchanged: **P2**, post-v1 / nice to have; **Required for v1:** No.

## Shared context

See the [baseline and verification rules](../shared-context.md). Coverage evidence dates to 2026-10-14; the sampled development requests below date to 2026-10-15. Neither establishes production behavior.

## Probe notes (2026-10-15)

| Item | Result |
| --- | --- |
| Event link | `/event/92913-amyl-and-the-sniffers-dallas` → 1 redirect → `/events/longhorn-ballroom` (venue page; the event has probably ended or moved: **verify**) |
| Venue page | 200 with **8 Event/MusicEvent nodes**. The app took the first, "Randy Travis: More Life Tour…", `2026-10-15`, The Longhorn Ballroom: a **wrong-event stub** |
| Live event page | Parsing of a current, non-redirected event page is **unverified** |

## Scope

- `prekindle.ts`: recognise `/event/{id}-{slug}`, canonicalised on the id. Venue (`/events/{venue}`), organiser and home pages are refused without a fetch.
- When an event link redirects to a venue or listing page, return `not_found` or ask the customer. Never pick another event.
- **Verification tasks:** a live event fixture and the date format (date-only or with time).

## Acceptance criteria

- [ ] Recognition tests: event ids, venue pages, home and lookalikes.
- [ ] Before claiming successful event parsing, capture a readable, non-redirecting event fixture and verify its identity and date format. That fixture produces a stub with the title, local date, available venue/city and `source: "Prekindle"`; missing fields stay unset. This success case remains unverified until that fixture is obtained.
- [ ] The redirect-to-venue fixture never yields "Randy Travis…" or any other event.
- [ ] Saved **non-event, listing, blocked or error** fixtures give a specific outcome (refusal, `not_found`, or `access_restricted` with the manual-details fallback) instead of a stub.
- [ ] Offline in `npm test`.

## Validation plan / evidence required

Run `npm run lint`, `npm run typecheck`, `npm test` and `npm run build`. Offline tests use saved, sanitized fixtures and assert that no unexpected network request is made. Live checks happen only on Preview in live mode, with owner authorization. Before local completion, record the local implementation commit, fixture provenance and dates, and command results. A remote PR is not required by this local backlog. Creating this record does not claim implementation or passing tests.
