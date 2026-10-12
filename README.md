<a href="https://github.com/Jevelopers-neatHack-2026/getticketstub.com">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme/banner-night.svg">
    <img alt="getticketstub.com — The keepsake studio. TicketStub banner showing a stub emerging from a print slot with foil light raking across it." src="docs/assets/readme/banner-day.svg" width="100%">
  </picture>
</a>

# getticketstub.com

The TicketStub customer studio: paste an event link, watch the stub print while facts are researched, then edit, tilt the foil, tear it off and pin it to your wall.

<p>
  <a href="https://github.com/Jevelopers-neatHack-2026"><img alt="TicketStub ecosystem" src="https://img.shields.io/badge/TicketStub-ecosystem-E4572E?style=flat-square&labelColor=17140F"></a>
  <a href="#status"><img alt="Status: demo preview" src="https://img.shields.io/badge/status-demo%20preview-B4693E?style=flat-square&labelColor=17140F"></a>
  <a href=".nvmrc"><img alt="Node.js 22.23.3" src="https://img.shields.io/badge/node-22.23.3-26302A?style=flat-square&labelColor=17140F"></a>
  <a href="package.json"><img alt="Next.js 16.4.0" src="https://img.shields.io/badge/next.js-16.4.0-7CC6D2?style=flat-square&labelColor=17140F"></a>
</p>

[Status](#status) · [Quickstart](#quickstart) · [Checks](#checks) · [Docs](#docs) · [Related repositories](#related-repositories) · [Contributing](#contributing)

## Status

This is a hackathon prototype. Implemented in this repository:

- The Next.js App Router studio ([`src/app`](src/app), [`src/customer/studio`](src/customer/studio/README.md)), integrated as the preview runtime for the deployment fix ([PR #22](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/pull/22)). The Plus Launch preview was verified at `660cc5e` ([#21](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/issues/21), closed with deployment evidence).
- Demo mode by default: fixture research (neatHack, The Pale Hours, Harbour FC), simulated art and agent replies, sandbox checkout, and a visible demo banner. Provider keys alone never enable external calls.
- An opt-in `TICKETSTUB_RUNTIME_MODE=live` development mode with direct Anthropic/OpenAI paths or per-capability OpenRouter routing ([`src/server/ai/providers.ts`](src/server/ai/providers.ts)).
- Offline provider tests and a production smoke script, run by the [runtime workflow](.github/workflows/runtime.yml).
- Magic-link sign-in, server-side SQLite storage and file-backed artwork ([PR #20](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/pull/20)) are merged, and [PR #33](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/pull/33) fixed the emailed sign-in confirmation (`bad_origin` when the browser sent no referrer).

Verified on the published host (getticketstub.com, GoDaddy Plus Launch) on 2026-10-11 and 2026-10-12:

- `/api/health` reports `mode=live`, `storage=ok` and `persistence=configured`, with `TICKETSTUB_DB=/private/ticketstub.sqlite` and `TICKETSTUB_FILES=/private/files`.
- Resend delivered a real sign-in email. `TICKETSTUB_SANDBOX_MAIL` is unset there, so sign-in returns no on-screen link (the `mail-off` check in the [evidence](docs/operations/evidence/auth-storage-2026-10-12) covers this).
- A synthetic stub and its artwork saved through `/api/wall/sync` survived a Live redeploy (saved 2026-10-11T20:05Z, read again 2026-10-12T03:27Z).
- A fixture-mode backup and restore drill passes ([PR #63](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/pull/63), [evidence](docs/operations/evidence/auth-storage-2026-10-12)). Restoring a real host backup has not been demonstrated; see the [owner runbook](docs/operations/deployed-auth-storage-runbook.md).

Pending or outside this repository's current state:

- Real payment: Dodo ([#66](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/pull/66)) and Stripe ([#71](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/pull/71)) are open, so checkout is still sandbox.
- The order authorization issuer and verifier ([#41](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/pull/41)) and the artwork approval record and verifier ([#37](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/pull/37)) are merged. An approval does not authorize a purchase. Still open: paid download ([#61](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/pull/61)), versioned order-authorization signing keys ([#76](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/pull/76)) and versioned approval signing keys ([#75](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/pull/75)).
- Wallet passes and QR codes remain simulated.
- Publishing to Live needs separate authorization, and production identity, budget and URL access controls ([#7](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/issues/7)–[#13](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/issues/13)) and the WP02 customer application epic ([#1](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/issues/1)) are not done.
- Integrated v1 acceptance ([#6](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/issues/6)) is not met. All [acceptance criteria](docs/architecture/ACCEPTANCE.md) remain planned in the [master checklist](https://github.com/Jevelopers-neatHack-2026/integration-evals/blob/main/planning/acceptance-checklist.md).

## Quickstart

Use Node 22.23.3 ([`.nvmrc`](.nvmrc)) and npm 11.16.0 (`packageManager` in [`package.json`](package.json)).

```sh
npm ci
npm run dev          # http://localhost:3000
```

Production build:

```sh
npm run build
npm start            # binds 0.0.0.0, reads PORT (default 3000)
```

No environment variables are needed for the demo preview. The build downloads Google Fonts, so it needs outbound network access. Hosting settings, live mode and provider keys are in [Preview runtime, deployment and provider configuration](docs/operations/preview-runtime.md).

## Checks

```sh
npm run lint
npm run typecheck
npm test                    # offline provider and route tests; synthetic keys, no network
npm run build
npm run smoke:production    # against a running server; set SMOKE_BASE_URL for a non-default PORT
```

The [runtime workflow](.github/workflows/runtime.yml) runs these on pull requests and pushes to `main`. It does not verify phone gestures, upstream integration or platform deployment.

## Docs

| Document | What it covers |
| --- | --- |
| [Preview runtime and providers](docs/operations/preview-runtime.md) | Toolchain, build and start, Plus Launch settings, runtime mode, direct and OpenRouter provider settings, verification |
| [Studio module](src/customer/studio/README.md) | Routes, real versus simulated behaviour, storage, brand rules |
| [Ownership](docs/architecture/OWNERSHIP.md) | Repository responsibilities and interfaces |
| [Acceptance view](docs/architecture/ACCEPTANCE.md) | Relevant acceptance criteria |
| [Implementation plan](docs/planning/implementation-plan.md) · [Work packages](docs/planning/work-packages.md) | Central plan and P0 issue tracking |
| [Architecture kit v1.0](docs/architecture-kit/v1.0/README.md) | Architecture and diagrams (immutable snapshot) |
| [Repository inventory](integration/repository-map.json) · [Distribution map](docs/architecture-kit-distribution.json) | Verified repositories and kit distribution |
| [Architecture-kit deployment report](docs/architecture-kit-deployment-report.md) | Inventory, commits, PRs, validation and remaining publication requirements |

The architecture kit v1.0 is a checksummed snapshot that preserves the original planning claims, including proposed-repository labels. The maintained ownership documents, the [contract catalog](https://github.com/Jevelopers-neatHack-2026/shared-contracts/blob/main/docs/contract-catalog.md) and the master checklist supersede snapshot copies for ongoing work. Architecture documents describe intended boundaries; they do not establish completed product functionality, passing implementation tests, connected sponsor tools or live financial activity.

[Architecture-kit deployment report](docs/architecture-kit-deployment-report.md) records the inventory, commits, PRs, validation and remaining publication requirements.

## Running it

```
npm ci
npm run build && npm start      # production, http://localhost:3000
npm run dev                     # development
```

Node 22.13 or newer (the database is `node:sqlite`; it may print an experimental warning). Set the variables below in the environment or in `.env.local`; every one is optional, and the app works without any of them.

| Variable | What it does |
|---|---|
| `APP_URL` | The public origin, e.g. `https://getticketstub.com`. Used for links in emails and as an allowed `Origin` for POST/PUT requests. Without it, the request's own host is used. |
| `RESEND_API_KEY` | Sends sign-in links and receipts through Resend. Without it nothing is emailed: the server logs the sign-in link and `POST /api/auth/link` returns `devLink` for the sandbox "Open the link" button. In production with no key and no `TICKETSTUB_SANDBOX_MAIL=1`, sign-in answers 503 rather than pretend. |
| `MAIL_FROM` | The sender. Default `TicketStub <hello@getticketstub.com>`. The domain must be verified in Resend. |
| `TICKETSTUB_DB` | SQLite file. Default `./data/ticketstub.sqlite` (the folder is created, and `/data` is git-ignored). Back this file up; it holds accounts, walls, orders, shares and events. |
| `TICKETSTUB_FILES` | Folder for stub art. Embedded images (PNG, JPEG, WebP, up to 6 MB each) are moved out of the database into content-hashed files here and served from `/api/files/<hash>.<ext>`. Default `./data/files` (git-ignored). Back it up with the database. |
| `TICKETSTUB_SANDBOX_MAIL` | Set to `1` to return `devLink` (and log the link) when there is no mail key, even in production. Never leave it on once Resend is set up. |
| `TICKETMASTER_API_KEY` | Event lookup through the Ticketmaster Discovery API in `/api/research`. |
| `DODO_PAYMENTS_API_KEY`, `DODO_PAYMENTS_WEBHOOK_KEY`, `DODO_PAYMENTS_PRODUCT_ID`, `DODO_PAYMENTS_ENVIRONMENT` | Dodo Payments hosted checkout for **all-digital** card or wallet orders (Dodo only accepts digitally delivered goods; physical orders go to Stripe). On only when all four are set, and `DODO_PAYMENTS_ENVIRONMENT` must be `test_mode` or `live_mode` (Dodo defaults to live). The server re-derives the total from the price list (`amount_mismatch` otherwise), and only a signed webhook at `/api/payments/dodo/webhook`, checked against the payment fetched back from Dodo, marks an order paid and sends its receipt. |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Stripe hosted Checkout (Link and cards) for card or wallet orders with a **physical** line (#64). Charges only orderable variants, so it stays dormant until a printer SKU is confirmed: today every physical variant is a preview and stays sandbox. Test or live follows the key prefix. The same server-derived total and forward-only webhook rules as Dodo apply, at `/api/payments/stripe/webhook`. Stripe collects the shipping address; the app never stores it. |
| `OPENAI_API_KEY` and the other OpenAI variables | Ticket reading and art generation. Without them the studio falls back to simulated results. Art generation is capped at 10 a day per account, 10 per device (an httpOnly `ts_device` cookie) and 30 per IP, counted in the SQLite `art_usage` table. Over the cap, `/api/art` answers 429 `art_limit` with `retryAt`, and the editor falls back to procedural art. Sign-in and email change refuse disposable email domains (the bundled list is `src/server/disposable.ts`). |
| `SESSION_SECRET` | Not used. Session and sign-in tokens are random and stored only as SHA-256 hashes, so there is no secret to configure. |

### Plus Launch persistence

The app keeps accounts, walls, orders and shares in one SQLite file, and art in a folder. A host may have no disk that survives a deploy, or none that can be written at all. So on first use the server tries both paths: it makes the folders, writes a file, and writes and reads a scratch table. It logs one line saying what it found and never crashes over it.

- **GoDaddy Plus Launch.** The host documents `/private` as durable across deploys, excluded from code downloads and never publicly served. Preview and Publish have been configured with `TICKETSTUB_DB=/private/ticketstub.sqlite` and `TICKETSTUB_FILES=/private/files`. Runtime write/read, restart/redeploy survival and coordinated backup/restore must still be verified after integration. Do not place the database in `public/assets`.
- **Writable, with a persistent volume.** Set `TICKETSTUB_DB` and `TICKETSTUB_FILES` to paths on that volume. The startup line says `persistence configured`, and `/api/health` reports `"persistence": "configured"`.
- **Writable, no volume.** Leave them unset and the defaults under `./data` work, but the data resets on each deploy. The startup line and `/api/health` (`"persistence": "default-path"`) say so. It is fine for a preview and wrong for anything people rely on.
- **Not writable.** The server runs device-only. `/api/health` reports `"storage": "unavailable"`, every route that needs storage answers 503 `storage_unavailable` ("Saving is off on this preview."), art falls back to procedural with no OpenAI call, and the app hides sign-in and shows "Saving off · this device only". Stubs, shares (as encoded links) and sandbox orders keep working on the device. `npm run verify:product -- --suite degraded --mode fixture --evidence-dir out/evidence` proves this against a build.

### Backup and restore

The database runs in WAL mode, so committed rows can sit in `ticketstub.sqlite-wal` for a long time. Copying `ticketstub.sqlite` on its own, or the three files one after another, is not a backup. Use the app instead:

1. Sign in as staff (an `ADMIN_EMAILS` address) and, from a page on the same site, run `fetch("/api/admin/backup", { method: "POST" }).then((r) => r.json())`. The server takes a consistent snapshot with `VACUUM INTO` on a second connection (no downtime, the app keeps writing), then copies the art and re-hashes every file. Output goes to `backups/<id>/` next to the database (`/private/backups/<id>/` on Plus Launch): `ticketstub.sqlite`, `files/` and `manifest.json`. The response is the manifest: row counts per table and file hashes, never row contents. `ok` is false if the integrity check failed or the snapshot references art that isn't on disk. `GET /api/admin/backup` lists finished backups. Anyone who isn't staff gets a 404.
2. Download the backup folder's files from the host's File Manager (Private Storage). GoDaddy limits each download to under 25 MB; the manifest's `downloadable` says whether every file fits. Keep downloads off GitHub and out of shared folders: they hold customer data.
3. Restore into a new, empty folder, never over a live one: `node scripts/restore-backup.mjs <backup folder> <new folder>`. It checks every hash against the manifest, runs `integrity_check`, compares row counts and prints the command to start an isolated demo-mode server on the copy with no mail or provider keys.

The server also takes the same backup on its own once a week. Each hour it checks whether the newest finished backup is at least `TICKETSTUB_BACKUP_EVERY_DAYS` old (default 7; `0` or `off` turns it off) and takes one if so, logging `[backup] scheduled <id> ok`. The age is read from the backups on disk, so restarts and deploys don't reset it. A lock file in `backups/` keeps the scheduled run, a staff POST and a second process (Preview and Publish share `/private` on Plus Launch) from running at once. It only runs when `TICKETSTUB_DB` and `TICKETSTUB_FILES` are both set. A scheduled backup still lives on the same disk as the database: download one now and then.

Nothing deletes backups. Prune `/private/backups` by hand, and only after the newest one has been restored and checked.

The deployed checks only the owner can run (sandbox flag off, restart survival, backup download, restore drill, real-email sign-in) are in [docs/operations/deployed-auth-storage-runbook.md](docs/operations/deployed-auth-storage-runbook.md).

### Verifying it (`verify:product`)

```
npm run build
npm run verify:product -- --suite foundation --mode fixture --evidence-dir out/evidence
```

| Suite | What it runs |
|---|---|
| `foundation` | route smoke for every page under `src/app`, the unknown-route 404, the error boundary, `/api/health`, and `/admin/x/y` entry and reload as staff, non-staff and anonymous |
| `access` | `scripts/smoke-server.mjs` against a production server (including the production-safe email-preview check, with no checks excluded) |
| `research` | `scripts/smoke-ticketmaster.mjs` on the saved Discovery sample |
| `creative` | `scripts/check-creative-adapter.mjs` |
| `a11y` | GT-11: axe-core on eight pages at 390 and 1280 px, overflow at 320, 640 and 200% zoom, a keyboard walk of the critical path with dialog focus, reduced motion, and the desk colours against WCAG AA, in a real headless Chrome (needs Chrome or Edge, or `CHROME_PATH`). `accessibility` is an alias. See `docs/product/accessibility.md` |
| `production` | `scripts/smoke-production.mjs` against a production server |
| `degraded` | a production server whose `TICKETSTUB_DB` and `TICKETSTUB_FILES` sit under a file, so storage can't be written: the 503s, the health fields, every page rendering 200, and `smoke:production` still passing |
| `mail-off` | #27: a production server with no `RESEND_API_KEY` and `TICKETSTUB_SANDBOX_MAIL` unset, `0`, `true`, empty or ` 1`: sign-in and email change answer 503 `mail_unavailable` with no `devLink`, the log holds no link and no full address, the stored link is a hash that lives 15 minutes, and the dev email preview is a 404. A control run with the flag at `1` must hand out a link, sets a `ts_session` cookie that is HttpOnly, SameSite=Lax, Secure, `Path=/` and 90 days, and the link works once |
| `backup-drill` | #27: seeds a wall, art, a share, an order and an organizer event through the app, takes `POST /api/admin/backup` as staff (404 for others), restarts on the same disk, restores with `scripts/restore-backup.mjs` into a new folder, re-checks hashes, `integrity_check` and row counts, and serves the copy. The evidence file's `drill` field keeps counts and hashes only |

`--mode fixture` is the only mode: the run starts its own production server on a free port with a throwaway database, no provider or mail keys, and `ADMIN_EMAILS` set to a test address, and it blocks every outbound host except loopback (`scripts/lib/fixture-network-guard.mjs`; a blocked attempt fails the run even if the code swallowed it). An unknown suite, a missing build or fixture, and any skipped check exit nonzero. Each run writes `<evidence-dir>/<suite>-<timestamp>.json` with the command, exit code, counts, timestamps, git SHA, mode and per-step results. `npm run build` must have run first. See `docs/architecture/routes.md` for the route and state map and `docs/adr/0001-runtime.md` for the runtime decision.

### For judging

Until `RESEND_API_KEY` is set and the sending domain has its DNS records, start the server with `TICKETSTUB_SANDBOX_MAIL=1` (for example `TICKETSTUB_SANDBOX_MAIL=1 npm start`). Sign-in links then show on screen as an "Open the link" button instead of being emailed, so anyone can try the live site without an inbox. This works in a production build. Remove the flag once real email is on. The deployed site follows #27: real email only, so leave the flag off there unless the deploy owner agrees to it for a judging window.

Sign-in is by emailed magic link only. The link opens a page ("One tap and you're in") and only the tap on its stamp uses the link up, so mail scanners that fetch links can't burn it. It works once and expires after 15 minutes, and the `ts_session` cookie (httpOnly, SameSite=Lax, Secure in production) lasts 90 days. Put the app behind HTTPS and a reverse proxy that sets `X-Forwarded-Host`, `X-Forwarded-Proto` and `X-Real-IP`.
## Related repositories

- [brand-kit](https://github.com/Jevelopers-neatHack-2026/brand-kit): brand tokens and assets used in [`src/brand`](src/brand/tokens.css) and [`public/brand`](public/brand)
- [shared-contracts](https://github.com/Jevelopers-neatHack-2026/shared-contracts): public schemas and compatibility fixtures
- [team-dashboard](https://github.com/Jevelopers-neatHack-2026/team-dashboard) and [landing-page-repo](https://github.com/Jevelopers-neatHack-2026/landing-page-repo): planned to integrate into this web deployment
- [integration-evals](https://github.com/Jevelopers-neatHack-2026/integration-evals): [acceptance tracking](https://github.com/Jevelopers-neatHack-2026/integration-evals/blob/main/planning/acceptance-checklist.md) and [submission evidence](https://github.com/Jevelopers-neatHack-2026/integration-evals/blob/main/evidence/README.md)
- [.github](https://github.com/Jevelopers-neatHack-2026/.github): organisation standards and templates

## Contributing

Follow the organisation [contribution guidance](https://github.com/Jevelopers-neatHack-2026/.github/blob/main/CONTRIBUTING.md). Keep secrets in server-side environment variables only, never `NEXT_PUBLIC_` names, and do not run paid provider calls without the project budget and authorization process.
