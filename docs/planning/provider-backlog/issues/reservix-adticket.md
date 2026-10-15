# PROVIDER-017 — Reservix / ADticket

**Local issue ID:** PROVIDER-017. **Recorded:** 2026-10-15.

## Summary / user outcome

Support Reservix-family ticket links: `reservix.de`, `reservix.at` and `adticket.de`. They form one family issue because Reservix owns the portals. **Shared ownership does not establish a shared parser**: each host is verified separately. On sampled requests, `reservix.at` and `adticket.de` returned a **CloudFront 403**.

**Related:** [#144](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/issues/144) (bot-block detection and manual-details fallback), based on the observed 403s.
**Priority:** P2. Post-v1 / nice to have. **Required for v1:** No. **Status:** local draft, not published (no GitHub issue number; the duplicate search ran 2026-10-14, but the final live check was unavailable). **Owner role:** Product and frontend.

## Geographic coverage (evidence 2026-10-14)
<!-- geo-coverage:2026-10-14 -->

**Reservix / ADticket: international, non-US. Verified: Germany and Austria.**

- [Reservix press area](https://www.reservix.net/en/news-pressebereich/) (2026-10-14): Reservix owns the ticket portals. Official portals: [reservix.at](https://www.reservix.at/) (Austria) and [adticket.de concerts](https://www.adticket.de/Konzerte.html) (Germany).
- Other countries are **unknown**. US: not evidenced.

Priority is unchanged: **P2**, post-v1 / nice to have; **Required for v1:** No.

## Shared context

See the [baseline and verification rules](../shared-context.md). Coverage evidence dates to 2026-10-14; the sampled development requests below date to 2026-10-15. Neither establishes production behavior.

## Probe notes (2026-10-15)

| Item | Result |
| --- | --- |
| `www.reservix.at/` | **403** CloudFront "ERROR: The request could not be satisfied" |
| `www.adticket.de/Konzerte.html` | **403** CloudFront (same) |
| `reservix.de` | Not probed |
| Event URL forms | **Unverified** per host. Implementation task |

## Scope

- A family registry entry in [#144](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/issues/144) with **separate host rules**: `reservix.de`, `reservix.at`, `adticket.de` (with `www.`). Only verified event paths are candidates; category pages such as `Konzerte.html` are refused without a fetch.
- While blocked: a provider-specific message (Reservix or ADticket, by host) plus the manual-details fallback ([#144](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/issues/144)). No retry loop.
- **Verification tasks:** event URL forms and readability per host from the production host, and whether event ids are shared across portals (for dedupe).

## Acceptance criteria

- [ ] Verified URL forms per host are recorded here before rules are merged.
- [ ] Recognition tests for each host, category pages and lookalikes.
- [ ] Saved CloudFront 403 fixtures are `access_restricted` with the fallback.
- [ ] A **valid event page** fixture produces a stub with the title, local date, venue and city and `source: "Reservix"` (or `"ADticket"`), if a readable page is obtained.
- [ ] Saved **non-event, listing, blocked or error** fixtures give a specific outcome (refusal, `not_found`, or `access_restricted` with the manual-details fallback) instead of a stub.
- [ ] Offline in `npm test`.

## Validation plan / evidence required

Run `npm run lint`, `npm run typecheck`, `npm test` and `npm run build`. Offline tests use saved, sanitized fixtures and assert that no unexpected network request is made. Live checks happen only on Preview in live mode, with owner authorization. Before local completion, record the local implementation commit, fixture provenance and dates, and command results. A remote PR is not required by this local backlog. Creating this record does not claim implementation or passing tests.
