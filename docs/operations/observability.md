# Operational observability (server)

How the AI-backed API routes (`/api/research`, `/api/art`, `/api/agent`) measure themselves: request duration and
status, the fallback that answered, each upstream AI attempt (provider, model, duration, failure code, and the token
and cost figures the provider returned), and each source fetch and page parse. Part of #39. Browser product analytics
(GA4, consent) is in [analytics.md](analytics.md); the product event log (`ticketstub.event/1`) is in
[../architecture/events.md](../architecture/events.md).

## What it is, and what it is not

| | Operational events (`ticketstub.ops/1`) | Product events (`ticketstub.event/1`) | Browser analytics (GA4) |
| --- | --- | --- | --- |
| Question answered | How did the server and its dependencies behave? | What happened to a stub? | How do people use the product? |
| Where built | `src/server/observability/*` | `src/server/events.ts` | `src/customer/analytics/*` |
| Identity | None: no actor, tenant, device, IP or project | Hashed actor/project refs | GA client id, only after consent |
| Default | **Off** | On (SQLite or ring) | Off unless configured **and** consented |
| Destination | stdout JSON lines (host log pipeline) | SQLite `events` table | Google Analytics |

Operational collection is a separate, server-side diagnostics policy. It never receives, stores or forwards
browser analytics events, so it cannot be used to get around a visitor's analytics choice, and nothing in it is
sent to Google. It carries nothing that identifies a person, which is why it does not depend on consent.

Durable workflow tracing stays with the agent-harness repo (#17). Product events reach it through `exportToHarness`
in `src/server/events.ts`, off unless `TICKETSTUB_HARNESS_EXPORT=neatlogs` (see
[../architecture/events.md#harness-hand-off](../architecture/events.md#harness-hand-off)). Separately, these operational events can be exported to **Neatlogs** as content-free traces
(see [Neatlogs traces](#neatlogs-traces)); that export sends only the allow-listed fields below, never prompts,
page text, titles, URLs or anything that identifies a person.

## Configuration

Placeholders for `.env.example` (owned by the analytics core change; listed here exactly):

```sh
# Server operational measurement (separate from browser analytics consent). Default off.
# off | log   (log = one sanitized JSON line per event on stdout, schema ticketstub.ops/1)
TICKETSTUB_OPS_TELEMETRY=off
# production | preview | development | test — labels events so preview/demo traffic is never read as production
TICKETSTUB_OPS_ENVIRONMENT=
```

- Unset, empty, `off` or any unrecognised value (including a URL) means **off**: no ids are made, nothing is built
  or written, and route responses are byte-for-byte what they were before this module existed.
- `log` writes each event as one JSON line to stdout; it needs no credential. `neatlogs` is the only network exporter
  and needs `NEATLOGS_INGEST_KEY` (see [Neatlogs traces](#neatlogs-traces)).
- Settings are read per request, so toggling needs only a restart of the process with the new environment.
- `TICKETSTUB_OPS_ENVIRONMENT` should be `production` only on the production deployment; anything not in the list is
  recorded as `unspecified`. Events also carry `mode` (`demo`/`live`) from `TICKETSTUB_RUNTIME_MODE`; `live` means
  the AI runtime is live, not that commerce, identity or delivery are.

Rollout: set `TICKETSTUB_OPS_TELEMETRY=log` and `TICKETSTUB_OPS_ENVIRONMENT=preview` on a preview deployment, run
the queries below against its logs, then enable production. Rollback: set `TICKETSTUB_OPS_TELEMETRY=off` (or remove
it) and restart. No data migration is involved either way.

## Neatlogs traces

`TICKETSTUB_OPS_TELEMETRY=neatlogs` (or `log,neatlogs`) plus `NEATLOGS_INGEST_KEY` turns each measured AI route request
into one Neatlogs trace. Without the key the setting is ignored (and `log,neatlogs` keeps only `log`). The code is
`src/server/observability/neatlogs.ts`.

| Span | Kind | From | Main attributes |
| --- | --- | --- | --- |
| `ticketstub.<route>` (root) | `WORKFLOW` | `api_request` | status, outcome, operation, dependency, fallback, attempts, code, environment, mode |
| `<capability>.<phase>` | `LLM` | `provider_attempt` | `neatlogs.llm.model_name`, `neatlogs.llm.provider`, token counts, `neatlogs.llm.cost_usd` (only when the provider reported it), outcome/code |
| `source.<name>` | `TOOL` | `source_fetch` | outcome, upstream status, duration |
| `parse.<parser>` | `TOOL` | `source_parse` | parser, facts, date |
| `agent.<step>` | `TOOL` | `agent_step` | step, action type, outcome, code, duration, count |

- The Neatlogs session id is the operation id, so the `x-ticketstub-operation` response header finds the trace.
  Tags are `ticketstub` and, when `TICKETSTUB_COMMIT_SHA` is set, `ticketstub@<sha>`.
- Failed provider attempts and failed requests are error spans carrying the fixed code (for example
  `provider_rate_limited`), so a fallback that still answered shows as a failed child under a successful root.
- Delivery is OTLP/HTTP protobuf to `{NEATLOGS_ENDPOINT or https://ingest.neatlogs.com}/v1/traces` with the key in
  `x-api-key`, after the response is produced. Only the documented US/EU ingest origins are accepted. Export never
  delays or changes a response: it is bounded (5 s timeout, 8 in flight, 200 open operations, 64 events each, 256 KiB
  body) and failures are only counted (`neatlogsStats()`).
- A 2xx with no rejected spans means the receiver **accepted** the trace, not that it is stored. Confirm in the
  dashboard or with the Public API (service-account token) before citing a trace as evidence.
- Neatlogs computes its own cost column from its price list; for models it does not price, that column shows 0
  while the span keeps the provider-reported `neatlogs.llm.cost_usd`.
- Rollback: remove `neatlogs` from `TICKETSTUB_OPS_TELEMETRY` (or unset the key) and restart.

## Event dictionary (`ticketstub.ops/1`)

Every event has the envelope:

| Field | Meaning |
| --- | --- |
| `schema` | `ticketstub.ops/1` |
| `name` | one of the four names below; anything else is refused |
| `at` | epoch ms |
| `environment` | `production` \| `preview` \| `development` \| `test` \| `unspecified` |
| `mode` | `demo` \| `live` (AI runtime setting) |
| `operationId` | `op_` + 16 random base64url characters, made by this server for one API request |
| `fields` | per-name allow-list below |

### `api_request` — one per product operation (API request)

| Field | Values |
| --- | --- |
| `route` | `research`, `art`, `agent` |
| `operation` | `research_link`, `research_search`, `art_generate`, `agent_reply`, `unknown` (request rejected before its kind was known) |
| `status` | final HTTP status (100–599) |
| `outcome` | `success`, `no_content` (204), `invalid_input` (400/413), `forbidden` (401/403), `rejected` (other 4xx), `rate_limited` (429), `upstream_error` (502/503/504), `server_error` (other 5xx), `aborted` (the caller's request signal was aborted; wins over status) |
| `durationMs` | handler wall time, integer ms |
| `dependency` | what produced the answer: `none`, `demo`, `fixture`, `page`, `ticketmaster`, `provider`, `procedural` |
| `fallback` | `none`, `simulated` (demo fixture / mockup art), `procedural` (procedural art, including the daily-limit answer), `slug` (Ticketmaster title from the link), `rules` (agent 204: the browser answers with its rules), `no_enrichment` (research page parsed but AI enrichment failed and was skipped) |
| `code` | bounded snake_case code: the error code the route returned, or why a fallback was taken (e.g. `missing_provider_key`, `provider_rate_limited`, `demo_only`, `unreadable_link`, `art_limit`). `503` with `missing_provider_key`/`invalid_*_configuration` is our configuration, not the upstream — read `code` with `outcome`. |
| `aborted` | caller aborted |
| `attempts` | number of upstream AI attempts in this operation |
| `quota` | art only: `ok`, `limited`, `storage_off` |
| `results` / `facts` | search result count / facts returned |
| `clientCorrelation` | whether the caller sent an `x-request-id` header (its value is never kept) |

### `provider_attempt` — one per upstream AI call

| Field | Values |
| --- | --- |
| `attemptId` | `att_` + random; `attempt` is its 1-based index within the operation |
| `capability` | `research`, `agent`, `art` |
| `provider` | `openrouter`, `openai`, `anthropic` (the configured transport) |
| `phase` | `model_check` (OpenRouter image model discovery) or `generate` |
| `model` | configured model id; `returnedModel` / `upstreamProvider` only when the response named them and they pass validation |
| `outcome` | `ok`, `error`, `cancelled` (caller aborted), `timeout` (our 15 s / 90 s bound) |
| `code` | the transport's public error code on failure (`provider_rate_limited`, `provider_authentication_failed`, `invalid_image_response`, …) |
| `upstreamStatus` | upstream HTTP status when one was received |
| `durationMs` | attempt wall time |
| `inputTokens`, `outputTokens`, `totalTokens` | **only** when the provider returned them as non-negative integers |
| `costUsd` | **only** when the provider returned a cost figure (OpenRouter `usage.cost`) in range |
| `costSource` | `provider_reported` when the response contained a cost, else `unknown` |
| `usageReported` | whether any usage figure was kept |

An attempt is the transport call. If the provider answered but the route then refused the output (for example
research enrichment that is not a JSON array), the attempt is `ok` and the operation carries the code
(`invalid_provider_response`). Configuration failures (missing key, bad model) happen before any call, so they
appear only on `api_request` with `attempts: 0`. The transport never retries and never falls back to another model,
so one `generate` attempt per call is expected.

### `source_fetch` — one per data-source fetch

`source`: `event_page`, `ticketmaster`, `weather_geocode`, `weather_forecast`.
`outcome`: `ok`, `http_error`, `timeout`, `network_error`, `bad_response`, `rate_limited`, `auth_failed`,
`not_found`, `skipped` (no Ticketmaster key, no geocoder match so no forecast was fetched, or a date more than 92 days
back, since API Standard has no historical weather), `pending` (date beyond the forecast horizon). `auth_failed` on a
weather source means Open-Meteo rejected `OPEN_METEO_API_KEY` (401/403). Plus `upstreamStatus` and `durationMs`. Ticketmaster lookup is measured as one fetch around
the whole Discovery lookup (`src/customer/studio/research/ticketmaster.ts` is not instrumented internally).

### `source_parse` — one per fetched event page

`parser`: `schema_org`, `title`, `none`; `outcome`: `ok`/`empty`; `facts` count; `date` found flag.

### `agent_step` — one per agent step (action protocol `ticketstub.agent-action/1`)

`step`: `plan` (a reply to a typed request), `followup` (a reply to observed results), `result` (one action result the
browser reported), `failure` (a result that was `failed` or `rejected`), `recovery` (the procedural fallback applied).
`action`: the action type only (`set_fact`, `set_style`, `set_material`, `set_finish`, `set_text`, `remix_art`,
`show_back`, `ask_user`). `outcome`: `ok`, `repaired` (the model's JSON was invalid once and the repair attempt was
valid), `invalid_plan` (still invalid: a safe reply with no actions), or the result's `applied`/`failed`/`rejected`.
`source`: `rules` or `live`. Plus `code` (a bounded code such as `provider_unavailable`, `art_limit`, `invalid_value`),
`durationMs` (planning time; for a `result` the browser-measured apply time) and `count` (actions proposed). A result is
reported on the follow-up request, so each step is one span under that request's trace (`agent.<step>`). The model
calls inside a plan are ordinary `provider_attempt` spans with their usage, so a repair shows as a second attempt.
Never a field: the message, a fact or a value the person typed, the reply, or the proposed action's arguments.

## Usage, cost and what they are not

- **Source APIs are not provider usage.** Page fetches, Ticketmaster Discovery and Open-Meteo are `source_fetch`;
  they have no token or cost fields. Only `provider_attempt` describes AI provider usage.
- **Provider-reported cost is not billed spend.** `costUsd` is the figure the provider put in this response. It is
  not reconciled with invoices, credits, discounts, taxes or minimums, and it exists only for providers that return
  it (OpenRouter today; direct Anthropic/OpenAI responses do not include a cost). Billed spend comes from the
  provider's billing console or invoices.
- **Nothing is estimated here.** No price table is applied; when a figure is absent it stays absent and
  `costSource` is `unknown`. Any estimate someone builds from token counts must be labelled as an estimate and kept
  separate from `provider_reported` sums. Report coverage (`provider_reported` attempts ÷ all attempts) next to any
  total.

## Correlation ids

- `operationId` is generated server-side with `crypto.randomBytes` for each measured request; `attemptId` per
  upstream call. Neither is derived from, or replaced by, anything the caller sends.
- A caller's `x-request-id` is never used for operational events (only `clientCorrelation: true|false` is kept).
  The existing `route()` wrapper still echoes `x-request-id` on research responses, as before.
- When collection is on, responses carry `x-ticketstub-operation: op_…` so support can find the matching lines.
  It is a random reference that grants nothing; no handler ever reads it from a request. No telemetry is added to
  any response body. (The pre-existing `providerMetadata` in agent/art/research responses is unchanged.)

## Privacy and security rules

Never recorded: prompts, messages, vibes, page text, event titles/venues/cities, search queries, URLs (full, partial
or hostnames), request or upstream headers, cookies, IPs, account/device ids, upstream response bodies, exception
messages, image data, API keys.

Enforced in code (`src/server/observability/schema.ts`), not only by convention:

- Fixed event names; per-name field allow-list; unknown fields and ill-fitting values are dropped, not repaired.
- Strings are enums, bounded snake_case codes, or model identifiers. Any string field is refused if it looks like a
  credential (`sk-`, `bearer`, `secret`, `token`, `api_key`, `authoriz`, `passw`), contains a 32+ character
  alphanumeric run, an email, `://`, `//`, `www.`, `?`, `&`, `#`, `=`, or percent-encoding.
- Numbers are bounded (status 100–599, durations ≤ 1 h, counts non-negative safe integers, cost 0–10 000 USD).
- The provider transport hands the observer codes and numbers only (`ProviderAttempt` in
  `src/server/ai/providers.ts`); the public error envelope is unchanged.

Failure isolation: with collection off nothing runs. With it on, a sink that throws or rejects is caught; the
response is unaffected; `opsStats().sinkErrors` counts it and one payload-free warning is logged per process.
Observer exceptions inside the transport are swallowed. Handlers that throw are measured with the status the
error handling will give them and rethrown unchanged.

## Retention

- `log` sink: retention is the host log pipeline's. Recommended: **30 days** for production and **7 days** for
  preview, access limited to the operators who can already read application logs. Events contain no personal data,
  but keep them out of analytics exports and do not join them to user records.
- In-memory collector: tests only; lost on process exit.
- The product event log's 90-day policy (`EVENT_RETENTION_DAYS`) is unrelated and unchanged.

## Queries

Logs are JSON lines; with the log stream saved to `ops.log` (filter on the schema so other output is ignored):

```sh
# Select operational lines
ops() { grep '"schema":"ticketstub.ops/1"' ops.log | jq -c "$@"; }

# Request count, error rate and p50/p95 latency per route (production only)
ops 'select(.name=="api_request" and .environment=="production")' | jq -s '
  group_by(.fields.route) | map({route: .[0].fields.route, n: length,
    errors: (map(select(.fields.status>=500)) | length),
    p50: (map(.fields.durationMs) | sort | .[(length*0.5|floor)]),
    p95: (map(.fields.durationMs) | sort | .[(length*0.95|floor)])})'

# Outcome and fallback mix per route and mode (demo vs live kept apart)
ops 'select(.name=="api_request") | [.mode, .fields.route, .fields.outcome, .fields.fallback] | join(" ")' -r | sort | uniq -c

# Provider attempt failures by capability, model and code
ops 'select(.name=="provider_attempt" and .fields.outcome!="ok") | [.fields.capability, .fields.model, .fields.outcome, (.fields.code // "-"), (.fields.upstreamStatus // "-" | tostring)] | join(" ")' -r | sort | uniq -c

# Provider latency p95 by capability/model
ops 'select(.name=="provider_attempt" and .fields.phase=="generate")' | jq -s 'group_by([.fields.capability,.fields.model]) | map({k: (.[0].fields.capability+" "+.[0].fields.model), n: length, p95: (map(.fields.durationMs)|sort|.[(length*0.95|floor)])})'

# Tokens and provider-reported cost, with coverage — not billed spend
ops 'select(.name=="provider_attempt" and .mode=="live")' | jq -s 'group_by(.fields.model) | map({model: .[0].fields.model, attempts: length,
  reported_cost_usd: (map(.fields.costUsd // 0) | add), cost_coverage: ((map(select(.fields.costSource=="provider_reported")) | length) / length),
  input_tokens: (map(.fields.inputTokens // 0) | add), output_tokens: (map(.fields.outputTokens // 0) | add)})'

# Source health: outcome per source
ops 'select(.name=="source_fetch") | [.fields.source, .fields.outcome] | join(" ")' -r | sort | uniq -c

# Page parse yield
ops 'select(.name=="source_parse") | .fields.parser' -r | sort | uniq -c

# Everything for one operation (from a response's x-ticketstub-operation header)
ops --arg id op_XXXXXXXXXXXXXXXX 'select(.operationId==$id)'
```

Set alert thresholds only after a baseline (suggested: two weeks of production data); until then, review the
queries weekly. Suggested starting signals: `upstream_error` share per route, `provider_attempt` `timeout` share,
`fallback=no_enrichment` share, and `source_fetch` `rate_limited` for Ticketmaster.

## Browser-observed API calls

`src/customer/studio/research/client.ts` emits the catalogued GA event `api_call` once per research/art/agent
HTTP call: `api`, `result` (`success`, `empty` for a search with no results, `fallback` for the agent's 204 or the
art daily-limit answer, `failure`), `status_class` (`2xx`, `204`, `3xx`, `4xx`, `5xx`, `network`), `duration_ms`
(client round trip), `attempt` (always 1: the client does not retry), `mode` (`live`, `simulated`, `fallback`, only
where the response itself says so) and `error_code`, a coarse class (`network`, `parse`, `rate_limited`,
`provider_config`, `provider`, `invalid_input`, `unsupported_url`, `unauthorized`, `not_found`, `http_4xx`,
`http_5xx`, `unknown`) mapped from the server code — the code itself, messages and bodies are never sent. It goes
through `@/customer/analytics/track`, so it is subject to the same configuration and consent as all product analytics
and is dropped before consent. Comparing it with server `api_request.durationMs` separates network/client time
from server time; the two are not joined by id.

## Verification (offline)

```sh
node --test tests/observability.test.mjs          # real route handlers + transport, mocked fetch, memory sink
node --test tests/observability-client.test.mjs   # browser client through the real analytics runtime, fake transport
node --test tests/providers.test.mjs              # existing provider contract, unchanged
npm run typecheck && npm run lint
```

The tests seed a secret marker into messages, titles, vibes, URLs, query strings, client headers, upstream error
bodies and hostile provider metadata, and assert it never reaches the collector or `api_call`. No test makes a
network call; fetch is replaced in every case.

## Limitations

- Only the three AI routes are measured. Other API routes (orders, share, auth, …) are not wrapped.
- Ticketmaster is measured as one lookup, not per Discovery request; its internal retries are not visible.
- `log` is the only sink. Shipping to a metrics backend is the host log pipeline's job; no exporter service was added.
- No live provider or production log run has been performed in this change; the queries are verified against the
  event shape produced by the tests, not against production data.
- Product events (`ticketstub.event/1`) and operational events are not joined: the product log's `requestId` comes
  from the caller's `x-request-id` when present, and operational events deliberately do not use it.
