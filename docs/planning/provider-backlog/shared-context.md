# Provider backlog context

This is planned work, stored and committed locally. All entries are **P2: post-v1 / nice to have**, with **Required for v1: No**. Recording a provider does not implement support or make it a launch requirement. Commit locally; do not push or publish this backlog without a later user instruction.

## Implementation baseline

The previously inspected implementation is pinned to commit `3ded8581283ba0890b77659c996c1cee107c6cf9`, which remains the local application HEAD before this documentation change. At that baseline, Ticketmaster / Live Nation have a dedicated adapter and smoke coverage. Other URLs use generic page parsing in live mode; some already produce useful results.

- [Ticketmaster adapter](../../../src/customer/studio/research/ticketmaster.ts) and [smoke check](../../../scripts/smoke-ticketmaster.mjs).
- [Research route](../../../src/app/api/research/route.ts): bounded HTTP fetching, validated redirects, JSON-LD Event extraction and low-confidence title fallback. Its historical inspection recorded an 8-second timeout, a 2 MB cap and at most three redirects, without JavaScript execution.
- Generic extraction can mistake a listing's first Event node for the intended event. Continuous multi-day events preserve their full range; repeated performances need an explicit performance choice. Unrelated events on a listing should not become one stub.
- A timestamp's date must follow the event's local timezone. A date-only value must not be shifted as if it were UTC. A missing venue or date stays missing until the customer supplies it or a supported source verifies it.

Recheck the implementation before developing any entry. These references explain the backlog evidence; they are not a claim that each provider has been tested in production.

## Evidence rules

Each issue preserves its source and probe dates. The first 13 drafts contain observations from 2026-10-14; later drafts distinguish that research from any 2026-10-15 development requests. HTTP results depend on request location, headers and bot protections. A sampled rejection does not establish that all event URLs or the production host are blocked.

Official event venues establish observed geographic coverage. Organizer availability, headquarters, payment currencies and country selectors do not establish where listed events take place. Unknown regions remain unknown. Corporate ownership alone does not establish equivalent URL paths, redirects, identifiers or parsers.

Only public event metadata is in scope. Refuse irrelevant listing, marketing, checkout, account and error pages. Access restrictions receive a clear outcome and a manual-details fallback. No ticket purchase or account operation is part of these issues.

## Decisions and validation

RunSignup requires an owner decision about racing keepsakes. The same decision applies to race entries encountered on other providers. Undated attractions, movies, tours and non-event products have their own stated boundaries; a provider's catalog is not blanket approval for every product type.

For future implementation, use sanitized saved fixtures and focused offline tests for valid events, missing fields, listing pages, performance selection, redirects and errors. Do not invent dates or venues to satisfy an acceptance criterion. Record the local implementation commit and actual check results; no PR is required for local completion. The checks described inside individual issues are future implementation work, not checks executed by writing this backlog.

## Existing work

Historical GitHub references are retained for traceability: [#141](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/issues/141) covers bulk-link canonicalization and deduplication, [#144](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/issues/144) covers blocked-page outcomes, and [#151](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/issues/151) covers generic-parser regression cases. Their current remote status has not been refreshed. See the [local triage record](triage.md) for the evidence limits and proposed crosslinks.
