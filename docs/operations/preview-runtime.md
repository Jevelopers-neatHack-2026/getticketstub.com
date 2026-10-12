# Preview runtime, deployment and provider configuration

Operational reference for the getticketstub.com studio application. The
[root README](../../README.md) is the short entry point; this page holds the
detailed build, deployment, runtime-mode and provider settings.

## Delivery state

The existing Next.js App Router studio from PR [#5](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/pull/5) is the runtime for the
deployment fix ([#21](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/issues/21)). Its routes and brand assets are preserved. This is a
hackathon prototype; integrating it does not complete [#7](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/issues/7), [#1](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/issues/1), or the product
release criteria. PR [#20](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/pull/20) adds magic-link identity, SQLite storage and file-backed artwork; target-host persistence and real email acceptance remain pending.
The fix merged in PR [#22](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/pull/22) and was verified on the Plus Launch
preview at `660cc5e`; [#21](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/issues/21) is closed with that evidence.

## Toolchain

Use Node **22.23.3** (see [`.nvmrc`](../../.nvmrc)) and npm **11.16.0**
(`packageManager` in [`package.json`](../../package.json); `engines` allows
Node `>=22.23.3 <23` and npm `>=11.16.0 <12`). Next.js 16.4.0 and React/React
DOM 19.3.0 are pinned in the root manifest and lockfile.

## Build and start

```sh
npm ci
npm run lint
npm run typecheck
npm run build
npm start
```

Development uses `npm run dev`. The production entry point is Next.js serving
`src/app` from the compiled `.next` directory. `npm start` binds to `0.0.0.0`
and reads the hosting platform's `PORT` environment variable (default: 3000).
The build must finish before starting. Install dev dependencies during the
build because TypeScript and ESLint are build tooling; do not use
`npm ci --omit=dev` before building. Google Fonts are downloaded during build,
so the build environment needs outbound access to Google Fonts and npm.

## Plus Launch configuration

Configure the repository root as the working directory, `main` as the source,
Node 22.23.3, install command `npm ci`, build command `npm run build`, and start
command `npm start`. This is a Node server deployment, not a static export.
Keep `.next`, `public`, and installed runtime dependencies available to the
start process. No application secrets or environment variables are required
for the demo preview; the platform supplies `PORT`.

After a change is merged to `main`, select **Update Preview** to pull the merged `main`
revision, then **Retry build**. Verify the build log and preview home page,
demo intake, studio and wall. Record the deployed commit and successful build
evidence in the relevant deployment issue ([#21](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/issues/21) holds the first verified preview). Publishing to Live requires separate authorization. A local
or GitHub Actions pass does not establish that Plus Launch has synchronized.

## Runtime mode and limitations

By default, the preview uses demo research fixtures and simulated art/agent
responses, even if provider keys happen to be configured. Arbitrary event URL
fetching is disabled. The visible banner identifies demo mode. Try the home
page's neatHack, The Pale Hours, or Harbour FC shortcuts. Checkout remains
sandbox; wallet passes and QR codes remain simulated. Magic-link sign-in and
server-side saving use SQLite when storage is available; production sign-in
requires email delivery unless sandbox mail is explicitly enabled. Keep
`TICKETSTUB_SANDBOX_MAIL` unset on the deployed site. Demo mode gates AI and
Ticketmaster calls; it does not disable Resend delivery when a mail key is set.
Use synthetic data until the complete deployment is verified.

`TICKETSTUB_RUNTIME_MODE=live` (set consistently at build and start) restores
the original prototype's external research/provider paths. Any other value,
including the `demo` default in [`.env.example`](../../.env.example), keeps
demo mode. Live mode is for separately reviewed, authorized development only:
the original routes lack the production identity, budget and URL access
controls tracked in [#7](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/issues/7)–[#13](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/issues/13). It is not a production deployment recommendation.

The optional server-only `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` enable the
original direct-provider paths in that mode; setting keys alone never enables
them in demo mode. No live provider calls were made to validate the deployment
fix.

| Capability | Direct provider (default) | Key | Model used | Without the key (live mode) |
| --- | --- | --- | --- | --- |
| Page fact extraction | `anthropic` | `ANTHROPIC_API_KEY` | `claude-sonnet-5-5` | Facts come from the page's schema.org data and Open-Meteo only |
| Agent chat | `anthropic` | `ANTHROPIC_API_KEY` | `claude-sonnet-5-5` | Rule-based replies |
| Artwork | `openai` | `OPENAI_API_KEY` | `gpt-image-1` | Procedural art, labelled "Sample art" |

The direct models are fixed in
[`src/server/ai/providers.ts`](../../src/server/ai/providers.ts).

### Weather (Open-Meteo)

Live research adds a weather fact from the Open-Meteo forecast and geocoding APIs
([#48](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/issues/48)). The server-only
`OPEN_METEO_API_KEY` holds the API Standard subscription key. When it is set, requests go to
`customer-api.open-meteo.com` and `customer-geocoding-api.open-meteo.com` with the key. When it is blank, the free
endpoints are used. The free tier is for evaluation and prototyping only and is not licensed for commercial
use, so every customer-facing deployment must set the key.

- **Coverage.** API Standard has no Historical Weather API; it needs the Professional plan, which is deferred and
  not planned. A date gets weather only inside the forecast API's window: up to 92 days back and 15 days ahead.
  Other dates show a pending weather fact. Inside the window, the API can still return no values for older
  days. In a check on 2026-10-11, values went back about 54 days. The fact then shows "Weather lookup unavailable".
- **Quota.** 1M calls per month. A lookup is two calls: one geocode and one single-day, two-variable forecast.
  Open-Meteo emails at 80%, 90% and 100% of the budget.
- **Key confidentiality.** The key travels only in the outbound request URL. The fact's `sourceUrl` is the
  Open-Meteo attribution link, never the request URL, and operational telemetry records no URLs.
- **Attribution (CC BY 4.0).** The fact's source is "Open-Meteo.com · place: GeoNames", and it links to
  <https://open-meteo.com/> wherever the app links a fact's source: the facts review, agent chat and shared event page.
  The label rounds and summarises the temperature and precipitation; the value keeps the API's figures.
  **Gap:** a kept weather fact also appears on the stub itself, which is both a digital and a printed keepsake,
  with no credit. Before commercial launch it needs a credit line agreed with the stub and print design.

## Product analytics (optional, off by default)

GA4 product analytics ([analytics.md](analytics.md)) is **off** unless a deployment sets both
`TICKETSTUB_ANALYTICS_ENV` (`production` or `preview`) and `TICKETSTUB_GA_MEASUREMENT_ID` (`G-...`). The
layout reads them per request, so enabling, switching property or disabling needs a restart, not a rebuild;
they are ordinary environment variables, not `NEXT_PUBLIC_` names, and the measurement id is not a secret.
Even when configured, nothing loads in a browser until the visitor accepts the analytics card.

- Preview must use its own GA4 test property (or, deliberately, its own stream), never the production id.
- `TICKETSTUB_GA_DEBUG=1` marks events for DebugView; use it only with the test property.
- `TICKETSTUB_ANALYTICS_DISABLED=1` is the rollback switch; it overrides everything else.
- No dependency was added: Web Vitals come from `next/web-vitals` bundled with Next.js. No CSP is configured;
  if one is added, allow the Google hosts listed in [analytics.md](analytics.md#configuration-and-environments).
- The GA4 properties exist (preview `G-M2ELMGCNKW`, production `G-RVV7ZNF463`; record in
  [analytics.md](analytics.md#ga4-setup-record)), but no deployment sets them, so every deployment collects
  nothing today. Use the preview id for preview and local checks only. The final live readback is pending.

Offline checks: `npm test` runs `tests/analytics.test.mjs` and `tests/analytics-browser.test.mjs` (fake
transport and fake browser, no network). Server operational logging is configured separately with
`TICKETSTUB_OPS_TELEMETRY` ([observability.md](observability.md)).

## OpenRouter configuration

OpenRouter is an optional server-side route for OpenAI and Anthropic models.
[Create an account](https://openrouter.ai/) and generate a key at
[OpenRouter API keys](https://openrouter.ai/keys). Copy `.env.example` to
`.env.local` in this repository root and give each selected model a separate
OpenRouter key using the capability-specific names below. A generic
`OPENROUTER_API_KEY` is not used; a missing capability key fails instead of
borrowing another model's key.
For deployment, enter the same names in the hosting platform's **server
Environment Variables / Secrets** settings. Never use `NEXT_PUBLIC_` names or
commit `.env.local`. No direct OpenAI or Anthropic key is needed for a capability
that selects OpenRouter.

| Capability | Provider setting | Allowed values / default | OpenRouter model setting | OpenRouter key setting |
| --- | --- | --- | --- | --- |
| Page fact extraction | `TICKETSTUB_RESEARCH_PROVIDER` | `anthropic` (default), `openrouter` | `TICKETSTUB_RESEARCH_MODEL` | `TICKETSTUB_RESEARCH_OPENROUTER_API_KEY` |
| Agent chat | `TICKETSTUB_AGENT_PROVIDER` | `anthropic` (default), `openrouter` | `TICKETSTUB_AGENT_MODEL` | `TICKETSTUB_AGENT_OPENROUTER_API_KEY` |
| Artwork | `TICKETSTUB_ART_PROVIDER` | `openai` (default), `openrouter` | `TICKETSTUB_ART_MODEL` | `TICKETSTUB_ART_OPENROUTER_API_KEY` |

For reviewed development with all three capabilities using OpenRouter:

```dotenv
TICKETSTUB_RUNTIME_MODE=live
TICKETSTUB_RESEARCH_PROVIDER=openrouter
TICKETSTUB_RESEARCH_MODEL=anthropic/claude-sonnet-5.5
TICKETSTUB_AGENT_PROVIDER=openrouter
TICKETSTUB_AGENT_MODEL=openai/gpt-6.1-sol
TICKETSTUB_ART_PROVIDER=openrouter
TICKETSTUB_ART_MODEL=openai/gpt-image-2
TICKETSTUB_RESEARCH_OPENROUTER_API_KEY=<research model key>
TICKETSTUB_AGENT_OPENROUTER_API_KEY=<agent model key>
TICKETSTUB_ART_OPENROUTER_API_KEY=<image model key>
```

Keys are paired with capability settings, so research and chat can use distinct
keys even if they select the same model. When changing a model, update its paired
key as needed. Existing setups using only `OPENROUTER_API_KEY` must migrate to
the three capability-specific variables. Keys are not included in responses,
usage metadata, logs, or browser bundles.

These example IDs were listed by OpenRouter's public discovery APIs on
2026-10-11 UTC; they are not proof of account access or a paid smoke test.
Select models your account can use and review their cost. Both OpenAI and
Anthropic text models are accepted; artwork requires an OpenAI image model.
There are no implicit OpenRouter model defaults. Auto-routing and colon-suffix
variants (including `:online` and `:free`) are rejected. Provider fallback is
explicitly disabled. The app does not retry failed requests or switch to a
direct-provider key after an OpenRouter failure.

Research and chat use OpenRouter Chat Completions with final text output.
Research extracts facts from the page already fetched by the application;
it does not enable external search or client tool execution. Fact citations
still point to that page, and a fact is live only when its quoted evidence
appears in the page. Malformed or truncated responses and unexecuted tool
calls are rejected. Artwork checks the Image Models API before using the
[dedicated Image API](https://openrouter.ai/docs/guides/overview/multimodal/image-generation).
Only base64 PNG, JPEG, and WebP outputs are accepted; returned image URLs and
SVG are rejected. Image dimensions use the selected model's default; this
adapter does not certify print dimensions or supplier compatibility.

Explicit OpenRouter configuration, capability, authentication, rate-limit,
and transport failures return bounded error codes and are displayed as errors.
They do not silently generate simulated art or agent replies. The original
optional direct-provider paths retain their simulated fallback behavior.
Successful route responses include `providerMetadata` with requested and
returned model/provider identities where supplied, plus available token counts
and OpenRouter cost in USD. Missing cost is unknown, not zero. These receipts
are not an authoritative finance ledger, provider invoice reconciliation, or
complete sponsor integration.

Setting keys does not enable external calls. Keep `TICKETSTUB_RUNTIME_MODE=demo`
for preview. For reviewed live development set it consistently at build and
start, then rebuild/restart after configuration changes. Existing production
limitations above still apply, including unfinished identity, budget, and URL
controls. Do not enable this as an unattended production service.

References: [OpenRouter Chat API](https://openrouter.ai/docs/api/reference/overview)
and [provider routing](https://openrouter.ai/docs/guides/routing/provider-selection).

## Verification

Run `npm test` for offline adapter and route tests
([`tests/providers.test.mjs`](../../tests/providers.test.mjs)) and the analytics suites
([`tests/analytics.test.mjs`](../../tests/analytics.test.mjs),
[`tests/analytics-browser.test.mjs`](../../tests/analytics-browser.test.mjs)), which never contact Google. They intercept
all HTTP requests and use synthetic keys. Any paid smoke test requires the
existing project budget/authorization process and sanitized evidence; no paid
request was made to implement this support.

With the production server running, run the deployment smoke checks
([`scripts/smoke-production.mjs`](../../scripts/smoke-production.mjs)):

```sh
# Set SMOKE_BASE_URL when the server uses a non-default PORT.
npm run smoke:production
```

The GitHub Actions [runtime workflow](../../.github/workflows/runtime.yml)
installs, lints, tests, typechecks, builds, and checks production routes, built
assets and demo APIs using a non-default port. It does not verify phone
gestures, upstream integration, or platform deployment.

## Private storage on Plus Launch

The host File Manager documents `/private` as durable across deployments,
excluded from code downloads and never served publicly. Both Preview and
Publish are configured with:

```dotenv
TICKETSTUB_DB=/private/ticketstub.sqlite
TICKETSTUB_FILES=/private/files
```

These settings require a restart or deployment to reach the running process.
After integration, check `/api/health` for `storage: "ok"` and
`persistence: "configured"`, then verify a synthetic saved stub and its artwork
survive a restart and redeployment. A configured health value proves only that
paths were set, not that data survived. `/api/health` also returns `commit`, the
running build's SHA (a host variable such as `SOURCE_COMMIT` or `GIT_COMMIT` if
set, else `git rev-parse HEAD` at build time, else `null`); compare it with the
commit you meant to deploy, since a host dashboard may show the latest `main`. Back up the database and artwork as a
consistent set and prove restore before enabling customer use. Never place
SQLite in `public/assets`, which is publicly served.
