# PROVIDER-016 — Ticket.io

**Local issue ID:** PROVIDER-016. **Recorded:** 2026-10-15.

## Summary / user outcome

Support Ticket.io event links on organiser subdomains (`{organiser}.ticket.io/{code}/`). Ticket.io is a self-service ticketing platform used by German organisers. On a sampled request, the event link returned **200 with a "Security check..." page**, which today becomes a false stub.

**Related:** [#144](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/issues/144) (bot-block detection and manual-details fallback), based on the observed security-check page.
**Priority:** P2. Post-v1 / nice to have. **Required for v1:** No. **Status:** local draft, not published (no GitHub issue number; the duplicate search ran 2026-10-14, but the final live check was unavailable). **Owner role:** Product and frontend.

## Geographic coverage (evidence 2026-10-14)
<!-- geo-coverage:2026-10-14 -->

**Ticket.io: international, non-US. Observed: Germany. Broader geography unknown.**

- Official example (2026-10-14): [Düsseldorf Riesenrad](https://duesseldorf-riesenrad.ticket.io/u3sUKR4N/?lang=en). Organiser [FAQ](https://www.ticket.io/en/faq-event-organizer/).
- Other countries are **unknown**. US: not evidenced.

Priority is unchanged: **P2**, post-v1 / nice to have; **Required for v1:** No.

## Shared context

See the [baseline and verification rules](../shared-context.md). Coverage evidence dates to 2026-10-14; the sampled development requests below date to 2026-10-15. Neither establishes production behavior.

## Probe notes (2026-10-15)

| Item | Result |
| --- | --- |
| Event link | `duesseldorf-riesenrad.ticket.io/u3sUKR4N/?lang=en`: **200**, ~28 KB, title "Security check...". A **false stub** today |
| URL form | `{organiser}.ticket.io/{code}/` with an optional `?lang=`. Custom organiser domains are **unverified** |

## Scope

- `ticketio.ts`: recognise `*.ticket.io/{code}/` (lookalike-safe), canonicalised on the subdomain and code (ignore `lang`). `www.ticket.io` marketing pages are refused without a fetch.
- Detect the security-check page (by title or markup) as `access_restricted`, with a Ticket.io-specific message and the manual-details fallback ([#144](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/issues/144)).
- **Verification tasks:** readability from the production host, structured data, and dated versus open-dated products (the example is an attraction ride).

## Acceptance criteria

- [ ] Recognition tests: subdomain codes, `lang` variants, marketing pages and lookalikes.
- [ ] A saved "Security check..." fixture is `access_restricted` and never a stub.
- [ ] A **valid event page** fixture produces a stub with the title, local date, venue and city and `source: "Ticket.io"`, if a readable page is obtained.
- [ ] Saved **non-event, listing, blocked or error** fixtures give a specific outcome (refusal, `not_found`, or `access_restricted` with the manual-details fallback) instead of a stub.
- [ ] Offline in `npm test`.

## Validation plan / evidence required

Run `npm run lint`, `npm run typecheck`, `npm test` and `npm run build`. Offline tests use saved, sanitized fixtures and assert that no unexpected network request is made. Live checks happen only on Preview in live mode, with owner authorization. Before local completion, record the local implementation commit, fixture provenance and dates, and command results. A remote PR is not required by this local backlog. Creating this record does not claim implementation or passing tests.
