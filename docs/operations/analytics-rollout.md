# Analytics rollout (preview and production hosts)

The hosted rollout of GA4 product analytics for issue
[#39](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/issues/39), verified on 2026-10-11: where it
runs, how each host is configured, the procedure after every publish and its recorded proof, what was observed on
the hosts and in Google Analytics, the saved reports, the operational sample, ownership and the remaining
limitations. How analytics works, the event dictionary and the GA setup record are in [analytics.md](analytics.md);
earlier local-build evidence is in [analytics-live-validation.md](analytics-live-validation.md); the offline
journey suite is described in [analytics-journey-validation.md](analytics-journey-validation.md).

Redacted evidence files are in [`evidence/analytics-2026-10-11/`](evidence/analytics-2026-10-11/) (listed under
[Evidence](#evidence)).

**What this page is.** The verified baseline of the rollout at application commit `0f9baa5`. It stays valid as
history. The follow-up change that adds this record also contains one application fix (below); CI and review
approval for it are recorded on its pull request, and the **post-merge release proof** — the deployed commit, the
Preview restore after that publish and the hosted recheck — is attached to issue #39. **#39 is closed only after
that proof is attached.** This page does not invent the later commit or claim that proof in advance.

## Hosts and versions

| | Preview | Production |
| --- | --- | --- |
| URL | `https://gvk66o79l1.preview.c38.airoapp.ai/` | `https://getticketstub.com/` |
| Host | GoDaddy Plus Launch app `gvk66o79l1`, Preview | same app, Published |
| Application commit deployed | `0f9baa53506b4abe8a93646b0ea2e96175f99a08` | same |
| Health when verified | Healthy | Published tab healthy, infrastructure OK, site OK |

The hosted traffic observations below were collected at `0f9baa5`. Other work subsequently published main
`ae9a77a` (Neatlogs tracing and weekly backups); this follow-up includes that upstream work without changing it.
The current deployed release and its recheck are recorded on issue #39.

**Wall-view correction in the follow-up.** At `0f9baa5`, the tear flow's landing on `/wall?pinned=<id>` and the wall's
immediate cleanup to `/wall` count as two page views (seen in the phone journey below). The follow-up narrows the
in-memory page identity so that **only** the `pinned` parameter on `/wall` is ignored; any other wall query, any
other id or query, and back/forward still count as new views. It is covered by three unit regressions (they fail on
the old code and pass on the fix) and by the offline ordering check. It must be deployed after review and merge,
followed by the Preview restore and a hosted recheck; the baseline evidence predates this correction. Documentation, offline tooling, tests and CI need no runtime
deploy. The release proof on #39 records the deployment of the application fix.

Unchanged by the rollout: the existing live AI runtime setting (`TICKETSTUB_RUNTIME_MODE=live`, so events carry
`runtime_mode=live`), sandbox commerce and its `capability=sandbox` provenance, and every unrelated key, storage
setting and DNS record.

## Host configuration

Only the analytics and operational-logging settings are listed; they are public configuration, not secrets. No other
host setting is recorded here. The table records the initial baseline configuration. Subsequent main-branch work
added optional Neatlogs export and backups; preserve their existing settings and restore only the four Preview
overrides below after publication.

| Setting | Preview | Production |
| --- | --- | --- |
| `TICKETSTUB_ANALYTICS_ENV` | `preview` | `production` |
| `TICKETSTUB_GA_MEASUREMENT_ID` | `G-M2ELMGCNKW` | `G-RVV7ZNF463` |
| `TICKETSTUB_GA_DEBUG` | `1` (DebugView) | `0` |
| `TICKETSTUB_OPS_TELEMETRY` | `log` | `log` |
| `TICKETSTUB_OPS_ENVIRONMENT` | `preview` | `production` |

The old tag on the domain (`G-YBRK8129PK` / `GT-M3L6XD84`) is not used; no request to it was observed from either
host. Changing these settings needs a restart, not a rebuild ([analytics.md](analytics.md#configuration-and-environments)).

## After every publish: restore and verify Preview

**Publishing copies all production settings into Preview, overwriting Preview's own values.** Without a restore,
Preview runs with the production id and `TICKETSTUB_ANALYTICS_ENV=production` and sends test traffic to the
production property. After **every** publish:

1. In the hosting dashboard, open Preview's settings. Change only the four public Preview overrides:
   `TICKETSTUB_ANALYTICS_ENV=preview`, `TICKETSTUB_GA_MEASUREMENT_ID=G-M2ELMGCNKW`, `TICKETSTUB_GA_DEBUG=1`,
   `TICKETSTUB_OPS_ENVIRONMENT=preview`.
2. **Two saves:** mark the four copied entries for deletion and **Save**; then add the Preview values and **Save**
   again. Deleting and adding the same names in a single save lost the new values.
3. **Restart Preview.**
4. **Verify both hosts** in fresh browser sessions ([checks](#verification-on-each-host)): Preview sends only
   `G-M2ELMGCNKW`, `deployment_env=preview`, debug on; production sends only `G-RVV7ZNF463`,
   `deployment_env=production`, debug off.
5. Do not bulk-sync settings between Preview and production, and do not open, copy or reveal unrelated secrets.

**Recorded proof (2026-10-11).** Production was published; the publish copied the production settings into Preview.
The four Preview overrides were restored in two saves exactly as above and Preview was restarted. Fresh requests
then showed Preview sending only `G-M2ELMGCNKW` with `deployment_env=preview` and debug true, and production sending
only `G-RVV7ZNF463` with `deployment_env=production`, debug false and consent state `gcs=G101` (analytics granted,
ads denied). A production `/make` reload after the Preview restore was still correct.

**Consequence recorded:** between the publish and the restore, Preview briefly sent synthetic QA traffic to the
**production** property. It was not purged. Production data from 2026-10-11 therefore includes QA traffic and is not
an organic baseline.

## Verification on each host

In a fresh browser profile with the network panel open, after every publish or settings change. Record results
without client ids, session ids, IP addresses, prompts, share tokens or real stubs.

1. First visit, "No thanks" with reload, and after withdrawal with reload: **0** requests to Google hosts.
2. After "Allow analytics": `gtag/js` and `collect` requests carry only the host's id, its `deployment_env` and, on
   Preview only, debug mode; consent state `gcs=G101`.
3. URLs with synthetic private query values and token routes: decoded request URLs and bodies contain only route
   templates (`/make`, `/studio/:id`, `/s/:token`).
4. No request to the old tag.
5. Stored data: Preview DebugView or production Realtime shows the events. A `204` response alone is not proof of
   storage.

## Hosted verification, 2026-10-11

Done in Chrome against both hosts at application commit `0f9baa5`. Only fixture flows were started; no paid provider
request was made for these checks.

### Consent and privacy (both hosts)

| Check | Preview | Production |
| --- | --- | --- |
| Before a choice, after "No thanks", after reload, after withdrawal: Google requests | 0 | 0 |
| Requests after "Allow" use only this host's id and environment | `G-M2ELMGCNKW`, `preview`, debug true | `G-RVV7ZNF463`, `production`, debug false, `gcs=G101` |
| Private values removed from `page_location` | Host share token removed; `/studio/:id` and `/s/:token` normalized | Synthetic email and token removed from `/make` |
| Requests to the old tag | None | None |

### Phone journey (390 × 844, hosted Preview)

A fixture creation (Harbour) produced, in order: `creation_complete` with `result=created`, `storage=ok` →
`studio_open` with `status=ready` → exactly one `tear_complete` with `storage=ok` → `wall_view` with `state=loaded`.
At `0f9baa5`, the accepted wall `push` (with a pinned query) and the following `replace` that cleans the query are
two accepted navigations, so they produce two manual page views; no single history change produced two. This is the
behaviour the [undeployed runtime fix](#hosts-and-versions) changes to one view; this recorded journey is baseline
evidence and stays as observed. GA DebugView stored the
phone events; the opened `creation_complete` showed `deployment_env=preview` and the sanitized
`page_location=https://gvk66o79l1.preview.c38.airoapp.ai/make`.

### Desktop journeys (hosted Preview, after the restore)

- Reopening a demo stub was reported truthfully as a reopen: `intake_submit` `result=reopened` and
  `creation_complete` `result=reopened`, `storage=ok`. This is not a new activation.
- `studio_open` `status=ready`; a committed style edit with `storage=ok`.
- Share page → `share_landing` with the sanitized `/s/:token`.
- Organizer: sample CSV parsed → mapping `auto` → check → generic claim link published **locally**
  (`organizer_publish` `result=local`) → `claim_view` `result=valid`, `flow=organizer` → `claim_complete`
  `result=claimed`, `storage=ok`, `flow=organizer` → a valid share landing.
- The seeded synthetic guest, title, organizer name, note, sample file name and guest names were absent from the
  decoded Google payloads.
- No sign-in or email delivery was exercised or is claimed.
- A desktop tear was validated in the earlier local-build session, not on the host after the restore. The phone tear
  above is the hosted activation evidence. The offline suite covers the full tear at both sizes.

Sandbox checkout privacy on the host was checked in the earlier local-build session
([analytics-live-validation.md](analytics-live-validation.md)). Error paths (blocked tag, failed storage, provider
failure, quote expiry and similar) are covered by the offline suites, not injected on the live hosts.

### Stored data in Google Analytics

| Property | Observation (snapshot) |
| --- | --- |
| Preview, DebugView | 128 stored events in the last 30 minutes, including `page_view` 17, `studio_open` 4, `creation_complete` 3, `tear_complete` 1, `organizer_csv`, `organizer_mapping`, `organizer_check`, `organizer_publish` 1 each, `claim_complete` 1 |
| Production, Realtime | 2 active users in the last 30 minutes (1 in the last 5); `page_view` 12, `web_vital` 25, `server_save` 6; key event `tear_complete` 1 |

These counts include QA traffic. They are snapshots, not an organic baseline, user counts or identity. Standard reports
default to the last 28 days and exclude today, and newly registered custom dimensions start empty until data is
processed, so historical custom reports were not yet populated on 2026-10-11. That is expected and not claimed
otherwise.

## Google Analytics configuration (both properties)

- 31 event-scoped custom dimensions and 2 custom metrics ([list](analytics.md#reporting-definitions-registered-both-properties)).
- Enhanced measurement **off** on both streams. Preview's had been found on after the earlier setup; it was turned off
  on 2026-10-11 and confirmed after an uncached reload, and again in a fresh readback of the saved Preview stream
  (`16107767122`, `G-M2ELMGCNKW`, "Receiving traffic in past 48 hours"). Production was confirmed off.
- No Measurement Protocol API secrets and no connected site tags on the streams.
- Retention two months for events and users, activity reset off. Google signals, user-provided data, granular
  location/device and ad personalization off; data redaction on ([analytics.md](analytics.md#settings-read-back-after-saving)).
- Key event `tear_complete`, no default value. The app never emits `purchase`.

### Filters: decision

- *TicketStub developer QA* (developer traffic, exclude) is in **Testing** on both properties. In Testing a filter
  **labels** matching traffic (visible through the *Test data filter name* dimension) and **does not exclude** it.
- The default *Internal Traffic* filter is in **Testing** with **no IP definition**.
- **IP-based internal filtering is deferred by the owner** ("skip this, deferred or not planned"). It is a recorded
  decision, not remaining rollout work.
- No filter was activated: activation permanently drops matching data. QA isolation relies on the separate Preview
  property and on `debug_mode`; production reports may include QA traffic, as recorded above.

## Saved reports

**13 views in three saved Explorations workspaces**: 12 in production (two workspaces, because GA limits a workspace
to 20 dimensions and 10 tabs) and one QA view in Preview. All are persisted and shared **read-only** with the existing
property users. The definitions below were re-read after saving.

Standard reports and explorations default to the **last 28 days, which excludes today**, and newly registered
dimensions start empty until data is processed. Empty tables on 2026-10-11 are expected; stored ingestion was
verified in DebugView and Realtime instead ([stored data](#stored-data-in-google-analytics)).

**Reading metrics.** The two custom metrics aggregate as a **sum**: tables show totals, not averages or percentiles.
For an average duration, divide the *Action duration* total by the count of events that carry `duration_ms`, within
one event name. Never add *Web vital value* across metric names: CLS is stored × 1000, the other vitals are
milliseconds ([dictionary](analytics.md#event-dictionary-schema-v1)). Percentiles (p50/p95) are not available in
these tables; the operational report tool computes them for server timings.

### Workspace 1 (production): *TicketStub — Product, performance and reliability*

[Open (authenticated)](https://analytics.google.com/analytics/web/#/analysis/a393449895p558390557/edit/Av3dyeWwQDiwdKWmhrkh7Q) ·
10 tabs · every tab filters *Deployment environment* = `production` · the six funnels break down by *Device category*

| # | Tab | Type | Definition |
| --- | --- | --- | --- |
| 1 | Activation | Funnel, **closed**, elapsed time on | `intake_submit` → `creation_complete` (`result=created` AND `storage=ok`) → `studio_open` (`status=ready`) → `tear_complete` (`storage=ok`) → `wall_view` (`state=loaded`). The 30-minute limit applies **to each adjacent step**, not to the whole funnel |
| 2 | Sandbox commerce | Funnel, closed | `add_to_cart` → `view_cart` → `begin_checkout` → `add_payment_info` → `sandbox_order` (`result=placed`). Sandbox: not sales, no revenue |
| 3 | Acquisition | Funnel, open | `page_view` (`route_template=/`) → `intake_submit` → `creation_start` → `creation_complete` (`result=created`, `storage=ok`) |
| 4 | Organizer | Funnel, open | `organizer_step` (`step=design`) → `organizer_csv` (`result=parsed`) → `organizer_check` → `organizer_publish` (`result=server`) → `claim_complete` (`flow=organizer`, `result=claimed`, `storage=ok`). **Server-published branch only**: a local publish (`result=local`) is not a failure, it is outside this branch by design |
| 5 | Sharing → visitor claim | Funnel, open | `share` (`result=success`) → `share_landing` (`result=valid`, `viewer=visitor`) → `claim_complete` (`result=claimed`, `storage=ok`) |
| 6 | Sharing → new creation | Funnel, open | `share` (`result=success`) → `share_landing` (`result=valid`, `viewer=visitor`) → `creation_complete` (`result=created`, `storage=ok`) |
| 7 | Studio adoption | Free form | Rows: Event name, Studio change, Design edition, Material, Finish. Columns: Action result, Capability provenance. Metric: Event count. Event name matches exactly `^(studio_.*\|remix_.*\|agent_.*\|photo_add\|note_edit)$` |
| 8 | Research and reveal | Free form | Rows: Event name, Action result, Bounded error code, Reveal skipped, Runtime mode. Metrics: Event count, Action duration. Event name matches `^(research_complete\|reveal_complete\|creation_error)$` |
| 9 | Performance | Free form | Rows: Event name, Web vital name, Web vital rating, Route template, Device category. Metrics: Event count, Web vital value, Action duration. Event name matches `^(web_vital\|route_timing)$` |
| 10 | Reliability | Free form | Rows: Event name, API endpoint, Action result, Storage area, Storage operation. Columns: Bounded reason, Response class. Metrics: Event count, Action duration. Event name matches `^(api_call\|storage_failure\|server_save)$` |

### Workspace 2 (production): *TicketStub — Acquisition sources and studio panels*

[Open (authenticated)](https://analytics.google.com/analytics/web/#/analysis/a393449895p558390557/edit/GaXZgiIzTLKXKqNcqZ0uyw) ·
2 tabs · both filter *Deployment environment* = `production`

| # | Tab | Type | Definition |
| --- | --- | --- | --- |
| 11 | Acquisition sources | Free form | Rows: Event name, Entry point, First user source / medium, Device category. Columns: Action result, Capability provenance. Metric: Event count. Event name matches `^(intake_submit\|creation_start\|creation_complete\|creation_error\|search_results\|select_item)$` |
| 12 | Studio panels — open and close | Free form | Rows: Event name, Studio panel, Device category. Columns: Panel opened, Runtime mode. Metric: Event count. Event name matches `^studio_panel$` |

### Workspace 3 (preview): *TicketStub — Preview journey validation*

[Open (authenticated)](https://analytics.google.com/analytics/web/#/analysis/a393449895p558454273/edit/l8CVmZWzQKGhGYVmx9TASw) ·
1 tab · a QA view, not a mirror of the production tabs

| # | Tab | Type | Definition |
| --- | --- | --- | --- |
| 13 | QA — event outcomes and safe routes | Free form | Rows: Event name, Action result, Storage outcome, Route template, Device category. Metric: Event count. Filter: *Deployment environment* exactly `preview`. Editor status, Flow state, Capability provenance and Runtime mode are imported as variables for drill-down but not applied to the table |

**Checked against the event catalog (schema v1).** Every event name and registered dimension used in the 13 views
exists. Corrections made in GA after the first save and re-read: tab 11 now filters `search_results` (the earlier
`search_complete` matched no event); tab 12 no longer has an *Action result* row (`studio_panel` has no `result`);
tab 7's pattern no longer lists `fact_.*`, `version_select` and `art_.*` (which matched nothing) and now includes
`photo_add` and `note_edit`. Tab 12 now uses the registered *Panel opened* (`open`) boolean and the common
*Runtime mode* instead of the absent `capability` parameter, so opens and closes are counted separately.

Limits that apply to every view: funnels count browsers (GA client ids), not people. A share opened in another browser
is a different user, so the sharing funnels show volumes by step, not linked people. There is no identity or
cross-device linkage.

## Operational sample (production, 2026-10-11)

The production operational log (`TICKETSTUB_OPS_TELEMETRY=log`, schema `ticketstub.ops/1`) captured **7 records
between 19:43:34Z and 19:46:51Z**, summarized locally into sanitized aggregates with the report tool
([analytics-ops-reporting.md](analytics-ops-reporting.md)). Raw lines and their ids are not kept in the repository.
This was existing traffic on the host, not generations started for the rollout. **A sample this small is not a
baseline: it is not an SLO, a p95 or a cost estimate.**

| Operation | Requests | Outcome | Latency |
| --- | --- | --- | --- |
| Research, link | 1 | Rejected, 422 `unreadable_link` | 157 ms |
| Research, search | 2 | Success, 200, fixture (simulated) results | 14 ms and 15 ms |
| Art, generate | 1 | Success, 200, from the provider (2 provider attempts) | 33,059 ms |

One event-page source fetch in the same window ended with a network error (124 ms); the summary does not link it to a
specific request.

| Provider attempt (art, OpenRouter, `openai/gpt-image-2`) | Latency | Tokens | Cost |
| --- | --- | --- | --- |
| Model check | 868 ms | not reported | **unknown** (not reported; not zero) |
| Generation | 32,121 ms | 1,546 (174 in, 1,372 out) | USD 0.04203, provider-reported, **not billed spend** |

**No new analytics export service.** The bounded log and local summary suffice for this rollout. Upstream
[#46](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/pull/46) separately added optional content-free
[Neatlogs tracing](observability.md#neatlogs-traces), preserved by this change. The summary tool works alongside
that existing sink. No GA warehouse, advertising or session replay service was added; existing host settings for
other operations are preserved when restoring the four Preview analytics overrides.

## Ownership and access

- **Accountable owner:** CompleteTech LLC, through its existing authenticated admin account. In Google Analytics the
  workspaces show the owner as *Complete Tech*. Deployments on the hosting app were made by the existing deployer
  account. This record names no individual person.
- **Access (read-only review, 2026-10-11):** Property Access Management on **both** properties lists exactly one
  user, *Complete Tech*, with the Administrator role. No access was granted and no role changed during the rollout;
  the saved workspaces are shared read-only with existing property users only. (The account's email address is not
  published here.)
- **Review cadence:** review property and hosting access **quarterly**, and whenever personnel or a provider changes.
  Each review re-checks enhanced measurement (off), the filter states and the Preview overrides.

## Evidence

In [`evidence/analytics-2026-10-11/`](evidence/analytics-2026-10-11/), added by the project owner from the 2026-10-11
checks. Redacted: no client ids, session ids, IP addresses, prompts, share tokens, real stubs or secrets. The JSON
files hold only request fields such as the measurement id (`tid`), event name (`en`), template location (`dl`),
consent state (`gcs`) and the `ep.*` labels. The traffic JSON and deployment snapshot are evidence of `0f9baa5`. GA administration screenshots show saved
configuration independent of an application commit. The 390 × 844 intake screenshot was captured after upstream
`ae9a77a` was published; it proves the layout, not the wall-view correction. Fixed release proof goes to issue #39.

| File | Shows |
| --- | --- |
| `phone-events.json` | Hosted Preview phone journey (390 × 844): the request sequence of the activation, including the two `/wall` page views of the baseline |
| `desktop-events.json` | Hosted Preview desktop journeys after the restore: reopen, studio, sharing, organizer and claim |
| `production-after-preview-restore.json` | Production `/make` requests after the Preview restore: `G-RVV7ZNF463`, `deployment_env=production`, `gcs=G101` |
| `production-deployment.jpg` | Production deployment health and the deployed commit |
| `preview-phone-intake.jpg` | The Preview intake screen at 390 × 844, with the *Analytics* reopen tag; phone journey payloads are in `phone-events.json` |
| `google-preview-debugview.jpg` | Preview DebugView with the stored events |
| `google-preview-stored-environment.jpg` | A stored Preview event showing `deployment_env=preview` |
| `google-preview-stored-page.jpg` | A stored Preview event showing the sanitized `page_location` |
| `google-preview-enhanced-off.jpg` | The saved Preview stream with enhanced measurement off |
| `google-preview-report.jpg` | The saved Preview QA exploration (tab 13); empty for the default 28 days, which excludes today |
| `google-production-realtime.jpg` | Production Realtime snapshot |
| `google-production-source-report.jpg` | Production source report |
| `google-production-panel-report.jpg` | Saved panel open/close and runtime grouping |
| `google-production-activation-report.jpg` | The saved production Activation funnel (tab 1); empty for the default 28 days, which excludes today |

Evidence rules for any later addition: summarize network evidence (host, id, parameter names, template locations,
response codes) instead of attaching raw traces, and crop or redact screenshots to the same standard.

## Reproduce

```sh
npm ci
npm run lint && npm run typecheck
npm test                                     # 282 unit tests after integrating main ae9a77a
npm run build
node scripts/check-analytics-order.mjs       # 43 ordering and page-context checks (33 before the wall fix), offline
node scripts/check-analytics-journeys.mjs    # 281 journey checks (140 phone, 141 desktop), offline
```

Recorded on Node 22 with a fresh production build that includes the runtime fix: lint and typecheck clean, 282 unit
tests, 43 ordering checks and 281 journey checks passed with none failing. The journey run used 73 (phone) and 72
(desktop) real pointer clicks on visible, uncovered controls and no form `requestSubmit`, direct DOM clicks or
programmatic fallbacks. It still drives warm navigation through the app router and history and runs in browser
emulation with mocks: it is not a visual or mobile usability certification
([analytics-journey-validation.md](analytics-journey-validation.md)). CI runs all of these
(`.github/workflows/runtime.yml`); its result and the review approval for the exact head are recorded on the pull
request. Hosted checks: follow [Verification on each host](#verification-on-each-host).

## Limitations

- The historical `0f9baa5` sample counts two views for one tear-flow wall landing. The follow-up corrects it;
  current release deployment and hosted verification are recorded on issue #39.
- **Production data from 2026-10-11 includes synthetic QA traffic** (the Preview settings copy above, and QA on the
  host). No purge; no organic baseline is claimed.
- **No IP-based internal filter**, a decision by the owner; filters are in Testing and label QA traffic without
  excluding it.
- Historical custom reports were not yet populated on 2026-10-11 (default range excludes today; newly registered
  dimensions); stored-data evidence is DebugView and Realtime.
- The two custom metrics are sums; GA tables give no percentiles.
- Hosted checks covered the journeys listed; other customer flows and error paths are covered offline, not injected
  on the live hosts. Sign-in and email delivery were not exercised on the hosts. The offline journeys are not a
  visual or usability certification.
- Publishing overwrites Preview's settings; the procedure above must be repeated after every publish.
- Commerce is a sandbox and wallet passes are simulated: there is no `purchase`, revenue or pass issuance, and
  sign-in choices are not identity assertions. Confirmed sign-in is a separate server boundary; GA does not link
  people across devices. Authoritative purchase and pass issuance require their real provider boundaries; these
  are product limitations, not incomplete analytics work.
- Ad-blockers and visitors who decline consent are not measured, by design.
