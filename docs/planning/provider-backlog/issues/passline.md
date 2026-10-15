# PROVIDER-007 — Passline

**Status:** planned locally; not published to GitHub. **Recorded:** 2026-10-15.

## Summary / user outcome

Support Passline event links (`www.passline.com/eventos/{slug}`). Passline lists concerts, festivals and parties. The cited evidence includes dated events in Chile and Peru and a Colombia city listing. Sampled development requests returned a Cloudflare challenge (403); the baseline parser would give a generic error for those responses. Production behavior is unverified.

**Related:** [#144](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/issues/144) (bot-block detection and manual-details fallback).
**Priority:** P2. Post-v1 / nice to have. **Required for v1:** No. **Local issue ID:** PROVIDER-007. **Owner role:** Product and frontend. No exact duplicate was found in the captured 2026-10-14 inventory; current remote state has not been refreshed.

## Geographic coverage (verified 2026-10-14)
<!-- geo-coverage:2026-10-14 -->

**Passline: international, non-US. Dated event inventory observed: Chile and Peru. Colombia: city listing observed; dated event inventory unverified.**

- Observed official listings (research-agent-verified 2026-10-14): [Festival Música y Fe 2026](https://www.passline.com/eventos/festival-musica-y-fe-2026) (Chile), [La Primerísima del Perú…](https://www.passline.com/eventos/la-primerisima-del-peru-los-conquistadores-de-la-salsa-sab-1710) (Lima) and [Bogotá listing](https://www.passline.com/eventos/bogota) (Colombia).
- Coverage follows the actual venue country, not the site's country selector or the artist's origin. Other countries are **unknown**. US: not evidenced.

Priority is unchanged: **P2**, post-v1 / nice to have; **Required for v1:** No.

## Shared context

See the [baseline and verification rules](../shared-context.md). Observations below retain their original 2026-10-14 date and are not a production test.

## Verified facts (2026-10-14)

Observations come from sampled development requests (curl with the app user agent, 2026-10-14), not from the production host; re-check before implementing.

| Item | Result |
| --- | --- |
| Sampled response | `/eventos/festival-musica-y-fe-2026` and `/eventos/bogota`: **403 with `cf-mitigated: challenge`** |
| URL shape | Events and city listings share `/eventos/{slug}` (e.g. `/eventos/bogota` is a city page), so a path rule alone cannot tell them apart. **Verify** a distinguishing rule |
| Parsing | **Unknown**: no page content was reachable |

## Scope

- Passline entry in the [#144](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/issues/144) registry: recognise `passline.com` `/eventos/{slug}`. Known city and listing slugs are refused without a fetch.
- While blocked: show a Passline-specific message plus the fallback, prefilled from the slug. Never retry in a loop.
- **Verification tasks:** event versus city slugs, readability from the production host, and local dates per country (America/Santiago, Lima, Bogota).

## Acceptance criteria

- [ ] Verified slug classification is recorded here before rules are merged.
- [ ] Recognition tests: event slugs, city slugs and lookalikes.
- [ ] A saved challenge fixture is `access_restricted` with the prefilled fallback.
- [ ] A **valid event page** fixture produces a stub with the title, local date, venue and city and `source: "Passline"`, if a readable page is obtained.
- [ ] Saved **non-event, listing, blocked or error** fixtures give a specific outcome (refusal, `not_found`, or `access_restricted` with the manual-details fallback) instead of a stub.
- [ ] Offline in `npm test`.

## Validation plan / evidence required

Run `npm run lint`, `npm run typecheck`, `npm test` and `npm run build`. Offline tests use saved, sanitized fixtures and assert that no unexpected network request is made. Live checks happen only on Preview in live mode, with owner authorization, and record their mode. Before local completion, record the local implementation commit, fixture provenance and dates, and command results. A remote PR is not required by this local backlog. Creating this record does not claim implementation or passing tests.
