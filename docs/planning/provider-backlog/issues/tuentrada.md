# PROVIDER-008 — TuEntrada

**Status:** planned locally; not published to GitHub. **Recorded:** 2026-10-15.

## Summary / user outcome

Support TuEntrada event links (`tuentrada.com` and `comprar.tuentrada.com`). TuEntrada sells tickets for theatre, concerts and venues in Argentina. On a sampled development request the purchase host returned a Cloudflare 403. Theatre and venue pages often carry many dates, which need an explicit **date selection** rather than first-node guessing.

**Related:** [#144](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/issues/144) (bot-block detection and manual-details fallback).
**Priority:** P2. Post-v1 / nice to have. **Required for v1:** No. **Local issue ID:** PROVIDER-008. **Owner role:** Product and frontend. No exact duplicate was found in the captured 2026-10-14 inventory; current remote state has not been refreshed.

## Geographic coverage (verified 2026-10-14)
<!-- geo-coverage:2026-10-14 -->

**TuEntrada: international, non-US. Observed event inventory: Argentina.**

- Official [tuentrada.com](https://tuentrada.com/) (read directly; 200) and [comprar.tuentrada.com/tuentrada/events](https://comprar.tuentrada.com/tuentrada/events) (research-agent-verified) list Argentine events.
- Other countries are **unknown**. US: not evidenced.

Priority is unchanged: **P2**, post-v1 / nice to have; **Required for v1:** No.

## Shared context

See the [baseline and verification rules](../shared-context.md). Observations below retain their original 2026-10-14 date and are not a production test.

## Verified facts (2026-10-14)

Observations come from sampled development requests (curl with the app user agent, 2026-10-14), not from the production host; re-check before implementing.

| Item | Result |
| --- | --- |
| `tuentrada.com/` | 200, title "TuEntrada": a **false stub** today |
| `comprar.tuentrada.com/tuentrada/events` | **403 "Attention Required! | Cloudflare"** on the sampled request |
| Event URL forms | **Unverified** on both hosts. Implementation task |
| Multi-date | Theatre and venue pages may list many performances: **date selection** is required |

## Scope

- **Verification task first:** sample one event per host. Record URL forms, the host relationship, readability and structured data.
- `tuentrada.ts`: recognise verified event paths on both hosts. Home and listing pages are refused without a fetch.
- Multi-date pages ask which performance (America/Argentina/Buenos_Aires local dates). If blocked, use a TuEntrada-specific message and the fallback.

## Acceptance criteria

- [ ] Verified URL forms are recorded here before rules are merged.
- [ ] Recognition tests for both hosts, listings and lookalikes.
- [ ] A **valid event page** fixture produces a stub with the title, local date, venue and city and `source: "TuEntrada"`. A multi-date fixture asks for the performance.
- [ ] A saved Cloudflare 403 fixture is `access_restricted` with the fallback.
- [ ] Saved **non-event, listing, blocked or error** fixtures give a specific outcome (refusal, `not_found`, or `access_restricted` with the manual-details fallback) instead of a stub (home page).
- [ ] Offline in `npm test`.

## Validation plan / evidence required

Run `npm run lint`, `npm run typecheck`, `npm test` and `npm run build`. Offline tests use saved, sanitized fixtures and assert that no unexpected network request is made. Live checks happen only on Preview in live mode, with owner authorization, and record their mode. Before local completion, record the local implementation commit, fixture provenance and dates, and command results. A remote PR is not required by this local backlog. Creating this record does not claim implementation or passing tests.
