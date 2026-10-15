# Local provider backlog

This backlog contains **23 planned provider records**, all **P2: post-v1 / nice to have**, with **Required for v1: No**. It combines 13 saved, unpublished drafts with 10 additional candidates. These are local issue records, not implemented integrations or published GitHub issues. `PROVIDER-001` through `PROVIDER-023` are local IDs.

**Local-only workflow:** edit and commit here; do not push or publish without a later user instruction. The [manifest](manifest.json) is the machine-readable index. It records evidence dates and deliberately leaves every GitHub issue number unset. The application baseline is `3ded8581283ba0890b77659c996c1cee107c6cf9`.

## Provider records

“International” means observed or stated coverage outside the United States; each record identifies countries and the evidence limits. Geography does not prove parser support. Research dates are preserved in the individual records, principally 2026-10-14 with additional development probes on 2026-10-15.

| Local ID | Provider | Geographic evidence / limits | Priority |
| --- | --- | --- | --- |
| PROVIDER-001 | [Events.com](issues/events-com.md) | US verified; international ticket inventory unverified. | P2 |
| PROVIDER-002 | [TicketSignup](issues/ticketsignup.md) | US verified. International inventory unknown. | P2 |
| PROVIDER-003 | [NIGHTOUT](issues/nightout.md) | US plus international. Verified: United States and Canada (Toronto). | P2 |
| PROVIDER-004 | [Ticketsolve](issues/ticketsolve.md) | international, non-US. Verified operator footprint: United Kingdom and Ireland. Venue inventory: to sample. | P2 |
| PROVIDER-005 | [Ticketline](issues/ticketline.md) | international, non-US. Observed event inventory: United Kingdom. | P2 |
| PROVIDER-006 | [Eventfinda](issues/eventfinda.md) | international, non-US. Verified: New Zealand and Australia. | P2 |
| PROVIDER-007 | [Passline](issues/passline.md) | international; Chile and Peru event inventory observed. Colombia city listing only; dated events unverified. | P2 |
| PROVIDER-008 | [TuEntrada](issues/tuentrada.md) | international, non-US. Observed event inventory: Argentina. | P2 |
| PROVIDER-009 | [Teleticket](issues/teleticket.md) | international, non-US. Observed event inventory: Peru. | P2 |
| PROVIDER-010 | [Tuboleta](issues/tuboleta.md) | international, non-US. Observed event inventory: Colombia. | P2 |
| PROVIDER-011 | [Webtickets](issues/webtickets.md) | international, non-US. Official country catalogues: South Africa, Namibia, Botswana, Malawi. | P2 |
| PROVIDER-012 | [Computicket](issues/computicket.md) | international, non-US. Observed event inventory: South Africa. | P2 |
| PROVIDER-013 | [RunSignup](issues/runsignup.md) | US verified. International inventory unknown. | P2 |
| PROVIDER-014 | [Prekindle](issues/prekindle.md) | US verified: United States; other countries unverified. | P2 |
| PROVIDER-015 | [TicketSwap](issues/ticketswap.md) | US plus international: United States, Netherlands. | P2 |
| PROVIDER-016 | [Ticket.io](issues/ticketio.md) | International, non-US: Germany. | P2 |
| PROVIDER-017 | [Reservix / ADticket](issues/reservix-adticket.md) | International, non-US: Germany, Austria. | P2 |
| PROVIDER-018 | [LOKET](issues/loket.md) | International, non-US: Indonesia. | P2 |
| PROVIDER-019 | [SM Tickets](issues/smtickets.md) | International, non-US: Philippines. | P2 |
| PROVIDER-020 | [Ticket2Me](issues/ticket2me.md) | International, non-US: Philippines. | P2 |
| PROVIDER-021 | [Biletinial](issues/biletinial.md) | International, non-US: Türkiye. | P2 |
| PROVIDER-022 | [Ticket360](issues/ticket360.md) | International, non-US: Brazil. | P2 |
| PROVIDER-023 | [Howler](issues/howler.md) | International, non-US: South Africa, Namibia. | P2 |

## Earlier issues and triage

The [earlier issue inventory](previous-issues.md) and [full body archive](evidence/github-issue-bodies-2026-10-14.json) preserve the 68 captured GitHub issues: bulk pasting (#141) and 67 provider/support records (#142–208), including Luma (#142). Their body hashes, titles, labels and states match the independent [2026-10-14 fingerprints](evidence/github-issues-2026-10-14.json). All were OPEN and P2 in that capture; their current remote state has not been refreshed.

The [triage record](triage.md) documents corrections, related work, evidence limits and two further verification candidates: **TicketOne (Italy)** and **Weeztix / Eventix (event geography unverified)**. They are verification tasks under the existing EVENTIM / See Tickets and Weezevent work, pending actual URL and parser evidence; ownership does not establish integration equivalence.

The [offline audit](evidence/offline-audit-2026-10-15.json) records the historical priority and geography checks. Historical bodies are retained verbatim, while current local corrections live in the triage record and these new drafts.

## Working on an entry

Read the [shared context and verification rules](shared-context.md) before implementation. Keep missing data unset, distinguish continuous multi-day events from separate performances, and verify aliases before merging event identities. RunSignup retains an unresolved product decision about racing keepsakes. Fixture and command requirements in each draft apply to future implementation; writing the backlog does not fulfill them.

Update local status and record the local implementation commit and actual validation results when work is complete. No remote PR or GitHub issue closure is required for this local workflow.
