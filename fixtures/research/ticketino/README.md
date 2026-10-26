# TICKETINO offline regression inputs

These HTML files are **synthetic regression fixtures**, not saved live provider responses.

The CH fixture preserves the title, start date, venue, locality, country and encoded MIME form described in issue [#180](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/issues/180), whose observations are dated 2026-10-14. The end date is the date-range scenario described there; it is not a newly verified provider value. The DE and AT dates, titles and venue names are deliberately synthetic, with country/locality scenarios taken from the issue. Non-event fixtures exercise the expected catalogue refusal and do not claim to reproduce current provider HTML.

On 2026-10-25, read-only revalidation was attempted with curl, the app user agent `TicketStubResearch/0.1 (+https://getticketstub.com; event research for personal keepsakes)`, its Accept header and a three-redirect limit for:

- `https://www.ticketino.com/de/Event/Zurich-Wine-Festival/217466`
- `https://www.ticketino.com/de/Event/Fame-Fight/217797`
- `https://www.ticketino.com/de/Event/Comic-Con-Dornbirn-2027/214753`

All returned curl exit 56, `CONNECT tunnel failed, response 403`, HTTP transfer status `000`, and zero downloaded bytes. No alternative access route was attempted. Current real-page CH/DE/AT fixtures and authorized Preview checks remain prerequisites to closing #180. No credentials, private event data, live model requests, purchases or deployments were involved.

URL normalization retains a verified public event path for fetching and source attribution and removes tracking data. `canonicalId` is `ticketino:event:<numeric id>` across slugs and languages; no unverified numeric-only fetch endpoint is invented. JSON-LD must describe exactly one dated event. Groups, categories, shells, wrong event identities and redirects outside that event are refused. Country is retained as a sourced fact without claiming coverage beyond the tested fixture scenarios.
