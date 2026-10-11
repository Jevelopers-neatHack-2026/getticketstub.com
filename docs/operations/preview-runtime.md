# Preview runtime, deployment and provider configuration

Operational reference for the getticketstub.com studio application. The
[root README](../../README.md) is the short entry point; this page holds the
detailed build, deployment, runtime-mode and provider settings.

## Delivery state

The existing Next.js App Router studio from PR [#5](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/pull/5) is the runtime for the
deployment fix ([#21](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/issues/21)). Its routes and brand assets are preserved. This is a
hackathon prototype; integrating it does not complete [#7](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/issues/7), [#1](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/issues/1), or the product
release criteria. PR [#20](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/pull/20) remains a separate stacked implementation.
The fix merged in PR [#22](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/pull/22) and was verified on the Plus Launch
preview at `660cc5e`; [#21](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/issues/21) is closed with that evidence.

## Toolchain

Use Node **24.18.0** (see [`.nvmrc`](../../.nvmrc)) and npm **11.16.0**
(`packageManager` in [`package.json`](../../package.json); `engines` allows
Node `>=22.12.0 <25` and npm `>=10.9.0 <12`). Node 22 is supported because the
Plus Launch runtime is Node 22; CI builds and smoke-tests on both. Next.js 16.4.0 and React/React
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
Node 22 (the Plus Launch runtime; Node 24 if offered), install command `npm ci`, build command `npm run build`, and start
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
sandbox; sign-in, wallet passes, and QR codes remain simulated. Stubs remain
in browser storage and share links carry their payload; do not use private
customer data in this prototype.

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
([`tests/providers.test.mjs`](../../tests/providers.test.mjs)). They intercept
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
