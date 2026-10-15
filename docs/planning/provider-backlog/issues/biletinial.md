# PROVIDER-021 — Biletinial

**Local issue ID:** PROVIDER-021. **Recorded:** 2026-10-15.

## Summary / user outcome

Support Biletinial event links (`biletinial.com/tr-tr/…`). Biletinial sells tickets for theatre, concerts, sport and **cinema** in Türkiye. Event pages must be separated from movie pages, and multi-date productions need a date choice. The sampled search page becomes a false stub today; event-page parsing is **unverified**.

**Product scope:** movies follow the same owner decision as BookMyShow ([#191](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/issues/191)) and District ([#194](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/issues/194)).

**Related:** [#191](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/issues/191) and [#194](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/issues/194) (movie-scope decision).
**Priority:** P2. Post-v1 / nice to have. **Required for v1:** No. **Status:** local draft, not published (no GitHub issue number; the duplicate search ran 2026-10-14, but the final live check was unavailable). **Owner role:** Product and frontend.

## Geographic coverage (evidence 2026-10-14)
<!-- geo-coverage:2026-10-14 -->

**Biletinial: international, non-US. Verified: Türkiye.**

- Official [search for "2026"](https://biletinial.com/tr-tr/search?q=2026) (2026-10-14) shows events in Ankara, Istanbul, Bursa, İzmir and Antalya.
- Timezone comes from the venue, not the brand. Other countries are **unknown**. US: not evidenced.

Priority is unchanged: **P2**, post-v1 / nice to have; **Required for v1:** No.

## Shared context

See the [baseline and verification rules](../shared-context.md). Coverage evidence dates to 2026-10-14; the sampled development requests below date to 2026-10-15. Neither establishes production behavior.

## Probe notes (2026-10-15)

| Item | Result |
| --- | --- |
| Search page | 200, title "biletinial | Sinema, Spor, Sanat, Eğitim…" → "biletinial". A **false stub** today |
| Event / movie URL forms | **Unverified.** Implementation task |

## Scope

- **Verification task first:** event, theatre and movie URL forms, structured data, and the multi-date layout.
- `biletinial.ts`: recognise verified event paths. Search, listing and venue pages are refused without a fetch; movie pages follow the scope decision.
- Multi-date productions ask which date (Europe/Istanbul for Turkish venues).

## Acceptance criteria

- [ ] Verified URL forms are recorded here before rules are merged.
- [ ] Recognition tests: event, movie, search, venue and lookalikes.
- [ ] A **valid event page** fixture produces a stub with the title, local date, venue and city and `source: "Biletinial"`. A multi-date fixture asks for the date.
- [ ] Saved **non-event, listing, blocked or error** fixtures give a specific outcome (refusal, `not_found`, or `access_restricted` with the manual-details fallback) instead of a stub (search page).
- [ ] Offline in `npm test`.

## Validation plan / evidence required

Run `npm run lint`, `npm run typecheck`, `npm test` and `npm run build`. Offline tests use saved, sanitized fixtures and assert that no unexpected network request is made. Live checks happen only on Preview in live mode, with owner authorization. Before local completion, record the local implementation commit, fixture provenance and dates, and command results. A remote PR is not required by this local backlog. Creating this record does not claim implementation or passing tests.
