# ADR 0001: Application runtime

- Status: accepted for the hackathon build; owner approval (Lars, implementation owner; Tim reviews) is not recorded by this file.
- Issue: GT-01 (#7). Consumers: team-dashboard TD-01, landing-page LP-01.
- Date: 2026-10-10

## Decision

The application is one Next.js 16.4.0 App Router app (`src/app`), React and React DOM 19.3.0, TypeScript, served by `next start` as a Node server. It is the composition root: customer pages, the HTTP API under `src/app/api`, the landing page at `/`, and the team-dashboard mount at `/admin`.

Alternatives considered:

| Option | Why not |
|---|---|
| Static export (Next or Vite) plus a separate API service | The studio needs server routes (accounts, shares, orders, signed context tokens) and server-gated `/admin`. Two deployables means two origins, CORS and cookie problems, and an assembly cycle with the dashboard. |
| A second framework for the landing page (static site at `/`) | The landing page's hero must sit above our `<StudioStart />` and print in place, which is one React tree. Serving a separate artifact at `/` is still possible later (see routes.md) but not needed now. |
| Vite SPA for the studio | No server rendering for share pages, no server-side access gate for `/admin` (a client-only gate would leak existence). |
| Remix / SvelteKit | Already built on Next (PR #5); a rewrite buys nothing for the criteria and risks the deadline. |
| Next with Cache Components | Stubs live in the browser and routes render on request; prerendering adds nothing yet (`next.config.ts`). |

## Pins

- Node `22.23.3` (`.nvmrc`; `engines.node` `>=22.23.3 <23`) and npm `11.16.0` (`packageManager`; `engines.npm` `>=11.16.0 <12`). The database is `node:sqlite`, which needs a recent Node.
- `next` `16.4.0`, `react` and `react-dom` `19.3.0`, `eslint-config-next` `16.4.0`: exact versions in `package.json`, resolved in `package-lock.json`. Install with `npm ci`; CI (`.github/workflows/runtime.yml`) does.
- The dashboard package must declare React 19.3.x and Next 16.4.x as peers, not bundle them (routes.md, "Admin mount contract").
- Next 16 has breaking changes against older docs; read `node_modules/next/dist/docs/` before using an API (see `AGENTS.md`). Example: error boundaries receive `retry`, not only `reset`.

## Hosting runtime reconciliation (2026-10-11)

GoDaddy published runtime logs for app `gvk66o79l1` report Node `v22.23.3`. The application pin and supported engine range now match that Node 22 runtime instead of requiring Node 24. CI installs npm `11.16.0` explicitly and runs the existing foundation, access and unavailable-storage fixture suites on the pinned Node version. Local fixture checks use disposable SQLite databases and do not establish deployed persistence, email delivery or live-provider acceptance.

## Demo and live modes

`TICKETSTUB_RUNTIME_MODE` is read at build and at start, and must be set consistently.

- Anything other than `live` is a **demo preview**: demo research fixtures only, no provider or Ticketmaster call, simulated art, 204 agent, sandbox checkout, sign-in links shown on screen (`TICKETSTUB_SANDBOX_MAIL`), a "Demo preview" notice. No secrets are needed.
- `live` restores the original provider paths for separately reviewed development. It is not a production recommendation: identity, budget and URL controls are tracked in #7-#13. In live mode context tokens need `CONTEXT_SECRET` or they answer 503.
- `/api/health` reports `mode` (`demo` or `live`) and a version (a git SHA from the platform, else the package version). `npm run verify:product -- --suite <name> --mode fixture --evidence-dir <dir>` runs the checks offline and writes JSON evidence.

## Deployment

- Preview: Plus Launch, per README. Repository root, `main`, Node 22.23.3, `npm ci`, `npm run build`, `npm start` (binds `0.0.0.0`, reads `PORT`). A Node server deployment, not a static export. Updating the preview and the build log are recorded in #21; a local or CI pass does not prove the platform has synchronised. Publishing to Live needs separate authorisation.
- Self-hosted (VPS): the same build and start commands behind HTTPS and a reverse proxy that sets `X-Forwarded-Host`, `X-Forwarded-Proto` and `X-Real-IP`. State is a SQLite file (`TICKETSTUB_DB`, default `./data/ticketstub.sqlite`) and a files folder (`TICKETSTUB_FILES`): one writer, one host, back both up together. SQLite means one app instance; scaling out needs a different `Storage` implementation behind the existing interface in `src/server/storage.ts`.
- Canonical origin: `https://getticketstub.com` (`APP_URL`), used for email links and as an allowed `Origin`.

## Web and worker topology

**Current source reconciliation, 2026-10-13.** One `next start` web process serves pages and API routes. There is no separate general-purpose worker entry point or distributed job service. The architecture kit's separate web/worker deployment remains design intent. The app does have the following work inside its web process:

| Work | Current host and activation boundary |
|---|---|
| Scheduled app backups | [`src/instrumentation.ts`](../../src/instrumentation.ts) starts [`backup-schedule.ts`](../../src/server/backup-schedule.ts). Its timer checks for a due backup; the backup requires configured app database/files paths and available storage. `TICKETSTUB_BACKUP_EVERY_DAYS=0` or `off` disables the schedule. |
| Prodigi sandbox callback jobs | The same boot hook starts [`prodigi-host.ts`](../../src/server/fulfillment/prodigi-host.ts) only for `TICKETSTUB_PRODIGI_CALLBACKS=sandbox`; the host also requires an explicit supported ops environment. Its in-process worker leases durable, environment-partitioned reconciliation/poll/tracking jobs. The [callback runbook](../operations/prodigi-callbacks-runbook.md) records retries, restart recovery, the deliberately unavailable decision verifier and the owner steps before any provider order or callback registration. |
| Product-event telemetry | [`harness-export.ts`](../../src/server/harness-export.ts) hands events to the vendored agent-harness SQLite outbox and schedules its background drain. This is opt-in through `TICKETSTUB_HARNESS_EXPORT=neatlogs` and requires tokenization/ingest credentials and a durable outbox path. It is a telemetry delivery path, not a general job queue. |
| Canonical Creative host | [`creative/host.mjs`](../../src/server/creative/host.mjs) composes the pinned Creative API inside the request process, reusing one store/controller per configured physical Creative database. It can connect to the separately provisioned Finance PostgreSQL database. Its configuration, delegation and current-context checks remain required; [`requireCreativeFinanceLifecycle`](../../src/server/creative/finance.mjs) refuses new generation/edit admission without an accepted Finance lifecycle. The [current Creative handoff](../integration/creative-engine.md) and [provisioning inventory](../operations/deployed-settings.md) distinguish bounded recovery from paid execution. |

These source paths do not establish that a deployment enabled them. The app owns this composition and its operational hooks. Specialist implementations remain owned by their repositories; consuming an adapter, package or vendored snapshot does not assign a downstream service, queue, provider grant or execution owner. Any future separate worker needs an explicit process, handoff, restart and deployment decision.

### Migration ownership

| Persistence boundary | Schema owner and how this app uses it |
|---|---|
| Main application SQLite (`TICKETSTUB_DB`) | The app owns [`src/server/migrations.ts`](../../src/server/migrations.ts). [`sqlite.ts`](../../src/server/sqlite.ts) applies its ordered, forward-only chain when opening storage; `PRAGMA user_version` records progress and each migration commits or rolls back. |
| Prodigi callback tables in the app database | The app owns [`prodigi-migrations.ts`](../../src/server/fulfillment/prodigi-migrations.ts), a separate forward-only chain tracked by `module_schema`. It does not append to or renumber the main app chain. These tables implement the app's callback adapter; they do not transfer ownership of fulfillment-connectors. |
| Creative version/job and telemetry tables | The pinned Creative engine owns [`versions/store.mjs`](../../src/server/vendor/creative-engine/src/versions/store.mjs) and [`telemetry/sqlite-outbox.mjs`](../../src/server/vendor/creative-engine/src/telemetry/sqlite-outbox.mjs). The host opens their configured Creative SQLite store and uses their schema initialization. Preserve the producer source and hashes in its [manifest](../../src/server/vendor/creative-engine/MANIFEST.json); this database's schema version is separate from the main app database. |
| App Creative recovery/custody mapping | The app's [`initializeCreativeFinanceMapping`](../../src/server/creative/finance.mjs) creates only `ticketstub_creative_attempts` and `ticketstub_creative_finance_sources` in that Creative database. These are local recovery/comparison records; they do not create Finance acceptance, post expenses or complete settlement. |
| Finance PostgreSQL | Cost-intelligence owns the ten vendored [`migrations`](../../src/server/vendor/cost-intelligence/migrations) and their [manifest](../../src/server/vendor/cost-intelligence/MANIFEST.json). An authorized provisioning operator applies those exact migrations before startup. Provisioning requires the app's runtime connection to use the restricted `ci_finance_runtime` role, without schema-owner or migrator authority; see [provisioning](../operations/deployed-settings.md#creative-configuration-and-provisioning). This is a specialist Finance database, not a replacement for the app's `Storage` interface. |
| Harness telemetry outbox | Agent-harness owns the vendored [delivery-queue schema](../../src/server/vendor/agent-harness/src/observability/private/neatlogs-delivery-queue.js), pinned by its [manifest](../../src/server/vendor/agent-harness/MANIFEST.json). The app supplies `TICKETSTUB_HARNESS_DB`, or a separate `agent-harness-outbox.sqlite` beside `TICKETSTUB_DB`; it does not merge that schema into the app migration chain. |

The table describes the source this app consumes. Upstream schema changes and canonical contract acceptance stay with their owners; local fixtures, a successful migration or a populated registry do not grant paid/provider execution. Deployment settings and data migration require the applicable owner inputs described in the linked runbooks.

### Health and error boundaries

[`/api/health`](../../src/app/api/health/route.ts) reports uncached liveness, app revision/mode and app storage/persistence state. Its first storage check probes a scratch table; it is not a downstream readiness check or independent deployed-source attestation. [`error.tsx`](../../src/app/error.tsx) provides route-render recovery, [`global-error.tsx`](../../src/app/global-error.tsx) supplies a standalone document if the root layout fails, and [`not-found.tsx`](../../src/app/not-found.tsx) provides the same recovery destinations for unknown or hidden private pages. The [foundation fixture](../../scripts/verify-product.mjs) checks health, denied/unknown routes and a deliberate staff-fixture render error; its HTTP/chunk checks do not claim a browser interaction with the root-layout boundary.

This GT-01.5 source reconciliation does not record prior ADR owner approval or accept the separate [app/landing route handoff](../architecture/routes.md#landing-page-handoff-boundary-lp-01c). Those acceptance records remain explicit.

## Consequences

- One origin, one cookie jar, one deploy; `/admin` and `/` are routes in the same app.
- The server gate (`requireStaff`) is the only thing between a visitor and `/admin`; the sidebar entry is cosmetic.
- SQLite pins the app to a single instance until storage is swapped.
- Anything not exercised by `npm run verify:product` and CI is not claimed here: no phone-gesture tests, no live provider runs, no platform deployment evidence.
