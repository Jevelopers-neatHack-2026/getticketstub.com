# PROVIDER-001 — Events.com

**Status:** planned locally; not published to GitHub. **Recorded:** 2026-10-15.

## Summary / user outcome

Support Events.com ticket links: the registration and ticket host `reg-ui.prod.events.com/r/{locale}/event/{id}/details`, plus `events.com` and `discover.events.com` pages. Brown Paper Tickets is retiring toward Events.com, so legacy BPT links are part of this issue as a **migration and verification task**, not a separate provider issue. Today a sampled ticket page gives a title-only stub with no date or venue.

**Priority:** P2. Post-v1 / nice to have. **Required for v1:** No. **Local issue ID:** PROVIDER-001. **Owner role:** Product and frontend. No exact duplicate was found in the captured 2026-10-14 inventory; current remote state has not been refreshed.

## Geographic coverage (verified 2026-10-14)
<!-- geo-coverage:2026-10-14 -->

**Events.com: US verified; international ticket inventory unverified.**

- The official [events.com home page](https://events.com/) lists events in San Diego and Hayward, CA (read directly; 200).
- Global discovery marketing and city lists are **not** treated as proof of international ticket inventory; it is **unverified**.
- [Brown Paper Tickets](https://www.brownpapertickets.com/index.html) states it is retiring toward Events.com (see also `events.com/bpt/`).

Priority is unchanged: **P2**, post-v1 / nice to have; **Required for v1:** No.

## Shared context

See the [baseline and verification rules](../shared-context.md). Observations below retain their original 2026-10-14 date and are not a production test.

## Verified facts (2026-10-14)

Observations come from sampled development requests (curl with the app user agent, 2026-10-14), not from the production host; re-check before implementing.

| Item | Result |
| --- | --- |
| Ticket URL form | `reg-ui.prod.events.com/r/en_US/event/{id}/details` (found on the home page, e.g. `1071200`) |
| Ticket page | 200, ~75 KB, **no JSON-LD**. Title-only stub "THE FEAST 2026". No date or venue |
| Marketing pages | `events.com/` → "Events.com"; `events.com/bpt/` → "BPT": both **false stubs** today |
| Legacy BPT links | `brownpapertickets.com` (200). Whether old `brownpapertickets.com/event/{id}` links redirect to Events.com, and how, is **unverified** |
| discover.events.com | URL forms and their relation to `reg-ui` ids are **unverified** |

## Scope

- `eventscom.ts`: recognise `reg-ui.prod.events.com/r/{locale}/event/{id}/…` (canonicalise on the id; `details` and other tabs map to one event) after verifying the equivalence of each tab. Add `discover.events.com` recognition only after representative attendee paths, redirects and identifiers have been verified; no discovery-path rule is established by this draft. `events.com` marketing pages, including `/bpt/`, are refused without a fetch.
- **Verification task first:** a supported date and venue source (embedded data or an official API); otherwise use the manual-details fallback ([#144](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/issues/144)) with the title prefilled.
- **BPT migration:** record the redirect behaviour of legacy Brown Paper Tickets event links. If they reach an Events.com event, canonicalise to it. Otherwise give a specific "this Brown Paper Tickets link has moved or retired" outcome.

## Acceptance criteria

- [ ] Verified URL forms (reg-ui, discover, legacy BPT) are recorded here before rules are merged.
- [ ] Recognition and canonicalisation tests for each form, marketing pages and lookalikes.
- [ ] A **valid event page** fixture produces a stub with the title, local date, venue and city and `source: "Events.com"`, or the documented fallback without an invented date.
- [ ] Saved **non-event, listing, blocked or error** fixtures give a specific outcome (refusal, `not_found`, or `access_restricted` with the manual-details fallback) instead of a stub (marketing page, `/bpt/`, a retired BPT link).
- [ ] Offline in `npm test`.

## Validation plan / evidence required

Run `npm run lint`, `npm run typecheck`, `npm test` and `npm run build`. Offline tests use saved, sanitized fixtures and assert that no unexpected network request is made. Live checks happen only on Preview in live mode, with owner authorization, and record their mode. Before local completion, record the local implementation commit, fixture provenance and dates, and command results. A remote PR is not required by this local backlog. Creating this record does not claim implementation or passing tests.
