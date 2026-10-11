# Operational telemetry reporting

How to turn the server's operational log lines (`ticketstub.ops/1`, see [observability.md](observability.md)) into a
report: request outcomes and latency per API route, AI provider attempts with token usage and provider-reported cost,
and source-API health. The tool is `scripts/summarize-ops-telemetry.mjs`: no dependencies, reads stdin, prints
aggregates only.

This covers **server operational telemetry only**. Browser product analytics (GA4, consent, funnels) is reported in
Google Analytics and documented in [analytics.md](analytics.md); the two are never joined.

## 1. Capture

Operational collection is off by default. Turn it on for the process you want to measure:

```sh
TICKETSTUB_OPS_TELEMETRY=log TICKETSTUB_OPS_ENVIRONMENT=preview npm start 2>&1 | tee /tmp/ticketstub-ops.log
```

- Each event is one line on **stdout** that starts with `{"schema":"ticketstub.ops/1"`. Other server output on the
  same stream (`[storage] …`, Next.js logs) is ignored by the summarizer and counted as `ignored_non_ops`.
- Set `TICKETSTUB_OPS_ENVIRONMENT` to `production` only on production; `preview`, `development` and `test` keep
  other traffic out of production numbers. `mode` (`demo`/`live`) comes from `TICKETSTUB_RUNTIME_MODE`.
- On a host, export the application's stdout for the period you want, e.g. with the platform's log CLI or log
  explorer download, to a file. Keep that file under the same access and retention as application logs
  (observability.md suggests 30 days production, 7 days preview) and delete working copies after reporting.

Accepted line shapes (the summarizer finds the event; whatever precedes it is discarded and never printed):

| Shape | Example (abridged) |
| --- | --- |
| Bare line, as the log sink writes it | `{"schema":"ticketstub.ops/1","name":"api_request",…}` |
| Any text prefix on the same line (timestamps, stream names, process labels, CRI `stdout F`) | `2026-10-11T19:40:00.000Z stdout F {"schema":"ticketstub.ops/1",…}` / `web.1 \| {"schema":…}` |
| Docker json-file style wrapper with the line in `log`, `message` or `msg` | `{"log":"{\"schema\":\"ticketstub.ops/1\",…}\n","stream":"stdout","time":"…"}` |

The event JSON must end the line (trailing whitespace is fine). Platforms that split long lines, re-encode JSON in
another way, or wrap it under a different key are not supported; such lines are counted as `invalid_json` or
ignored, never guessed at. Lines over 16 KiB are rejected (`oversize_line`); real events are under 1 KiB.

## 2. Summarize

```sh
node scripts/summarize-ops-telemetry.mjs < /tmp/ticketstub-ops.log                       # everything, text
node scripts/summarize-ops-telemetry.mjs --environment=production --mode=live < ops.log  # production live traffic only
node scripts/summarize-ops-telemetry.mjs --format=json < ops.log > ops-summary.json      # for dashboards/diffs
node scripts/summarize-ops-telemetry.mjs --strict < ops.log                              # exit 1 if any record was rejected
```

Exit codes: `0` summary printed; `1` `--strict` and at least one rejected record (or unreadable input); `2` bad
arguments (the bad argument is not echoed). Requires Node 22+ (the repository's pinned version).

### What it prints

- **input**: lines read, lines that looked like ops events, accepted, filtered out by `--environment/--mode`,
  ignored non-ops lines, and rejected records by reason: `invalid_json`, `oversize_line`, `unknown_envelope_field`,
  `unknown_name`, `bad_envelope`, `bad_fields`, `unknown_field`, `bad_value`, `not_ops`.
- **window / scope**: first and last event time; counts per `environment/mode`.
Every table row is labelled and grouped by `[environment/mode]`, so production, preview, development and demo
traffic are never pooled, even without `--environment`/`--mode` filters.

- **API requests** per environment/mode × route × operation: requests, latency n/p50/p95/max, outcome, HTTP status, aborted
  count, provider attempts made, dependency (what answered), fallback, and error/fallback codes.
- **Provider attempts** per environment/mode × capability × provider × model × phase: attempts, latency, outcome, codes,
  upstream HTTP status, token sums **with the number of attempts that reported them**, provider-reported cost with
  coverage, and how often the returned model differed from the configured one.
- **Source fetches** per environment/mode × source (page, Ticketmaster, geocoder, forecast, archive): outcome, upstream status,
  latency. These are data-source calls and have no tokens or cost.
- **Page parses** per environment/mode × parser: count, facts produced, how many found a date.

Percentiles are nearest-rank over the integer milliseconds in the events (p95 of fewer than 20 samples is the
maximum or close to it; read it as "slowest seen", not a stable tail).

### Cost and usage rules

- Cost is the figure the **provider put in its response** (OpenRouter `usage.cost`). It is printed as
  "provider-reported, not billed spend". It is not reconciled with invoices, credits, discounts, taxes or minimums;
  billed spend comes from each provider's billing console.
- An attempt without a reported cost is **unknown**, never zero. With no reporting attempts the cost is printed as
  `unknown` (JSON `null`), not `$0`. A total always comes with its coverage, e.g. `$0.0012 from 3/6 attempts;
  unknown for 3`; multiply nothing out of it.
- Direct Anthropic/OpenAI responses carry no cost, so their cost is always unknown here. Tokens are summed only over
  attempts that reported them (shown as `(n reporting)`); missing tokens are `unknown`.
- Nothing here estimates cost from tokens. If an estimate is ever needed, label it an estimate and keep it apart
  from provider-reported totals.

### Privacy behavior

The input is treated as untrusted. Each record is re-checked against the same allow-list the server sanitizer uses
(`src/server/observability/schema.ts`): exact envelope keys, known event names, enum values, bounded numbers,
well-formed ids, and string fields free of credential-, URL- and email-like content. A record with **any** unknown
field or ill-fitting value is rejected whole and only counted. The report never prints raw lines, line prefixes,
operation or attempt ids, timestamps other than the window, or unexpected strings: error codes outside the known
route/transport set are shown as `other`, model names that are not provider model ids (`openai/…`, `anthropic/…`,
`claude-…`, `gpt-…`) as `other_model`, and once a table has 50 named groups, further new keys fold into one `other` group per environment/mode (at most 10
more rows), labelled with that scope only, so overflow never mixes environments or modes.

## 3. Demo baseline

A preview in the default `demo` runtime makes no provider or source calls, so its report shows only fixture and
procedural answers. This is real output from the route handlers run offline (demo mode, log sink on, no network;
`environment=development`):

```text
input: lines=15 ops_lines=14 accepted=14 filtered_out=0 ignored_non_ops=1 rejected=0
scope (environment/mode): development/demo=14

API requests
  [development/demo] research/research_search: requests=4 n=4 p50=1ms p95=27ms max=27ms
    outcome: success=4
    status: 200=4  aborted=0  provider_attempts=0
    dependency: fixture=4  fallback: simulated=4
  [development/demo] research/research_link: requests=2 n=2 p50=1ms p95=2ms max=2ms
    outcome: success=1 rejected=1
    status: 200=1 422=1  aborted=0  provider_attempts=0
    dependency: fixture=1 demo=1  fallback: simulated=1 none=1
    codes: demo_only=1
  [development/demo] art/art_generate: requests=4 n=4 p50=2ms p95=3ms max=3ms
    outcome: success=4
    status: 200=4  aborted=0  provider_attempts=0
    dependency: procedural=3 fixture=1  fallback: procedural=3 simulated=1
  [development/demo] agent/agent_reply: requests=4 n=4 p50=0ms p95=0ms max=0ms
    outcome: no_content=4
    status: 204=4  aborted=0  provider_attempts=0
    dependency: demo=4  fallback: rules=4

Provider attempts (AI provider usage only; source APIs are listed separately)
  none
```

How to read a demo report:

- **Expected**: `provider_attempts=0`, no provider or source sections, agent `204`/`rules`, art `procedural` or
  `simulated`, research `fixture`/`simulated`, and `422 demo_only` for real links (demo cannot read them). A demo
  success rate says the fixtures work, not that research or AI works.
- **Investigate**: any provider attempt or source fetch in `demo` (should be impossible), `5xx` statuses,
  `storage_unavailable`, or `art` with `quota=limited` in a fresh preview.
- Latency here is in-process handler time (the first call includes module warm-up, hence the 27 ms p95); it is
  not comparable to live latency, which includes network and provider time.

## 4. Live report: what it looks like

Real output from the route handlers in `live` mode with **mocked** upstreams (synthetic responses, one in four
answering 429, one in three with no usage block; `environment=preview`), read through hosting prefixes and Docker
wrappers:

```text
  [preview/live] agent/agent_reply: requests=6 n=6 p50=1ms p95=27ms max=27ms
    outcome: success=5 rate_limited=1
    status: 200=5 429=1  aborted=0  provider_attempts=6
    dependency: provider=6  fallback: none=6
    codes: provider_rate_limited=1

Provider attempts (AI provider usage only; source APIs are listed separately)
  [preview/live] agent openrouter anthropic/test-model generate: attempts=6 n=6 p50=0ms p95=1ms max=1ms
    outcome: ok=5 error=1  codes: provider_rate_limited=1  upstream_status: 429=1
    tokens: input=360 (3 reporting) output=90 (3 reporting) total=450 (3 reporting)
    cost (provider-reported, not billed spend): $0.0012 from 3/6 attempts; unknown for 3

Source fetches (data sources, not AI usage)
  [preview/live] event_page: fetches=2 n=2 p50=0ms p95=0ms max=0ms  outcome: ok=2  upstream_status: 200=2
  [preview/live] weather_geocode: fetches=2 n=2 p50=1ms p95=1ms max=1ms  outcome: ok=2  upstream_status: 200=2
```

The numbers above are from mocks and say nothing about real provider latency, error rates or prices. Questions a
live report answers:

| Question | Where |
| --- | --- |
| Is a route failing? | API requests `outcome` (`upstream_error`, `server_error`) and `codes` |
| Is it our configuration or the provider? | `codes`: `missing_provider_key` / `invalid_*_configuration` are ours (with `provider_attempts=0`); `provider_*` with an `upstream_status` are the provider's |
| Are users getting fallbacks? | `fallback`: `rules` (agent 204), `procedural`/`simulated` (art), `no_enrichment` (research without AI facts), `slug` (Ticketmaster title only) |
| Is a provider slow or rate limiting? | Provider attempts latency p95 and `outcome=timeout`, `upstream_status=429` |
| How much usage was reported? | Provider attempts `tokens` and `cost`, always with coverage |
| Are data sources healthy? | Source fetches `outcome` per source (Ticketmaster `skipped` = no API key configured) |

Establish a baseline over at least two weeks of production `live` traffic before setting alert thresholds.

## 5. Verification

```sh
node --test tests/ops-telemetry-summary.test.mjs
```

The tests run the script as a separate process on synthetic records only. They cover percentiles, outcome/status
counts, unknown versus reported cost and tokens, filters, hosting prefixes and wrappers, group caps, `--strict` and
argument handling. A privacy case seeds a marker value, emails, URLs, a `token=` query, a person-like model name,
a credential-shaped model and malformed/oversize lines, and asserts none of them, nor any `op_`/`att_` id, appears
in text or JSON output, and that each bad record is rejected whole.

## 6. Limitations

- Offline batch tool over a log export; no streaming, storage, dashboards or alerting. Memory grows with the
  number of durations kept (fine for exported periods; split very large exports by day).
- Only `ticketstub.ops/1` is understood. If the schema changes, update the allow-list in the script with
  `src/server/observability/schema.ts`; until then new fields cause whole-record rejection (visible in `rejected`).
- Hosting formats beyond the three shapes above are not supported.
- The example outputs in sections 3 and 4 come from offline runs of the real handlers with mocked upstreams. No
  production or live-provider log has been summarized yet.
- Product events (`ticketstub.event/1`) and GA4 data are not included and cannot be joined to these records.
