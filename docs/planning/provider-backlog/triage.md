# Local provider triage — 2026-10-15

All new records are **P2**, post-v1 / nice to have, and **Required for v1: No**. They are planned locally and have no new GitHub issue numbers. Implementation order should follow observed customer demand and the benefit of shared parser fixes. Geography alone does not determine priority.

## Preserved earlier work

The [historical inventory](previous-issues.md) contains #141–208: 67 provider/support issues and the bulk-paste issue. An offline comparison matched all 68 exported bodies to the independent snapshot's SHA-256 hashes; titles, states and labels also match. Every archived record has only `priority:P2` as its priority label and states Required for v1: No. Each of #142–208 has one geographic coverage section. [Audit results](evidence/offline-audit-2026-10-15.json) record these checks.

These records were captured on 2026-10-14. They are not a current remote audit. GitHub rejected access during the previous session; the current continuation performs no GitHub API calls, remote issue changes or publication. The user requires local commits. The preserved archive remains unchanged; the notes below are local triage findings.

## Corrections applied to the local drafts

- TicketSignup now requires the full observed October 16–18 range and leaves the venue unset when the fixture contains only Statesville as a city. RunSignup likewise preserves Cumming as a city without inventing a venue.
- Passline distinguishes dated Chile/Peru event evidence from the Bogotá city listing. Colombian dated event inventory remains unverified.
- NIGHTOUT populates the city only from verified page data, not from its URL slug.
- Events.com discovery paths, Tuboleta alternate hosts and Webtickets regional event paths require representative attendee URL verification before recognition is enabled.
- Ticketline cannot prefill date and venue from an unverified order-link slug.
- Tuboleta's attraction date matched the probe day. A rolling/generated date is a hypothesis to verify, not a conclusion from one sample.
- Unsupported market-leadership claims were removed. Placeholder references between the unpublished drafts were replaced with stable local IDs and relative links.
- Howler keeps event identity scoped to the host and full path until cross-host aliases are verified; equal short suffixes must not merge by themselves. Its sampled missing city stays unset.
- TicketSwap must verify event and resale-offer URL forms and a stable identity before deduplication; merged offers retain their source URLs.
- Prekindle's successful event-parsing criterion is gated on obtaining a readable, non-redirecting event fixture. The current sample proves a redirect-to-venue regression only.
- LOKET and Howler preserve continuous event ranges and ask for a choice only when distinct performances are present.

## Shared work and crosslinks

The relationships below are recorded locally; no comments have been posted in this continuation.

| Existing work | Local records to coordinate | Reason |
| --- | --- | --- |
| #141 bulk-link deduplication | [TicketSwap](issues/ticketswap.md), [NIGHTOUT](issues/nightout.md), [Events.com](issues/events-com.md) and other canonicalization tasks | Preserve event identity through verified redirects and aliases; do not merge distinct performances or IDs solely because providers share an owner. |
| #144 blocked-page outcomes | [Eventfinda](issues/eventfinda.md), [Passline](issues/passline.md), [TuEntrada](issues/tuentrada.md), [TicketSwap](issues/ticketswap.md), [Ticket.io](issues/ticketio.md), [Reservix / ADticket](issues/reservix-adticket.md), [SM Tickets](issues/smtickets.md) | Sampled challenges, blocked responses or queue-related outcomes. A JavaScript shell or missing data alone is not evidence of access blocking. |
| #151 generic-parser regression coverage | [TicketSignup](issues/ticketsignup.md), [NIGHTOUT](issues/nightout.md), [Ticketline](issues/ticketline.md), [Tuboleta](issues/tuboleta.md), [RunSignup](issues/runsignup.md), [Prekindle](issues/prekindle.md), [LOKET](issues/loket.md), [Howler](issues/howler.md) | Preserve valid event results, reject listings and error pages, and handle missing data and multiple dates. |
| #208 Punto Ticket | [Teleticket](issues/teleticket.md) | Sister-site links do not prove shared parsing. Compare fixtures before sharing rules. |
| #191 BookMyShow and #194 District | [Biletinial](issues/biletinial.md) | Reuse the recorded movie-scope decision, without assuming equivalent URLs. |
| #177 Quicket and #188 Sympla | [Howler](issues/howler.md) and [Ticket360](issues/ticket360.md) | Geographic overlap is not duplicate provider coverage. These remain distinct URL sources. |

The race-keepsake decision is owned by [PROVIDER-013: RunSignup](issues/runsignup.md) and also governs relevant [Webtickets](issues/webtickets.md) entries. It remains unresolved. Existing generic parsing does not settle that product decision.

## Provider-family checks

### TicketOne and #178 EVENTIM / See Tickets

[TicketOne's official company page](https://www.ticketone.it/campaign/en/aboutus), checked during the 2026-10-14 research, identifies it as part of CTS Eventim. Its [concert catalog](https://www.ticketone.it/events/concerti-55/?page=1) provides Italian event coverage. This establishes a corporate relationship and international Italy scope, not a verified attendee-host alias or shared parser.

Keep #178's existing EVENTIM / See Tickets scope intact. Track TicketOne as a local verification task: obtain an actual event URL, verify redirects and identifiers, inspect the page structure, then decide whether it needs a separate implementation record. Do not assume a `ticketone.it` event is already supported by #178.

### Weeztix / Eventix and #193 Weezevent

[Weezevent's acquisition announcement](https://weezevent.com/en-gb/blog/weezevent-acquires-kaboodle-weeztix/), checked during the 2026-10-14 research, describes Weeztix as formerly Eventix and states that the acquired businesses retain operational independence. The [Weeztix ticket-shop page](https://weeztix.com/ticketshop) establishes a product, not a specific attendee URL pattern.

#193 currently covers `my.weezevent.com` attendee pages. Treat Weeztix/Eventix as a separate unknown integration until a real attendee URL, redirect chain, identity mapping and page structure are verified. Headquarters and ownership do not establish additional event geography. No duplicate provider issue or alias rule has been created from this relationship alone.

## Continuation rules

Use the local manifest and issue files as the working backlog. Preserve historical evidence dates. Update local records and commit locally when work is completed; do not require a PR or remote issue closure for local progress. Any future GitHub publication requires a later user instruction and a fresh duplicate/status check. The original access restriction is not a reason to switch credentials or publishing routes.
