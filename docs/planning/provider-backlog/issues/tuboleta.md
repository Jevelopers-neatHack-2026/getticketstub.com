# PROVIDER-010 — Tuboleta

**Status:** planned locally; not published to GitHub. **Recorded:** 2026-10-15.

## Summary / user outcome

Support Tuboleta event links (`tuboleta.com`, `web.tuboleta.com`, `*.checkout.tuboleta.com`). Tuboleta sells tickets for concerts, sport, theatre and attractions in Colombia. A sampled listing publishes a schema.org Event, but it was a theme-park **attraction** whose `startDate` was **the probe day itself**, so using that value as the customer's attendance date risks a misleading stub. A single sample does not establish that the date rolls daily; that remains unverified.

**Product scope decision (owner role):** attractions and undated products (parks, passes) are excluded until decided. Only dated events are in scope.

**Related:** [#151](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/issues/151) (generic-parser hardening: potentially generated dates on undated products; rolling-date behavior is unverified).
**Priority:** P2. Post-v1 / nice to have. **Required for v1:** No. **Local issue ID:** PROVIDER-010. **Owner role:** Product and frontend. No exact duplicate was found in the captured 2026-10-14 inventory; current remote state has not been refreshed.

## Geographic coverage (verified 2026-10-14)
<!-- geo-coverage:2026-10-14 -->

**Tuboleta: international, non-US. Observed event inventory: Colombia.**

- Official [tuboleta.com/es](https://www.tuboleta.com/es) (read directly; 200) and [web.tuboleta.com](https://web.tuboleta.com/) list venues in Bogotá, Medellín, Cali and others (research-agent-verified 2026-10-14).
- Other countries are **unknown**. US: not evidenced.

Priority is unchanged: **P2**, post-v1 / nice to have; **Required for v1:** No.

## Shared context

See the [baseline and verification rules](../shared-context.md). Observations below retain their original 2026-10-14 date and are not a production test.

## Verified facts (2026-10-14)

Observations come from sampled development requests (curl with the app user agent, 2026-10-14), not from the production host; re-check before implementing.

| Item | Result |
| --- | --- |
| URL form | `tuboleta.com/es/eventos/{slug}` (from the home page) |
| Attraction page | `/es/eventos/parque-tematico-caribe-aventura`: 200, parsed as `schema_org`: "PARQUE TEMATICO CARIBE AVENTURA", `startDate` = `endDate` = `2026-10-14T07:00:00-0500` (**the day of the probe**), location type City "Cartagena". The date is probably generated, not a real event date: **verify** |
| Home | `/es` → "Tuboleta": a **false stub** today |
| Other hosts | `web.tuboleta.com` and `*.checkout.tuboleta.com` URL forms and relationship: **unverified** |

## Scope

- `tuboleta.ts`: recognise verified `/es/eventos/{slug}` forms on `tuboleta.com`. Treat `web.tuboleta.com` as a candidate host only; enable its paths after representative attendee URLs and redirects are verified. Checkout hosts are not fetched; they map to an event only via a verified rule. Home, listing and product pages are refused without a fetch.
- Classify products: dated event, attraction or undated. An attraction or undated product is refused (pending the scope decision), even if its JSON-LD carries a date.
- **Verification tasks:** a real concert fixture, the dynamic-date pattern, and America/Bogota local dates.

## Acceptance criteria

- [ ] Verified URL forms and product classification are recorded here before rules are merged.
- [ ] Recognition tests: event, attraction, checkout, home and lookalikes.
- [ ] A **valid event page** fixture produces a stub with the title, local date, venue and city and `source: "Tuboleta"` for a real concert.
- [ ] The theme-park fixture is refused as an attraction and never stamped with the fetch date.
- [ ] Saved **non-event, listing, blocked or error** fixtures give a specific outcome (refusal, `not_found`, or `access_restricted` with the manual-details fallback) instead of a stub.
- [ ] Offline in `npm test`.

## Validation plan / evidence required

Run `npm run lint`, `npm run typecheck`, `npm test` and `npm run build`. Offline tests use saved, sanitized fixtures and assert that no unexpected network request is made. Live checks happen only on Preview in live mode, with owner authorization, and record their mode. Before local completion, record the local implementation commit, fixture provenance and dates, and command results. A remote PR is not required by this local backlog. Creating this record does not claim implementation or passing tests.
