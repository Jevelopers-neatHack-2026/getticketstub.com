# Resident Advisor acceptance review (#155)

Reviewed 2026-10-21 after the shared fallback shipped in [#216](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/pull/216), merge `67df96fde58b600af6850f4b2431e406fcb21f8c`. This review reuses that implementation. Its only runtime addition is recognition of the two locale hosts verified below.

## Host and access decision

The recognised main/legacy hosts are `ra.co`, `www.ra.co`, `residentadvisor.net` and `www.residentadvisor.net`. [de.ra.co/terms](https://de.ra.co/terms) and [ja.ra.co/terms](https://ja.ra.co/terms) served official Resident Advisor terms when reviewed on 2026-10-21. These provide evidence for the exact `de.ra.co` and `ja.ra.co` hosts; they do not establish arbitrary subdomain support or successful event-page retrieval. The existing exact-host registry is extended with those two hosts, without enabling wildcard matching.

The current [main terms](https://ra.co/terms) describe restrictions on automated commercial extraction in 4.4(a) and unauthorised automated access in 4.4(f). The German page identifies the same operator and wording; the Japanese page's general condition 3 prohibits automated collection. This corrects the earlier support-matrix reference to 3.2(f).

**Dated technical disposition: fallback only.** Do not fetch recognised RA event links, use private API/GraphQL endpoints, solve a CAPTCHA, or add a Herald integration. No new access agreement or official API entitlement is claimed. An owner-authorised request for data access would be separate work. Terms-page availability does not imply permission to scrape events or a legal clearance.

## Acceptance evidence

| #155 criterion | Implementation and verification |
| --- | --- |
| Recognise main, legacy, verified locale, query-string and non-event variants; reject lookalikes | `research/access.ts` has explicit roots and numeric `/events/{id}` matching. `research-access.test.mjs` covers main/legacy/locales, casing, a trailing dot, queries, unknown subdomains and deceptive suffixes. |
| RA-specific fallback; no RA fetch or retry; preview behavior explicit | The research route returns the shared `manual_event` descriptor before dispatch in live mode. The throwing transport spy proves zero calls for supported event hosts and for refused non-event/private paths. Preview stays `demo_only`, with zero calls. |
| DataDome 403 classified before parsing | The labelled synthetic DataDome fixture exercises the shared classifier independently of the RA shortcut; the route test checks `access_restricted`, no parser event and one attempt. The fixture is not represented as a captured RA response. |
| Browser link and accessible manual entry | The shared `ManualEvent` form uses the validated response descriptor and a native link with `noopener noreferrer`. The locale tests check that the destination host/path survives and tracking query/fragment do not. `check-manual-entry.mjs --ra-host HOST` verifies the shared form on `/make` and `/new`, at 390px and 1280px, including labels, focus, scoped WCAG A/AA checks, unobstructed submit and saved `customer` provenance. CI runs all three verified RA hosts (12 scenarios). |
| Terms/access decision and excluded integrations | The dated disposition above and `docs/support-matrix.md` record the official sources. Route tests refuse `/api/events` and `/graphql` on recognised hosts without requests; the implementation adds no RA adapter, alternate transport or third-party dependency. |
| Reuse the parent implementation and retain evidence | #216 implements #144; this review keeps its registry, descriptor, form, validation and customer provenance. Run the existing focused route tests and browser check, and record the final PR revision/check results on #155. |

The original [contributor block report](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/issues/155#issuecomment-6308518867) remains attributed evidence from 2026-10-20. It is not a new probe by this review. No normal user browser's successful RA access, paid upstream call or deployed Preview/production behavior is asserted.
