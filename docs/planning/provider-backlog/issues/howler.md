# PROVIDER-023 — Howler

**Local issue ID:** PROVIDER-023. **Recorded:** 2026-10-15.

## Summary / user outcome

Give Howler event links (`www.howler.co.za/events/{slug}` and organiser subdomains `{org}.howler.co.za/events/{slug}`) dedicated, tested support. Howler sells festival and event tickets in southern Africa. A sampled event page publishes a schema.org Event that the generic parser reads (**existing generic support**). What's missing is **dedicated regression coverage**. Howler is a distinct source from Quicket ([#177](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/issues/177)); their regions overlap, but the URL integrations are separate.

**Related:** [#177](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/issues/177) (Quicket, an overlapping region); [#151](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/issues/151) (generic-parser regression fixtures).
**Priority:** P2. Post-v1 / nice to have. **Required for v1:** No. **Status:** local draft, not published (no GitHub issue number; the duplicate search ran 2026-10-14, but the final live check was unavailable). **Owner role:** Product and frontend.

## Geographic coverage (evidence 2026-10-14)
<!-- geo-coverage:2026-10-14 -->

**Howler: international, non-US. Verified: South Africa and Namibia.**

- Official listings (2026-10-14): [Our Origin Festival](https://www.howler.co.za/events/our-origin-festival-a837) and [Sound of Summer 2026](https://namibrage.howler.co.za/events/sound-of-summer-2026-8a50) (organiser subdomain; Namibia).
- Other countries are **unknown**. US: not evidenced.

Priority is unchanged: **P2**, post-v1 / nice to have; **Required for v1:** No.

## Shared context

See the [baseline and verification rules](../shared-context.md). Coverage evidence dates to 2026-10-14; the sampled development requests below date to 2026-10-15. Neither establishes production behavior.

## Probe notes (2026-10-15)

| Item | Result |
| --- | --- |
| Event page | `www.howler.co.za/events/our-origin-festival-a837`: 200, parsed as `schema_org`: "Our Origin Festival " (trailing space), `startDate` `2026-10-16T16:00:00+02:00`, `endDate` `2026-10-18T14:00:00+02:00`, Place "Impact Hub", performer and offers |
| Organiser subdomain | `namibrage.howler.co.za/events/…`: **not probed** this round |

## Scope

- `howler.ts`: recognise `www.howler.co.za` and `*.howler.co.za` `/events/{slug}` (lookalike-safe), with identity scoped to the normalized host and full event path. The short slug suffix is not a verified global identifier; merge cross-host aliases only after verifying a shared event identity. Organiser home and listing pages are refused without a fetch.
- Trim titles. Map the local date with its offset. Continuous multi-day festivals show the full date range; separate performances require an explicit choice, per [#151](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/issues/151). For verified Namibian venues, use Africa/Windhoek.

## Acceptance criteria

- [ ] Recognition tests: `www` and subdomain events, organiser pages and lookalikes.
- [ ] A **valid event page** fixture produces a stub with the title, local date range, venue and `source: "Howler"` ("Our Origin Festival", Oct 16–18, 2026, Impact Hub). The sampled data has no city source: leave city unset unless verified separately.
- [ ] Equal short suffixes on different organiser hosts do not merge. Only verified aliases dedupe to one event.
- [ ] A continuous event preserves its range; separate performances require a selection.
- [ ] Saved **non-event, listing, blocked or error** fixtures give a specific outcome (refusal, `not_found`, or `access_restricted` with the manual-details fallback) instead of a stub.
- [ ] Added to the [#151](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/issues/151) regression suite.
- [ ] Offline in `npm test`.

## Validation plan / evidence required

Run `npm run lint`, `npm run typecheck`, `npm test` and `npm run build`. Offline tests use saved, sanitized fixtures and assert that no unexpected network request is made. Live checks happen only on Preview in live mode, with owner authorization. Before local completion, record the local implementation commit, fixture provenance and dates, and command results. A remote PR is not required by this local backlog. Creating this record does not claim implementation or passing tests.
