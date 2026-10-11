# Product analytics (GA4)

Browser product analytics for the TicketStub customer app (issue
[#39](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/issues/39)): configuration, consent,
page views and URL sanitization, the versioned event dictionary, Google Analytics administration,
reporting definitions, QA and rollback. Server operational measurement is a separate system with its own
policy: [observability.md](observability.md). The stub lifecycle event log (`ticketstub.event/1`) is in
[../architecture/events.md](../architecture/events.md).

## Status

As of 2026-10-11. The hosted rollout record, its procedural proof, the saved reports and the evidence index are in
[analytics-rollout.md](analytics-rollout.md). Final release approval for the rollout follow-up is recorded on its PR.

| | State |
| --- | --- |
| Catalog, runtime validation, URL sanitization, consent, GA4 adapter, page views, Web Vitals, route timing | Implemented; deployed on both hosts at application commit `0f9baa5`. The `/wall?pinned` fix is verified offline; the current release commit, deployment and hosted verification are recorded on issue #39 ([details](analytics-rollout.md#hosts-and-versions)) |
| Offline checks (no network, synthetic id) | `npm test` 282 unit tests after integrating main `ae9a77a` (257 implementation +11 ops report +3 wall page-view +11 upstream checks), `scripts/check-analytics-order.mjs` 43 checks and `scripts/check-analytics-journeys.mjs` 281 checks (140 phone, 141 desktop), recorded on Node 22; all wired into CI (`.github/workflows/runtime.yml`), whose result is recorded on the pull request |
| GA4 properties, web streams, privacy settings | Separate production and preview properties; enhanced measurement off on both (preview's was found on again, corrected on 2026-10-11 and re-read on the saved stream); no Measurement Protocol secrets or connected tags; redaction on; signals, user-provided data, granular location/device and ad personalization off ([record](#ga4-setup-record)) |
| Custom definitions | 31 event-scoped dimensions, 2 metrics and key event `tear_complete` (no default value) on both properties |
| Data retention | Two months for events and users, activity reset off, both properties |
| Data filters | *TicketStub developer QA* and the default *Internal Traffic* filter in **Testing** (they label, they do not exclude). IP-based internal filtering **not planned** (closed by the owner) ([decision](analytics-rollout.md#filters-decision)) |
| Saved reports | 13 views in three read-only shared workspaces: 12 in production, 1 QA view in Preview; definitions re-read after saving, checked against the catalog ([definitions](analytics-rollout.md#saved-reports)) |
| Host configuration | Preview `G-M2ELMGCNKW` (debug on), production `G-RVV7ZNF463`; after-publish restore of Preview done and verified ([procedure and proof](analytics-rollout.md#after-every-publish-restore-and-verify-preview)) |
| Hosted checks | Consent (0 requests before a choice, after denial, reload and withdrawal), ids per host, private-value removal, phone activation, desktop sharing/organizer/claims ([record](analytics-rollout.md#hosted-verification-2026-10-11)) |
| GA stored data | Preview DebugView stored the hosted events (128 in 30 minutes, with `deployment_env=preview` and sanitized `page_location`); production Realtime showed live events including key event `tear_complete`. Counts include QA traffic |
| Ownership and access | CompleteTech LLC (existing admin account). Read-only review on 2026-10-11: each property has exactly one user, *Complete Tech*, Administrator; no grants or role changes. Reviewed quarterly and on personnel or provider changes ([ownership](analytics-rollout.md#ownership-and-access)) |

## Architecture

All code is in `src/customer/analytics/`. Product code needs one import.

| Module | Role |
| --- | --- |
| `track.ts` | Public API: `track(name, params)`, `trackOnce(key, name, params)`, `toMajorUnits(minor)`. Never throws, never awaits, no-op on the server |
| `catalog.ts` | The single, versioned event catalog (`SCHEMA_VERSION = 1`): every event, its parameters as closed enums / bounded integers / money / booleans, runtime-stamped truth values, forbidden and reserved names. `src/customer/flows/events.ts` types its `flow()` helper from it |
| `validate.ts` | Runtime enforcement of the catalog. A bad event is dropped whole (never trimmed or coerced) |
| `routes.ts` | Route templates, page titles, `page_location` and `page_referrer` sanitization, campaign allowlist |
| `consent.ts` | The visitor's choice (`unset`/`granted`/`denied`) in `localStorage` (`ticketstub.analytics-consent.v1`), cross-tab sync, `openConsentPreferences()` |
| `runtime.ts` | One per page: gates on configuration + consent + tag state, de-duplicates page views, attaches the sanitized page and deployment labels, buffers only post-consent events while the tag loads |
| `gtag.ts` | GA4 adapter: injects `gtag.js` only after consent, configures manual page views with signals/ads off, shapes ecommerce `items`, pauses and clears cookies on withdrawal |
| `timing.ts` | Route timing (start from `src/instrumentation-client.ts`'s `onRouterTransitionStart`, end after the new route paints) and Web Vitals mapping |
| `config.ts` | Reads the server's settings per request; validates them again on the client |
| `Analytics.tsx`, `ConsentControls.tsx` | Mounted once by `src/app/layout.tsx`: runtime setup, page-view observer, Web Vitals, consent card and reopen control |

```text
layout.tsx (server, per request) ──config props──▶ <Analytics> (client)
   product code ── track() ──▶ validate ──▶ runtime ──(configured + granted + tag ready)──▶ gtag.ts ──▶ gtag.js ──▶ GA4
                                              ▲
                     usePathname/useSearchParams ── recordPageView()   useReportWebVitals / route timing ── trackInternal()
```

## Configuration and environments

All settings are server environment variables read **per request** by the root layout (it is
`force-dynamic`), so one build can run as production, preview, or with analytics off, and changing them
needs a restart, not a rebuild. Nothing uses a `NEXT_PUBLIC_` name and nothing is baked into the bundle.

| Variable | Values | Meaning |
| --- | --- | --- |
| `TICKETSTUB_ANALYTICS_ENV` | `production` \| `preview` | Required. Sent as `deployment_env` on every event. Any other value disables analytics |
| `TICKETSTUB_GA_MEASUREMENT_ID` | `G-` + 4–16 uppercase letters/digits | Required. The web stream's measurement id. Public page configuration, not a secret. Malformed ⇒ disabled |
| `TICKETSTUB_GA_DEBUG` | `1` | Adds GA `debug_mode` so events appear in DebugView. Preview property (`G-M2ELMGCNKW`) only |
| `TICKETSTUB_ANALYTICS_DISABLED` | `1` | Kill switch: overrides everything above |
| `TICKETSTUB_RUNTIME_MODE` | existing | Sent as `runtime_mode` (`demo`/`live`). `live` means live AI providers, never live commerce |

Rules:

- **Missing or malformed configuration means no analytics**: no consent card, no script, `track()` is a no-op.
  This is the default for local development and CI. The ids are not hardcoded; the two hosts get them from
  their own environment settings ([analytics-rollout.md](analytics-rollout.md#host-configuration)). Publishing on
  the current host copies production settings into Preview, so Preview's must be restored after every publish.
- Automated tests (`NODE_ENV=test`) never collect, whatever is set.
- **Environment isolation:** production and preview use **separate GA4 properties** (see the record); every hit carries
  `deployment_env`, and reports must filter on it. Preview, demo and sandbox activity is additionally labelled
  by `runtime_mode` and per-event `capability`, so it can never pass for live outcomes. Never point a preview
  deployment at the production measurement id.
- Server collection credentials (for example a Measurement Protocol API secret) are **not used** and must never
  be added under a client-visible name. There is no server-side GA collection in this change.
- No Content-Security-Policy is configured today (`next.config.ts`). If one is added, analytics needs
  `script-src https://www.googletagmanager.com` and `connect-src https://*.google-analytics.com https://*.analytics.google.com https://www.googletagmanager.com`;
  without them the tag is blocked, which the app tolerates (see [Failure isolation](#failure-isolation)).

## Consent

Basic consent mode: optional analytics loads and sends **only after the visitor agrees**.

- **First visit (configured deployments only):** a small non-modal card, bottom right (a full-width sheet on
  phones), asks once. "Allow analytics" and "No thanks" are equal-weight buttons. It does not take focus or
  block the page; it stays until answered.
- **Before an answer, and after "No thanks":** no `gtag.js`, no `dataLayer`, no cookie, no request. Events and
  page views are dropped, not stored: **there is no backlog and nothing is replayed** after a later "Allow".
- **On "Allow":** the tag is injected once (as soon as a page has been recorded) and the page the visitor is on
  at that moment gets one page view.
  Earlier pages and actions stay unmeasured. Events tracked after consent while the tag is still loading wait in
  a small buffer (25) that is discarded if consent is withdrawn or the tag never arrives.
- **Persistence:** the choice is stored as `{"v":1,"decision":"granted"|"denied"}` under
  `ticketstub.analytics-consent.v1` and applies on every reload and in every tab (`storage` events). If storage
  is unavailable the answer holds for the current page only and the card asks again next visit. A choice made in
  the page always wins over what is stored: if saving a "No thanks" fails, an older stored "Allow" does not come
  back on the next read or remount. Only a genuine change from another tab replaces it.
- **Reopen / withdraw:** a small "Analytics" tag (bottom right, with its state in its accessible name) reopens
  the card at any time; any page can also call `openConsentPreferences()` from
  `@/customer/analytics/consent` (the /privacy page's "Analytics choices" button does). The reopened card takes focus, Escape
  closes it, and focus returns to where it came from. Choices are announced through the app's live region.
- **Withdrawal** stops sending at once: buffered events are dropped, `gtag('consent','update',{analytics_storage:'denied'})`
  is pushed, `window['ga-disable-<id>'] = true`, and GA's first-party cookies (`_ga`, `_ga_<stream>`, legacy
  `_gid`/`_gat`) are deleted on the host and each parent domain. Leftover GA cookies are also cleared on any page
  load without consent. The script cannot be unloaded from the current page; it is not loaded on the next one.
- **Advertising is denied by default and never offered:** `ad_storage`, `ad_user_data` and `ad_personalization`
  are `denied`, `ads_data_redaction` is on, `url_passthrough` is off, Google signals and ad personalization are
  disabled in the tag config. There is no ad product, remarketing, session replay or heatmap.
- **Server operational diagnostics are separate:** they never read this choice and are never used to get around
  it. They carry no personal identifiers and follow their own collection and retention policy in
  [observability.md](observability.md). Nothing from the server is sent to Google.

The card's copy says what is collected ("the kind of page, never your links, stubs, names or what you
type"), that there are no ads, and links to /privacy. The /privacy page has an "Optional analytics" section
that matches this behaviour: opt-in before anything loads, what is and is not sent, Google as the recipient, the
per-browser-profile random identifier (not linked to an account), and how to withdraw. Where analytics is
configured it shows an "Analytics choices" button (`ConsentChoicesButton`) that opens the card; elsewhere the
button is not rendered. The wording is plain-language and makes no legal guarantees; it has not had legal review.

## Page views and URL sanitization

`gtag('config', id, { send_page_view: false, ... })` disables automatic page views. The layout's observer
(`usePathname` + `useSearchParams`, inside `Suspense`) records **one page view per accepted App Router
navigation**. It records the page in a layout effect, which React runs before any passive effect of the same
commit, so the new route's mount events (`organizer_step`, `wall_view`, `studio_open`, …) follow its `page_view`
and carry its template, while a click that starts the navigation is tracked before the commit and keeps the page
it was on:

- initial load, `router.push`, `router.replace`, `<Link>`, and browser back/forward each count once;
- navigating between different ids or queries on the same template (`/studio/a` → `/studio/b`, `/search?q=a` →
  `/search?q=b`) counts as a new view;
- the same pathname + query twice in a row (React Strict Mode double effects, remounts, re-renders) counts once;
  the identity used for this is the raw pathname + query and **never leaves the runtime module**;
- one narrow exception, in the follow-up and **not yet deployed**: on `/wall` the `pinned` parameter is ignored in
  that identity, so the tear flow's landing on `/wall?pinned=<id>` and the wall's cleanup to `/wall` are one view.
  Any other wall query, other ids and queries, and back/forward still count. The deployed `0f9baa5` counts two;
- hash-only changes are not navigations.

**Every URL is reduced to a known route template before anything is sent.** Share links embed serialized stubs
(`/s/<token>`, `/u/<token>`, `?from=`), organizer links carry designs (`?d=`), gift links carry names (`?to=`),
and `/new?url=` / `?q=` carry what someone typed; none of that can reach a provider.

| Path | Template | Title sent |
| --- | --- | --- |
| `/`, `/make`, `/search`, `/new`, `/wall`, `/cart`, `/organizer`, `/organizer/claim`, `/account`, `/signin/confirm`, `/help`, `/map`, `/privacy`, `/terms`, `/parts` | the path itself | fixed name |
| `/studio/<id>`, `/checkout/<id>`, `/wallet/<id>`, `/friends/<id>`, `/gift/<id>`, `/cart/unclaimed/<id>` | `/studio/:id` etc. | fixed name |
| `/s/<token>`, `/u/<token>`, `/claim/g/<token>`, `/claim/<set>` | `/s/:token`, `/u/:token`, `/claim/g/:token`, `/claim/:set` | "Share page", "Public wall", "Gift claim", "Claim" |
| `/admin`, `/admin/...` | `/admin`, `/admin/*` | "Admin" |
| `/api/...` | `/api` | "API" |
| anything else (extra segments, unknown routes, malformed paths) | `/unknown` | "Page" |

- `page_location` = page origin + template. All query strings and hashes are removed. The only exception is the
  **landing** page view, which keeps `utm_source`/`utm_medium`/`utm_campaign` **only when the value is in the
  reviewed allowlist** in `routes.ts` (`CAMPAIGN_ALLOWLIST`). A value's shape proves nothing (a name looks like
  any word), so unknown values are dropped; `utm_campaign` starts empty. Add campaign names there, with review,
  before links carrying them go out.
- `page_referrer`: on landing, a same-site referrer becomes its template and another site keeps only its origin
  (`https://mail.example.com/`, never its path, query or credentials); non-http referrers are dropped. On SPA
  navigations it is the previous page's template URL.
- `page_title` comes from the fixed table, never `document.title` (which can contain a stub's event title).
- These three fields are set on the tag config, updated with `gtag('set', ...)` at every page view, and added
  to **every event the app sends**, so those hits never fall back to `document.location`, `document.referrer` or
  `document.title`. The tag is not configured until the first page has been recorded, so no tag config and no
  app hit goes out with empty page fields. With a remembered "Allow", `<Analytics>` applies the settings and the
  stored choice in a layout effect, which React runs before any page's (passive) mount effects; post-consent events those effects send before the
  first page is recorded (`studio_open`, `wall_view`, `intake_submit`, …) are held (at most 25), then stamped with
  that first page's sanitized fields and released after its `page_view`. Events from before consent are never held.
- **This does not protect hits `gtag.js` builds by itself.** Enhanced measurement (history-based page views,
  scrolls, outbound clicks, site search, downloads) reads the real URL; preview traffic before the stream was
  corrected showed raw history page views. Enhanced measurement must stay off in the GA stream settings, and
  the `gtag('set')` call is defence in depth only, not a guarantee.
- `src/app` pages are checked by a test: a new page without a template fails `npm test`.

## What every event carries

Added by the runtime (callers cannot set them; `validate.ts` rejects them):

| Field | Value |
| --- | --- |
| `schema_version` | `1` |
| `deployment_env` | `production` \| `preview` |
| `runtime_mode` | `demo` \| `live` (AI runtime only) |
| `route_template` | the current page's template |
| `page_location`, `page_referrer`, `page_title` | sanitized as above |

Also reserved: `page_path`, `user_id`, `client_id`, `session_id`, `transaction_id`, `debug_mode`, `items`.
There is no `user_id`; GA's own random client id (cookie `_ga`, only after consent) is the only identifier.
Nothing derived from personal data, hashed or not, is sent as an identifier.

## Event dictionary (schema v1)

Validation rules (enforced at runtime, not just by TypeScript): the name must be in the catalog; each parameter
must be listed for that event; enum values must match exactly; integers must be integers within range; money is
a finite number 0–100000 rounded to cents; booleans must be booleans; the params object must be a plain object.
Any violation drops the **whole** event; in development the reason (event and key, never the value) is logged
with `console.warn`. GA limits are checked by tests (names ≤ 40 characters, ≤ 25 parameters including runtime
fields, enum values ≤ 100 characters).

Conventions: `capability` / `mode` say truthfully where a result came from (`live` provider, `simulated`,
`fallback`, `demo` fixture, `sandbox` commerce, `local` device-only). `storage` reports whether a persistence
step really succeeded, so an event never claims a save that failed. `error_code` is the bounded code catalog
in `src/customer/feedback-messages/messages.ts`, never an error message. Counts are capped at 1000 and
durations at ten minutes (`api_call` at one hour). The "Stamped" column lists values the runtime sets
regardless of the caller (passing a different value is rejected).

"Emitted from" is generated from the call sites at the time of writing; the boundary column is the contract.
Consent behavior is the same for every event (dropped unless configured and consented); the reporting
destination is GA4 for all of them.

<!-- dictionary:start -->
| Event | Flow | GA | Parameters | Stamped | Emitted from | Boundary |
| --- | --- | --- | --- | --- | --- | --- |
| `intake_submit` | intake | custom | `entry`: home\|make\|new_page\|search; `input_source`: link\|query\|demo\|picked; `result`: accepted\|reopened | — | `app/new/NewStub.tsx`, `customer/start/StudioStart.tsx` | Start/new-page intake accepted a link, query, demo or picked show (or reopened an existing stub) |
| `intake_invalid` | intake | custom | `entry`: home\|make\|new_page\|search; `reason`: empty\|clipboard_empty\|clipboard_denied\|missing_input | — | `app/new/NewStub.tsx`, `customer/start/StudioStart.tsx` | Intake refused: empty input, clipboard empty/denied, missing input |
| `intake_paste` | intake | custom | `entry`: home\|make\|new_page\|search; `result`: success\|empty\|denied; `via`: button\|field | — | `customer/start/StudioStart.tsx` | Paste button/field outcome on the start screen |
| `search_results` | search | custom | `result`: results\|zero\|error; `result_count`: int 0–1000; `query_kind`: empty\|text; `error_code`: enum(42) | — | `app/search/SearchShows.tsx` | A debounced search settled (results, zero, error); never per keystroke |
| `search_filter` | search | custom | `filter`: all\|concert\|game\|show\|generic | — | `app/search/SearchShows.tsx` | Search event-type filter changed |
| `select_item` | search | recommended | `item_list_id`: search_results; `index`: int 0–100; `item_category`: all\|concert\|game\|show\|generic; `demo`: bool | — | `app/search/SearchShows.tsx` | A search result was chosen (rank, event type, demo flag) |
| `search_fallback` | search | custom | `to`: link | — | `app/search/SearchShows.tsx` | Searcher switched to link intake |
| `creation_start` | create | custom | `entry`: home\|make\|new_page\|search; `input_source`: link\|query\|demo\|picked | — | `customer/studio/research/Printing.tsx` | Printing stage began research for the chosen input |
| `research_complete` | create | custom | `entry`: home\|make\|new_page\|search; `input_source`: link\|query\|demo\|picked; `result`: success\|error; `duration_ms`: int 0–600000; `fact_count`: int 0–1000; `error_code`: enum(42) | — | `customer/studio/research/Printing.tsx` | Research finished (success/error) with duration and fact count |
| `reveal_fact_toggle` | create | custom | `kept`: bool | — | `customer/studio/research/Printing.tsx` | A fact was kept or removed during the reveal |
| `reveal_skip` | create | custom | `entry`: home\|make\|new_page\|search | — | `customer/studio/research/Printing.tsx` | Reveal skipped |
| `reveal_complete` | create | custom | `entry`: home\|make\|new_page\|search; `skipped`: bool; `duration_ms`: int 0–600000; `fact_count`: int 0–1000; `kept_count`: int 0–1000 | — | `customer/studio/research/Printing.tsx` | Reveal finished (skipped or watched) with duration and kept/total facts |
| `creation_complete` | create | custom | `entry`: home\|make\|new_page\|search; `input_source`: link\|query\|demo\|picked; `result`: created\|reopened; `storage`: ok\|failed | — | `app/new/NewStub.tsx`, `customer/start/StudioStart.tsx` | The stub was persisted (storage ok/failed) at the creation boundary |
| `creation_error` | create | custom | `entry`: home\|make\|new_page\|search; `input_source`: link\|query\|demo\|picked; `error_code`: enum(42) | — | `app/new/NewStub.tsx`, `customer/start/StudioStart.tsx` | Creation failed with a bounded error code |
| `studio_open` | editor | custom | `status`: ready\|missing; `device`: desktop\|phone | — | `customer/studio/editor/Editor.tsx` | Editor mounted with a ready or missing stub |
| `studio_edit` | editor | custom | `change`: enum(15); `method`: swipe\|keyboard\|grid\|rail\|dots\|other; `edition`: researched\|letterpress\|risograph\|minimal\|classic; `material`: digital\|card\|print\|framed; `finish`: matte\|foil\|holo; `storage`: ok\|failed | — | `customer/studio/editor/Editor.tsx` | A committed editor change (style, version, material, finish, font, colour, foil, visibility, fact correction/confirmation, photos, friends) with its persistence result |
| `studio_flip` | editor | custom | `method`: button\|keyboard | — | `customer/studio/editor/Editor.tsx` | Stub flipped by button or keyboard |
| `studio_view` | editor | custom | `action`: zoom_in\|zoom_out\|fit\|zoom_selection\|preview_on\|preview_off | — | `customer/studio/editor/Editor.tsx` | Zoom/fit/preview command |
| `studio_panel` | editor | custom | `panel`: rail\|inspector\|focus\|styles\|remix\|agent\|facts\|versions; `open`: bool | — | `customer/studio/editor/Editor.tsx` | Editor panel opened or closed |
| `remix_request` | remix | custom | `via`: sheet\|agent\|note; `vibe`: neon\|risograph\|70s\|minimal\|custom\|none | — | `customer/studio/agent/AgentChat.tsx`, `customer/studio/agent/AgentNotes.tsx`, `customer/studio/editor/RemixSheet.tsx` | Remix requested from the sheet, agent or note (vibe enum only; never the prompt) |
| `remix_result` | remix | custom | `via`: sheet\|agent\|note; `result`: success\|limited\|error; `art`: generated\|procedural\|uploaded; `capability`: live\|simulated\|sandbox\|demo\|local; `duration_ms`: int 0–600000; `error_code`: enum(42) | — | `customer/studio/agent/AgentChat.tsx`, `customer/studio/agent/AgentNotes.tsx`, `customer/studio/editor/RemixSheet.tsx` | Remix finished: generated/procedural/uploaded art, capability provenance, duration, error |
| `photo_add` | memories | custom | `via`: memories\|agent\|memory_page\|organizer_claim; `result`: success\|error; `photo_count`: int 0–1000 | — | `app/organizer/claim/OrganizerClaimClient.tsx`, `app/s/[token]/MemoryPage.tsx`, `customer/studio/agent/AgentChat.tsx`, `customer/studio/editor/Memories.tsx` | Photo add outcome and resulting count (never the photo) |
| `note_edit` | memories | custom | `has_note`: bool | — | `customer/studio/editor/Memories.tsx` | Memory note saved (whether a note exists; never its text) |
| `agent_open` | agent | custom | `via`: button\|note\|seed | — | `customer/studio/editor/Editor.tsx` | Agent chat opened |
| `agent_message` | agent | custom | `intent`: weather\|photo\|question\|remix; `result`: live\|rules\|pending\|error; `error_code`: enum(42) | — | `customer/studio/agent/AgentChat.tsx` | Agent reply outcome: live, rules, pending or error (intent enum; never the message) |
| `agent_suggestion` | agent | custom | `suggestion`: moodier\|weather\|photo | — | `customer/studio/agent/AgentChat.tsx` | A suggested agent action was applied |
| `tear_start` | tear | custom | — | — | `customer/studio/editor/Editor.tsx` | Tear gesture/flow began |
| `tear_cancel` | tear | custom | — | — | `customer/studio/editor/Editor.tsx` | Tear abandoned |
| `tear_complete` | tear | custom | `method`: drag\|keyboard\|auto; `storage`: ok\|failed | — | `customer/studio/editor/TearFlow.tsx` | Tear finished (drag, keyboard or auto) and the result persisted |
| `wall_view` | wall | custom | `state`: empty\|loaded; `stub_count`: int 0–1000 | — | `app/wall/WallClient.tsx` | Wall loaded (empty or with N stubs) |
| `wall_filter` | wall | custom | `filter`: all\|concert\|game\|show\|generic | — | `app/wall/WallClient.tsx` | Wall filter changed |
| `wall_stub_open` | wall | custom | `via`: pointer\|keyboard | — | `app/wall/WallClient.tsx` | A stub opened from the wall |
| `wall_reorder` | wall | custom | `method`: drag\|keyboard; `storage`: ok\|failed | — | `app/wall/WallClient.tsx` | Wall reordered and persisted |
| `wall_remove` | wall | custom | `storage`: ok\|failed | — | `app/wall/WallClient.tsx` | Stub removed from the wall (persistence result) |
| `wall_public_toggle` | wall | custom | `public`: bool; `result`: saved\|local\|error; `error_code`: enum(42) | — | `app/wall/WallClient.tsx` | Public wall toggled (saved on server, local only, or error) |
| `wall_stop_sharing` | wall | custom | `result`: saved\|error; `error_code`: enum(42) | — | `app/wall/WallClient.tsx` | Wall sharing stopped |
| `wall_banner_dismiss` | wall | custom | — | — | `app/wall/WallClient.tsx` | Wall banner dismissed |
| `cta_select` | share | custom | `cta`: enum(13); `context`: wall\|memory\|public_wall\|gift\|claim\|editor\|lamp\|home\|make | — | `app/claim/g/[token]/GuestClaimClient.tsx`, `app/s/[token]/MemoryPage.tsx`, `app/u/[token]/PublicWall.tsx`, `app/wall/WallClient.tsx`, `customer/start/StudioStart.tsx`, `customer/studio/editor/Editor.tsx`, `customer/studio/editor/Tray.tsx` | A call to action chosen on wall, memory page, public wall, gift, claim or editor |
| `nav_select` | nav | custom | `item`: enum(25); `has_stubs`: bool | — | `customer/nav/NavFrame.tsx` | A sidebar row chosen, by place kind (never a stub id or title); has_stubs marks a returning wall |
| `share` | share | recommended | `method`: native\|copy; `content_type`: stub\|wall\|gift\|invite\|claim_link\|story; `result`: success\|cancel\|failure; `context`: wall\|lamp\|memory\|public_wall\|gift\|friends\|organizer | — | `customer/pages/share.ts` | Native share sheet or copy finished on this device (success/cancel/failure). Not delivery |
| `share_landing` | share | custom | `surface`: memory\|public_wall\|gift; `result`: valid\|invalid\|not_found\|error; `viewer`: owner\|visitor; `link_kind`: server\|encoded | — | `app/s/[token]/MemoryPage.tsx`, `app/u/[token]/PublicWall.tsx` | A share link opened: valid/invalid/not found, owner (local ownership only) or visitor |
| `public_wall_select` | share | custom | `rank`: int 0–100 | — | `app/u/[token]/PublicWall.tsx` | Public wall item opened (rank) |
| `gift_unwrap` | share | custom | — | — | `app/s/[token]/MemoryPage.tsx` | Gift unwrap animation completed |
| `story_export` | share | custom | `action`: download; `result`: generated\|failed | — | `app/s/[token]/MemoryPage.tsx` | Story image generated for download (initiation, not proof of saving) |
| `memory_photo_remove` | share | custom | `photo_count`: int 0–1000; `storage`: ok\|failed | — | `app/s/[token]/MemoryPage.tsx` | Memory-page photo removed |
| `stop_sharing_stub` | share | custom | `result`: saved\|error; `error_code`: enum(42) | — | `app/s/[token]/MemoryPage.tsx` | Sharing of one stub stopped |
| `friends_update` | friends | custom | `action`: add\|remove\|mode; `friend_count`: int 0–1000; `mode`: make\|claim; `storage`: ok\|failed | — | `app/friends/[id]/FriendsClient.tsx` | Friend added/removed or matching-set mode changed (counts only) |
| `claim_view` | claim | custom | `flow`: set\|guest\|organizer; `result`: valid\|invalid\|expired\|claimed\|error; `error_code`: enum(42) | — | `app/claim/[set]/ClaimClient.tsx`, `app/claim/g/[token]/GuestClaimClient.tsx`, `app/organizer/claim/OrganizerClaimClient.tsx` | Claim page validated its link (set, guest or organizer flow) |
| `claim_invalid` | claim | custom | `flow`: set\|guest\|organizer; `reason`: name_missing | — | `app/claim/[set]/ClaimClient.tsx`, `app/organizer/claim/OrganizerClaimClient.tsx` | Claim form refused (name missing) |
| `claim_complete` | claim | custom | `flow`: set\|guest\|organizer; `result`: claimed\|error; `storage`: ok\|failed; `error_code`: enum(42) | — | `app/claim/[set]/ClaimClient.tsx`, `app/claim/g/[token]/GuestClaimClient.tsx`, `app/organizer/claim/OrganizerClaimClient.tsx` | Claim saved (or failed) |
| `signin_choice` | account | custom | `choice`: sign_in\|skip; `reason`: save\|checkout\|claim | — | `customer/account/SignInSheet.tsx`, `customer/account/signin.ts` | Visitor chose to sign in or skip at a prompt. A choice, not a login |
| `sign_in_return` | account | custom | `result`: signed_in\|not_signed_in\|expired | — | `customer/account/AccountRoot.tsx` | Returned from a magic link: signed in, not signed in, expired |
| `sign_in_link` | account | custom | `reason`: save\|checkout\|claim; `result`: sent\|sandbox\|invalid\|error; `error_code`: enum(42) | — | `customer/account/SignInSheet.tsx` | Magic link requested: sent, sandbox mail, invalid, error. Not a login |
| `sign_out` | account | custom | `result`: done\|offline | — | `customer/account/useAccount.ts` | Signed out (or offline) |
| `account_action` | account | custom | `action`: change_email\|delete; `result`: sent\|sandbox\|done\|invalid\|error; `error_code`: enum(42) | — | `app/account/AccountClient.tsx` | Email change or account deletion outcome |
| `server_save` | account | custom | `kind`: sync\|share\|order\|gift\|publish\|claim; `result`: saved\|failed\|off; `error_code`: enum(42) | — | `app/gift/[id]/GiftClient.tsx`, `customer/account/share.ts`, `customer/account/sync.ts` | A server persistence step: sync, share, order, gift, publish, claim |
| `product_option` | checkout | custom | `option`: material\|finish\|size; `material`: digital\|card\|print\|framed; `finish`: matte\|foil\|holo; `size`: classic\|stamp\|framed\|file; `context`: checkout | — | `app/checkout/[id]/CheckoutClient.tsx` | Checkout option changed (material, finish, size) |
| `add_to_cart` | cart | recommended | `currency`: USD; `value`: money; `item_id`: enum(48); `quantity`: int 0–1000; `context`: checkout\|friends\|wall\|memory; `capability`: sandbox | capability=sandbox | `customer/cart/cartStore.ts` | A variant was added to the local cart (sandbox) |
| `remove_from_cart` | cart | recommended | `currency`: USD; `value`: money; `item_id`: enum(48); `quantity`: int 0–1000; `context`: cart\|mini_cart | capability=sandbox | `app/cart/CartClient.tsx`, `customer/cart/MiniCart.tsx` | A variant was removed from the cart |
| `view_cart` | cart | recommended | `currency`: USD; `value`: money; `item_count`: int 0–1000; `context`: cart\|mini_cart | capability=sandbox | `app/cart/CartClient.tsx`, `customer/cart/MiniCart.tsx` | Cart or mini cart viewed with its value |
| `cart_update` | cart | custom | `action`: restore\|remove_undo\|quantity | — | `customer/cart/MiniCart.tsx` | Cart restored, removal undone, or quantity changed |
| `begin_checkout` | checkout | recommended | `currency`: USD; `value`: money; `item_id`: enum(48); `item_count`: int 0–1000; `context`: checkout\|cart; `capability`: sandbox | capability=sandbox | `app/cart/CartClient.tsx`, `app/checkout/[id]/CheckoutClient.tsx` | Checkout started from cart or checkout page (sandbox) |
| `add_payment_info` | checkout | recommended | `payment_type`: apple_pay\|google_pay\|card\|gift_print\|organizer_print; `capability`: sandbox | capability=sandbox | `app/cart/CartClient.tsx`, `app/checkout/[id]/CheckoutClient.tsx` | Sandbox payment method chosen (no payment details exist) |
| `checkout_invalid` | checkout | custom | `reason`: email\|variant_blocked\|choose_again\|empty\|quote_expired | — | `app/cart/CartClient.tsx`, `app/checkout/[id]/CheckoutClient.tsx` | Checkout refused: email, blocked variant, choose again, empty, quote expired |
| `quote_expired` | checkout | custom | `context`: checkout\|cart | — | `app/checkout/[id]/CheckoutClient.tsx` | A quote expired |
| `quote_refresh` | checkout | custom | `context`: checkout\|cart | — | `app/checkout/[id]/CheckoutClient.tsx` | A quote was refreshed |
| `sandbox_order` | checkout | custom | `method`: apple_pay\|google_pay\|card\|gift_print\|organizer_print; `result`: placed\|blocked\|not_persisted; `receipt`: server\|local; `line_count`: int 0–1000; `value`: money; `currency`: USD; `capability`: sandbox; `storage`: ok\|failed; `error_code`: enum(42) | capability=sandbox | `customer/account/orders.ts`, `app/gift/[id]/GiftClient.tsx` | One per sandbox order attempt. `placed` = kept by the server (`receipt=server`, even if `storage=failed` here) or stored on this device; `not_persisted` = no server receipt and the local write failed (no `value`/`currency`); `blocked` = refused in live mode, no record. Never purchase |
| `sandbox_order_retry` | checkout | custom | `result`: server\|local; `error_code`: enum(42) | capability=sandbox | `customer/account/orders.ts` | A sandbox order retried (server or local) |
| `seat_decision` | cart | custom | `decision`: seat_only\|gift\|drop | — | `app/cart/unclaimed/[id]/UnclaimedClient.tsx`, `app/gift/[id]/GiftClient.tsx` | Unclaimed-seat decision: seat only, gift, drop |
| `gift_prepare` | gift | custom | `delivery`: link\|print; `wrap`: bool; `has_message`: bool; `result`: prepared\|invalid\|blocked\|error; `storage`: server\|local; `error_code`: enum(42) | — | `app/gift/[id]/GiftClient.tsx` | Gift link/print prepared (or refused). Preparation is not delivery |
| `gift_option` | gift | custom | `option`: delivery\|wrap; `delivery`: link\|print; `wrap`: bool | — | `app/gift/[id]/GiftClient.tsx` | Gift delivery or wrap choice changed before sending (never a name or note) |
| `gift_revoke` | gift | custom | `result`: saved\|error; `error_code`: enum(42) | — | `app/gift/[id]/GiftClient.tsx` | Gift link revoked |
| `wallet_select` | wallet | custom | `provider`: apple\|google; `capability`: simulated | capability=simulated | `app/wallet/[id]/WalletClient.tsx` | Wallet provider chosen. Passes are simulated; nothing is issued |
| `wallet_option` | wallet | custom | `provider`: apple\|google | — | `app/wallet/[id]/WalletClient.tsx` | Wallet tab switched before adding; a preference, not a pass |
| `organizer_step` | organizer | custom | `step`: design\|guests\|check\|publish\|done; `via`: open\|restore\|nav | — | `app/organizer/OrganizerClient.tsx`, `customer/pages/organizer.ts` | Wizard step on screen: once when it opens (`open` = Design; `restore` = Publish after a draft came back from sign-in; Strict Mode safe), then each move between steps (`nav`) |
| `organizer_design` | organizer | custom | `change`: edition\|allowed\|lock_logo\|lock_title\|organizer_name\|title; `edition`: researched\|letterpress\|risograph\|minimal\|classic; `value`: bool | — | `app/organizer/OrganizerClient.tsx` | Organizer design choice (which field changed; never its value) |
| `organizer_csv` | organizer | custom | `source`: file\|paste\|sample; `result`: parsed\|empty\|no_rows\|error; `row_count`: int 0–1000; `column_count`: int 0–100 | — | `app/organizer/OrganizerClient.tsx` | CSV parsed: source, result, row and column counts (never contents, headers or file names) |
| `organizer_mapping` | organizer | custom | `result`: auto\|manual; `has_seat`: bool; `has_extra`: bool | — | `app/organizer/OrganizerClient.tsx` | Column mapping completed (auto/manual, seat/extra columns present) |
| `organizer_check` | organizer | custom | `row_count`: int 0–1000; `missing_name_count`: int 0–1000 | — | `app/organizer/OrganizerClient.tsx` | Preview check: rows and missing names (counts) |
| `organizer_contact_select` | organizer | custom | `action`: inspect\|show_more; `rank`: int 0–1000; `shown_count`: int 0–1000; `row_count`: int 0–1000 | — | `app/organizer/OrganizerClient.tsx` | Contact-sheet position inspected or more rows shown (never the guest) |
| `organizer_publish` | organizer | custom | `mode`: links\|print; `result`: server\|local\|blocked\|error; `guest_count`: int 0–1000; `error_code`: enum(42) | — | `app/organizer/OrganizerClient.tsx` | Claim links or print run published (server, local, blocked, error) with guest count |
| `storage_failure` | reliability | custom | `store`: wall\|deleted\|cart\|orders\|session\|prefs; `op`: read\|write; `reason`: quota\|unavailable\|parse\|unknown | — | `customer/flows/events.ts` | A browser storage read/write failed (once per store/op/reason per page load) |
| `api_call` | reliability | custom | `api`: enum(13); `result`: success\|empty\|fallback\|failure\|aborted; `status_class`: 2xx\|204\|3xx\|4xx\|5xx\|network; `duration_ms`: int 0–3600000; `mode`: live\|simulated\|fallback\|demo\|sandbox\|local; `attempt`: int 1–20; `error_code`: enum(14) | — | `customer/studio/research/client.ts` | Browser-observed API call completed (one per attempt) |
<!-- dictionary:end -->

Runtime-only events (not available to `track()`):

| Event | Parameters | Boundary |
| --- | --- | --- |
| `page_view` | runtime fields only | One per accepted navigation (see above), plus the current page when consent is given |
| `web_vital` | `metric_name`: CLS\|FCP\|INP\|LCP\|TTFB; `metric_value`: int 0–600000 (ms; CLS × 1000); `metric_rating`: good\|needs-improvement\|poor; `navigation_type` | Reported by `next/web-vitals` (`useReportWebVitals`, the Web Vitals library bundled with Next.js, so no extra dependency). The per-load metric id is dropped |
| `route_timing` | `duration_ms`; `navigation_type`: push\|replace\|traverse | From `onRouterTransitionStart` to the first animation frame after the new route's page view. Not sent for the initial load (Web Vitals cover it). The destination URL the router passes is ignored |

### Commerce: GA ecommerce mapping (all sandbox)

- GA recommended events used: `select_item` (search result chosen), `add_to_cart`, `remove_from_cart`,
  `view_cart`, `begin_checkout`, `add_payment_info` (payment *method* chosen on the sandbox checkout; no payment
  details exist) and `share`. All commerce events are stamped `capability=sandbox`.
- `item_id` is a variant from the closed set `material_finish_size` (48 values, `VARIANT_IDS`), never a stub,
  cart, quote or order id. The adapter moves `item_id`/`quantity` into GA's `items` array as
  `{ item_id, item_category: material, item_variant: "finish_size", quantity }`.
- `currency` is `USD`. Prices are stored in integer **minor units** (cents); `value` is **major units**:
  `value = minor / 100` (`toMajorUnits`, or `major()` in the flows helper), rounded to cents.
- **`purchase` and `refund` are reserved** for a future authoritative payment confirmation, deduplicated by
  transaction id. Until then a persisted sandbox order is `sandbox_order` (custom), which GA never counts as
  revenue. Do **not** mark `sandbox_order` as a purchase or assign it revenue in GA.
- Never emitted (not in the catalog, listed in `FORBIDDEN_EVENTS`, checked by a source scan in tests):
  `purchase`, `refund`, `login`, `sign_up`, `add_shipping_info`, lead events, virtual currency, GA `search` /
  `view_search_results` (would invite a `search_term`), and GA's automatic event names.
- A sign-in **choice** (`signin_choice`) and a sent magic link (`sign_in_link`) are not logins. A magic-link
  return (`sign_in_return`) reflects this prototype's identity, which is not yet a production identity (#9),
  so GA `login` is withheld. Wallet selection (`wallet_select`, stamped `simulated`) is not pass issuance. Gift
  preparation (`gift_prepare`) is not delivery. `share` with `result=success` means the share sheet or copy
  finished on this device, not that anyone received it. `share_landing` `viewer=owner` is local device
  ownership, not identity.

## Performance measurement

- Core Web Vitals (LCP, INP, CLS) plus FCP and TTFB via `useReportWebVitals` from `next/web-vitals`. These cover
  the hard-navigation landing load; CLS and INP may be reported when the page is hidden, so their
  `route_template` is the page current at report time. Soft navigations get `route_timing` only.
- Same consent as everything else: reports before consent are dropped.
- The *Web vital value* custom metric (`metric_value`) aggregates as a **sum**: explorations show totals, not
  averages or percentiles. An average is the total divided by the event count, within one `metric_name` (never
  across names: CLS is × 1000, the rest are milliseconds). For a p75 view use the `metric_rating` distribution,
  or a BigQuery export if one is approved later. Establish a
  baseline over at least two weeks of consented production traffic before setting alert thresholds.
- Server/API durations and provider latency are in the operational log ([observability.md](observability.md)),
  with the browser-observed side in `api_call`.

## Failure isolation

`track()` and every runtime entry point catch everything; a throwing transport, a blocked script, missing
storage or SSR never reaches a customer action. With no configuration nothing is mounted.

**Fail closed when the tag cannot load.** If `gtag.js` errors, is blocked, or has not loaded within 10 s, the
load is treated as failed for the rest of the page:

- the buffer is dropped and nothing tracked afterwards is queued or sent;
- the transport is shut down as on withdrawal: `window['ga-disable-<id>'] = true`,
  `gtag('consent','update',{analytics_storage:'denied'})` is pushed, GA cookies are cleared, and the script
  element's load/error handlers are removed and the element detached;
- if the slow script still executes later, it finds the tag disabled and analytics storage denied, so it sends
  no hit and sets no cookie (`gtag.js` checks both when it runs);
- a withdrawal in this failed state shuts it down again, and a later "Allow" in the same page does not
  re-enable the tag or load a second script. The next page load starts fresh.

## GA4 setup record

Done by the project owner in the Google Analytics web interface on 2026-10-11 (no API, no scripted changes).
Measurement, property and stream ids are public identifiers; there are no secrets here. Redacted rollout evidence
is in [`evidence/analytics-2026-10-11/`](evidence/analytics-2026-10-11/) ([index](analytics-rollout.md#evidence)).

| | Production | Preview |
| --- | --- | --- |
| Account | CompleteTech LLC (`393449895`) | same |
| Property | *TicketStub — Production*, id `558390557` | *TicketStub — Preview*, id `558454273` |
| Web stream | *TicketStub Production Web*, id `16107672790` | *TicketStub Preview and Development Web*, id `16107767122` |
| Measurement id (`TICKETSTUB_GA_MEASUREMENT_ID`) | `G-RVV7ZNF463` with `TICKETSTUB_ANALYTICS_ENV=production` | `G-M2ELMGCNKW` with `TICKETSTUB_ANALYTICS_ENV=preview` |
| Stream URL | `https://getticketstub.com` | `https://gvk66o79l1.preview.c38.airoapp.ai` (a label only; GA does not restrict collection by it) |
| Time zone / currency | America/New_York, USD | same |
| Tag | Manual installation of this app's own tag | same |

- **Do not reuse the tag already on the live domain** (`G-YBRK8129PK` / `GT-M3L6XD84`, shared with other
  properties). It is not connected to these properties and must not be connected, replaced or overwritten.
- Use the preview id for local development and preview deployments, with `TICKETSTUB_GA_DEBUG=1` only there.

### Settings read back after saving

| Setting | State | How it was verified |
| --- | --- | --- |
| Enhanced measurement | **Off** on both saved streams | The switch chosen while creating the streams **did not persist**: real browser traffic to preview showed an automatic `scroll` event. It was then turned off on each saved stream and a reload showed it off. During the hosted rollout (2026-10-11) the **preview** stream was found **on** again; it was turned off and confirmed after an uncached reload. Production was confirmed off. Re-check both in every review |
| Data redaction | On for both streams: email redaction, plus query parameter redaction for `url`, `q`, `from`, `d`, `to`, `token`, `email`, `name`, `note` | Stream settings readback. A second line of defence only: the app already removes every query string before sending |
| Google signals | Off on both | Data collection page readback ("Turn on" offered) |
| User-provided data collection | Off on both | Data collection page readback |
| Granular location and device data | Off on both | Readback |
| Advertising personalization | Off in all 307 regions (0 of 307 allowed) on both | Readback on each property |
| Product links (Google Ads, Merchant Center, etc.) | None | Not linked |

### Reporting definitions registered (both properties)

- **31 event-scoped custom dimensions** on both properties. The first 14: `deployment_env`, `runtime_mode`,
  `route_template`, `capability`, `result`, `error_code`, `entry`, `input_source`, `edition`, `material`,
  `finish`, `method`, `metric_name`, `metric_rating`. Added during the rollout (display name → parameter):
  Storage outcome → `storage`, Editor status → `status`, Flow state → `state`, Studio change → `change`, Studio
  panel → `panel`, API endpoint → `api`, Response class → `status_class`, Storage area → `store`, Storage
  operation → `op`, Bounded reason → `reason`, Organizer step → `step`, Product flow → `flow`, Viewer role →
  `viewer`, Reveal skipped → `skipped`, Art provenance → `art`, Action origin → `via`, Panel opened → `open`.
- **2 event-scoped custom metrics:** *Action duration* → `duration_ms` (milliseconds); *Web vital value* →
  `metric_value` (standard unit). Always analyse `metric_value` within one `metric_name`: CLS is a score × 1000,
  the other vitals are milliseconds, so a sum or average across metrics means nothing.
- **Key event:** `tear_complete`, counted once per event, **no default monetary value**. `creation_complete` and
  `claim_complete` are deliberately *not* key events: their names also cover `reopened`/`error` outcomes, so
  report them as funnel steps with `result` filters instead of counting every emission as a success.
- GA's built-in `purchase` key event exists in each property by default. **The app never emits `purchase`**
  (it is forbidden in the catalog and checked by tests); sandbox orders are `sandbox_order` and carry no revenue.
  Do not mark `sandbox_order` or any commerce event as a purchase or give it a value.
- Other parameters in the dictionary (for example `context`, `cta`, `kind`, `mode`, `content_type`, counts) are
  collected but **not registered**, so they cannot be used in reports or explorations yet. Register a parameter before
  building a view on it (event-scoped dimensions are limited to 50 per standard property; registration is not
  retroactive).

### Ongoing GA administration

1. **Filters:** developer QA and default Internal Traffic filters stay in **Testing** (labelling only). IP-based
   internal filtering is not planned (closed by the owner); activating any filter permanently drops matching data, so it needs
   an explicit decision ([analytics-rollout.md](analytics-rollout.md#filters-decision)).
2. **Access:** quarterly review and on personnel or provider changes; no access grants were made in the rollout.
3. **Enhanced measurement:** keep it off. GA can re-enable it per stream (it happened once on preview) and code
   cannot switch it off; check it in every review.
4. **Cross-domain linking:** none needed (single host); leave it off.
5. **Data deletion:** GA user deletion (by client id) and data deletion requests are the removal paths.

## Reports and saved explorations

The saved workspaces and their exact definitions (13 views: activation, sandbox commerce, acquisition,
organizer, two sharing funnels, studio, research and reveal, performance, reliability, acquisition sources, studio
panels in production, plus one Preview QA view) are recorded in [analytics-rollout.md](analytics-rollout.md#saved-reports),
with how to read the summed metrics. The production views filter `deployment_env = production`, the QA view
`deployment_env = preview`;
commerce views are sandbox and carry no revenue. Parameters that are not registered as dimensions (for example
`context`, `cta`, counts) cannot be used in views until registered, and registration is not retroactive.

**Attribution limits:** link preparation is not delivery; local ownership is not identity; the same person on
two devices is two GA users; cross-device linkage needs a future supported identifier (#9) and consent, never a
hash of personal data.

**Operational and cost analysis** uses the server log, not GA: request/attempt status, fallback rates, provider
latency, token counts and provider-reported cost ([observability.md](observability.md)). Missing cost is
unknown, not zero, and provider-reported cost is not billed spend. The production sample recorded during the
rollout is in [analytics-rollout.md](analytics-rollout.md#operational-sample-production-2026-10-11); the report
tool is in [analytics-ops-reporting.md](analytics-ops-reporting.md).

**Export pipeline:** not justified for prototype traffic. GA4's free BigQuery export can be enabled later
(percentiles, joins with operational data) without code changes; no new service was added.

## QA

Offline (CI, no network):

```sh
npm test                                   # 282 unit tests after integrating main ae9a77a
node --test tests/analytics.test.mjs tests/analytics-browser.test.mjs
npm run lint && npm run typecheck && npm run build
node scripts/check-analytics-order.mjs     # 43 checks, after the build
node scripts/check-analytics-journeys.mjs  # 281 checks (140 phone, 141 desktop), after the build
```

The suites seed private values into route tokens, query strings (`?from= ?d= ?to= ?url= ?q=`), hashes,
referrers, `document.title`, campaign tags and event params, and assert none reach the transport, the
`dataLayer`, the script URL or cookies. They cover consent before/after/reload/withdrawal/cross-tab, no replay,
blocked/slow tag failing closed (including timeout → withdrawal → late script execution), remembered grants waiting for the first sanitized page, stale loaders, page-view de-duplication (push/replace/back/forward/Strict Mode/same template),
schema rejection, sandbox/simulated stamping and the absence of purchase/login events.

Ordering and page context in a real headless Chrome (production build, offline):

```sh
npm run build && node scripts/check-analytics-order.mjs
```

It starts `next start` on a loopback port with a synthetic preview id (`G-TEST000000`) and a throwaway database,
answers the `gtag.js` request with an empty local stub (Chrome resolves loopback only, so nothing reaches Google)
and reads `window.dataLayer`. It fails unless, after consent, SPA navigations `/make` → `/organizer`, `/wall` and
`/studio/<demo>` each record the destination's `page_view` first and then its mount event (`organizer_step`,
`wall_view`, `studio_open`) exactly once with the destination's template; the navigating click (`nav_select`)
keeps the source page; back and forward give one `page_view` each; every event carries the template of the
latest `page_view` before it; no seeded value appears; and a remembered "Allow" on a hard load sends `page_view`
then `studio_open`, both stamped. First recorded run on 2026-10-11: 33 checks passed on Node 22.23.3 and Node 24;
with the `/wall?pinned` checks added in the follow-up the script has 43, all passing on Node 22. With the page-view observer switched back to a passive effect (the code Astra reviewed at
`3da2c7b`), 6 checks fail: `organizer_step`, `wall_view` and `studio_open` arrive before the destination's
`page_view`, stamped with `/make`. This is local evidence with a stub tag; real Google requests are recorded
separately in [analytics-live-validation.md](analytics-live-validation.md).

Customer journeys in the same offline setup, at phone and desktop sizes:

```sh
npm run build && node scripts/check-analytics-journeys.mjs
```

It walks consent, creation, search, sharing, claims, commerce, organizer and entry journeys through the rendered
UI with a stub tag; what it covers and its recorded results are in
[analytics-journey-validation.md](analytics-journey-validation.md). CI runs both browser checks after the
production build, offline, with the synthetic id (`.github/workflows/runtime.yml`).

Local browser check without sending anything to Google: start with a synthetic id and **block** Google's
hosts in DevTools (Network → Request blocking: `*googletagmanager.com*`, `*google-analytics.com*`), or run
offline.

```sh
TICKETSTUB_ANALYTICS_ENV=preview TICKETSTUB_GA_MEASUREMENT_ID=G-TEST000000 npm run dev
```

Check: nothing is requested before "Allow"; after it exactly one (blocked) `gtag/js?id=G-TEST000000` request;
`window.dataLayer` holds `consent default` (ads denied) and `config` with `send_page_view:false` and template
page fields (open a share link and `/new?url=...`); the app keeps working with the script blocked. "No thanks"
in a fresh profile: no request, no `dataLayer`, across reloads. Withdraw: `window['ga-disable-G-TEST000000']`
is `true` and `_ga*` cookies are gone. Inspecting real `collect` payloads (`dl`, `dr`, `dt`) belongs to the live
validation below, in the preview property.

## Live validation

- **Local builds with the real preview id** (before the hosted rollout): consent, ordering, remembered consent,
  sandbox checkout privacy and the corrections made during review are recorded in
  [analytics-live-validation.md](analytics-live-validation.md). That session also found that enhanced measurement had
  not been saved as off: early preview events include GA's automatic `scroll` and unsanitized history page views,
  and must not be read as the corrected configuration.
- **Hosted, 2026-10-11** (both hosts, application `0f9baa5`): 0 Google requests before a choice, after denial,
  reload and withdrawal; only the host's id and environment after consent; private values removed from
  `page_location`; a phone activation stored in Preview DebugView; desktop sharing, organizer and claim journeys;
  production Realtime receiving events. Details, limits and evidence:
  [analytics-rollout.md](analytics-rollout.md#hosted-verification-2026-10-11).
- **Offline, every change:** the unit suites and both browser checks in CI cover the enumerated phone and desktop
  journeys plus focused unit and error cases, with a synthetic id and no network
  ([analytics-journey-validation.md](analytics-journey-validation.md)).

## Rollout and rollback

- **Rollout:** done on both hosts at application commit `0f9baa5`
  ([analytics-rollout.md](analytics-rollout.md)). Never set the production id on preview or local hosts.
- **After every publish**, restore Preview's four analytics overrides in two saves, restart Preview and verify
  both hosts ([procedure and recorded proof](analytics-rollout.md#after-every-publish-restore-and-verify-preview)):
  publishing copies production settings into Preview.
- **Rollback:** set `TICKETSTUB_ANALYTICS_DISABLED=1` (or remove the two required variables) and restart. The
  card, the reopen tag and the script disappear on the next page load; `track()` becomes a no-op; customer flows
  are unaffected. Stored consent records are harmless and reused if analytics returns. To remove collected data
  use GA's data deletion requests.
- **Schema changes:** adding events or enum values keeps `schema_version`; renaming or changing meaning bumps it
  and the dictionary above, and reports should filter on `schema_version` across the change.

## Ownership and retention

| Area | Owner |
| --- | --- |
| GA properties, admin settings, saved reports, access | CompleteTech LLC, through its existing admin account (shown in GA as *Complete Tech*). No access grants were made; saved workspaces are shared read-only with existing property users |
| Hosting settings (both hosts) | CompleteTech LLC, existing hosting account |
| Catalog, consent, adapter, this page | Customer app (analytics core) |
| Flow call sites | Each flow's owner (`src/customer/flows/events.ts` helpers) |
| Server operational log | Server owners ([observability.md](observability.md)) |

Access to both properties and the hosting settings is reviewed **quarterly** and whenever personnel or a provider
changes; each review also re-checks enhanced measurement, the filter states and Preview's overrides. GA event and
user retention is two months, activity reset off. The consent record lives in the visitor's browser until they
clear it. No analytics data is stored by TicketStub servers.

## Limitations

- Production data from 2026-10-11 includes synthetic QA traffic (Preview briefly used production settings after the
  publish, before the restore). It was not purged; no organic baseline is claimed for that day.
- No IP-based internal traffic filter (not planned; closed by the owner). Filters are in Testing: they label QA traffic and
  exclude nothing.
- Enhanced measurement must stay off in GA's admin; code cannot turn it off, and it has already been found on again
  once. If it is turned back on, outbound-click and download events would carry raw link URLs (data redaction covers
  only the listed query keys and email shapes).
- Historical custom reports were not yet populated on 2026-10-11 (processing delay; newly registered dimensions).
  Saved views read empty until then ([views](analytics-rollout.md#saved-reports)).
- Baseline hosted evidence predates the `/wall?pinned` page-view correction. The post-merge release proof on
  issue #39 records the deployed correction and hosted recheck.
- 31 parameters are registered as dimensions and 2 as metrics; the rest are collected but not reportable until
  registered, and registration is not retroactive. The metrics are sums; GA gives no percentiles.
- Hosted checks covered the journeys recorded in the rollout; other flows and error paths are verified offline.
- Web Vitals cover hard navigations only.
- Consent applies per browser profile; GA users are browsers, not people; there is no identity or cross-device
  linkage. Commerce is a sandbox and wallet passes are simulated, so there is no `purchase`, revenue or pass
  issuance until real payments and identity exist.
- The /privacy page describes the analytics behaviour in plain words; it has not had legal review.
