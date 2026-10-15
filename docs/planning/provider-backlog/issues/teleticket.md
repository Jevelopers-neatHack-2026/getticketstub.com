# PROVIDER-009 — Teleticket

**Status:** planned locally; not published to GitHub. **Recorded:** 2026-10-15.

## Summary / user outcome

Support Teleticket event links (`teleticket.com.pe`, `compra.teleticket.com.pe`, `pagos.teleticket.com.pe`). Teleticket sells tickets for concerts and sport in Peru. A sampled event page has **no JSON-LD**, and the title split **drops the artist**: "PUERTAS TOUR - CUARTETO DE NOS - LIMA 2026" becomes "PUERTAS TOUR".

**Related:** [#208](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/issues/208) (Punto Ticket). A sister or corporate link is **not** evidence that the same parser works; share only rules verified for both.
**Priority:** P2. Post-v1 / nice to have. **Required for v1:** No. **Local issue ID:** PROVIDER-009. **Owner role:** Product and frontend. No exact duplicate was found in the captured 2026-10-14 inventory; current remote state has not been refreshed.

## Geographic coverage (verified 2026-10-14)
<!-- geo-coverage:2026-10-14 -->

**Teleticket: international, non-US. Observed event inventory: Peru.**

- Official [concert catalogue](https://compra.teleticket.com.pe/Conciertos) (read directly; 200) and [Cuarteto de Nos – Lima 2026](https://pagos.teleticket.com.pe/cuarteto-de-nos-lima-2026).
- Other countries are **unknown**. US: not evidenced.

Priority is unchanged: **P2**, post-v1 / nice to have; **Required for v1:** No.

## Shared context

See the [baseline and verification rules](../shared-context.md). Observations below retain their original 2026-10-14 date and are not a production test.

## Verified facts (2026-10-14)

Observations come from sampled development requests (curl with the app user agent, 2026-10-14), not from the production host; re-check before implementing.

| Item | Result |
| --- | --- |
| Event page | `pagos.teleticket.com.pe/cuarteto-de-nos-lima-2026`: 200, ~49 KB, **no JSON-LD**. Title-only stub, cut to "PUERTAS TOUR" (the artist and city are lost). No date |
| Catalogue | `compra.teleticket.com.pe/Conciertos` → "M&[#250](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/issues/250);sica" (HTML entity not decoded): a **false stub** today |
| Host roles | The roles of `teleticket.com.pe`, `compra.` and `pagos.` and the redirects between them are **unverified** |

## Scope

- `teleticket.ts`: recognise verified event paths on the three hosts, canonicalised to one URL. Catalogue and category pages (`/Conciertos` etc.) are refused without a fetch.
- Keep the full title (no ` - ` split). Find a date and venue source (embedded data); otherwise use the manual-details fallback ([#144](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/issues/144)). America/Lima local dates.
- **Verification tasks:** host roles, URL forms and the date source.

## Acceptance criteria

- [ ] Verified host roles and URL forms are recorded here before rules are merged.
- [ ] Recognition tests for the three hosts, catalogue pages and lookalikes.
- [ ] A **valid event page** fixture produces a stub with the title, local date, venue and city and `source: "Teleticket"`, keeping "PUERTAS TOUR - CUARTETO DE NOS - LIMA 2026" intact, or the documented fallback without an invented date.
- [ ] Saved **non-event, listing, blocked or error** fixtures give a specific outcome (refusal, `not_found`, or `access_restricted` with the manual-details fallback) instead of a stub (catalogue page).
- [ ] Offline in `npm test`.

## Validation plan / evidence required

Run `npm run lint`, `npm run typecheck`, `npm test` and `npm run build`. Offline tests use saved, sanitized fixtures and assert that no unexpected network request is made. Live checks happen only on Preview in live mode, with owner authorization, and record their mode. Before local completion, record the local implementation commit, fixture provenance and dates, and command results. A remote PR is not required by this local backlog. Creating this record does not claim implementation or passing tests.
