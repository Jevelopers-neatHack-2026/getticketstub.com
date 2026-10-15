# Routes and state map

GT-01 (#7). Read from the code at this revision, not from the plan. `npm run verify:product -- --suite foundation --mode fixture --evidence-dir <dir>` walks every page listed here and fails if a page is added without being declared (it discovers pages from `src/app`, so a new page is smoke-tested automatically; this document still has to be updated by hand).

Legend. **Owner** is the module that owns the behaviour, not a person. **Access** is who may load it: `public` (anyone with the URL), `guest` (an anonymous device session, drafts only), `account` (a verified emailed-link session), `owner` (account that owns the stub), `captain` (account that created the event), `staff` (account on `ADMIN_EMAILS`). Roles and capabilities come from `src/server/context.ts` and are never read from the browser. Most screens render for everyone and ask the server what the caller may do; the Access column says who gets useful content, and the API table says what the server enforces.

## Current `/` source and separate static-artifact handoff

- `/` is implemented by `src/app/page.tsx`: the app's own `src/customer/landing/` composition renders chrome, hero, rest and footer with `<StudioStart />` inserted after the hero. The hero form routes to `/new`; the inserted studio-start section retains its own print-in-place flow.
- PR [#104](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/pull/104) merged this host-owned landing into main. It does not import `landing-page-repo`; that repository still has a separate standalone static source and deterministic artifact build, and its artifact is not imported or served by this host.
- The in-app intake is `/make`: the same `<StudioStart fill />` with the sidebar around it. The sidebar's "Make" row, the breadcrumbs and every in-app "make another" link go to `/make`.
- Every existing link keeps working. `/` and `/parts` are the only routes without the sidebar (`NAV_FREE` in `src/customer/nav/routes.ts`). Share, claim and public-wall pages link back to `/` (a person arriving from a link has no sidebar context).
- Canonical app origin: `https://getticketstub.com` (`APP_URL`). The host owns and serves `/`. The separate landing repository's artifact path, mount, CTA and asset handoff remain owner-coordination work; do not describe that artifact as integrated until owners agree and the host checks are run.

## Pages

| Route | Owner | Access | Demo vs live | Notes |
|---|---|---|---|---|
| `/` | host `app/page.tsx` + `customer/landing` + `customer/start` | public | same; the demo notice banner shows in demo | Host-owned landing composition with the studio-start section; separate landing-page repository artifact is not mounted |
| `/make` | `customer/start` | public (guest) | demo: three demo events only | |
| `/search` | `customer/studio/research` | public (guest) | demo: demo events only, no Ticketmaster call | live: Ticketmaster Discovery via `/api/research` |
| `/new` | `app/new` | public (guest) | demo: fixtures only | The printing stage between intake and the editor. `?url=`, `?q=`, `?demo=`, `?pick=1`. With a finished stub it `replace`s to `/studio/<id>`; with no input it `replace`s to `/make`. |
| `/studio/[id]` | `customer/studio/editor` | owner on this device | art provenance `simulated` in demo | stubs live in the browser; the id is a device-local id |
| `/checkout/[id]` | `customer/pages` (commerce) | guest or account (order needs an email) | sandbox checkout, "Preview, not yet orderable" for unbacked SKUs | |
| `/wallet/[id]` | `customer/pages` | owner on this device | passes and QR are simulated | |
| `/friends/[id]` | `customer/pages` | owner on this device | | matching stubs for friends |
| `/gift/[id]` | `customer/pages` | owner on this device | | |
| `/wall` | `app/wall` | guest (local), account (synced) | | `?signin=expired` after a dead link |
| `/cart` | `customer/cart` | guest | sandbox | `hidden` in the sidebar; the count sits in the corner |
| `/cart/unclaimed/[id]` | `customer/cart` | guest | | |
| `/s/[token]` | `app/s` | public (link holder) | | unlisted: `noindex`. A stopped share (rotated token) is a not-found state. |
| `/u/[token]` | `app/u` | public (link holder) | | unlisted: `noindex`; torn stubs only |
| `/claim/[set]` | `app/claim` | account to redeem; public to view | | `noindex` |
| `/claim/g/[token]` | `app/claim/g` | account to redeem; public to view | | `noindex`; guest claim link from an organizer |
| `/organizer` | `app/organizer` | account (captain of the events it creates) | | publish needs a session |
| `/organizer/claim` | `app/organizer` | public (link holder) | | `noindex` |
| `/account` | `app/account` | account | | `noindex`; signed out shows the sign-in prompt |
| `/signin/confirm` | `app/signin` | public (link holder) | sandbox: the link shows on screen | `noindex`, `referrer: no-referrer`; only the tap on the stamp uses the link up |
| `/help` | `app/help` | public | | the desk map lives at the top |
| `/privacy`, `/terms` | `app/privacy`, `app/terms` | public | | |
| `/parts` | `customer/desk` | public | | the desk-parts board; no sidebar |
| `/admin`, `/admin/[...path]` | `app/admin` (host) + local `admin-fixture/1` | staff | the host fixture is rendered; team-dashboard package is not imported | everyone else: a real 404. See "Admin mount interface and current fixture". |
| `/_not-found` (any unknown path) | `app/not-found.tsx` | public | | warm copy; Make, Wall, Help |

### Redirects

| From | To | How | Why |
|---|---|---|---|
| `/map` | `/help` | `permanentRedirect` (308) in `app/map/page.tsx` | the desk map moved to the top of Help |
| `/new` (no input, no stub) | `/make` | client `router.replace` | nothing to print |
| `/new` (stub finished) | `/studio/<id>` | client `router.replace` | the printing stage hands over to the editor |
| `/api/auth/callback` (GET) | `/signin/confirm?token=` | 303 | a GET never uses a link up |
| `/api/auth/confirm` (POST) | `returnTo` + `signedIn=1`, or `/wall?signin=expired` | 303 | |
| `/api/account/email/confirm` (GET) | `/signin/confirm?token=` | 303 | |

## API routes

Guard behavior is route-specific. `checkOrigin`, checks that reject only a present foreign `Origin`, session/capability checks, consumer HMAC, provider webhook signatures, and intentionally public routes are distinct. The access column summarizes each route's caller boundary; it does not imply a shared Origin or capability guard. See the [HTTP API catalog](../api/HTTP-API.md) and [identity guide](identity.md) for the exact per-route behavior.

| Route | Methods | Access | Demo vs live |
|---|---|---|---|
| `/api/health` | GET | public | Returns `ok`, app `version`/`commit`, `mode` (`demo` or `live`), storage/persistence state and timestamp; the first storage probe may write a scratch table. It does not prove full application readiness or attest the deployed source revision. |
| `/api/context` | GET | public (answers for the caller) | the caller's own context plus a signed 5-minute token; `?project=` is a question, not an input |
| `/api/context/verify` | POST | server consumers | token verification for downstream consumers |
| `/api/auth/link` | POST | public, rate limited | sandbox mail returns `devLink` |
| `/api/auth/confirm`, `/api/auth/callback` | POST, GET | link holder | |
| `/api/auth/me`, `/api/auth/signout` | GET, POST | public / account | |
| `/api/account`, `/api/account/email`, `/api/account/email/confirm` | DELETE, POST, GET | account | |
| `/api/wall/sync`, `/api/wall/public` | POST, PUT/GET | account | |
| `/api/share`, `/api/share/[token]`, `/api/share/revoke` | POST, GET, POST | create: public; read: link holder; revoke: owner | share is private by default; revoke rotates the token |
| `/api/gift`, `/api/gift/[token]` | POST, GET and DELETE | create and revoke: owner of the stub; read: gift-token holder | the message exists only here, never in a share |
| `/api/u/[token]` | GET | link holder | |
| `/api/stub-image/[token]` | GET | link holder | image for email, rendered from a stored share |
| `/api/claim/[token]` | GET, POST | view: public; redeem: account | |
| `/api/organizer/events` | POST | account | |
| `/api/orders` | POST, GET | create: public with email; read: account | sandbox orders only |
| `/api/research` | POST | public | demo: fixtures only, arbitrary URLs refused (422). live: Ticketmaster / provider paths |
| `/api/art` | POST | public, quota by account, device and IP | demo: `simulated` art |
| `/api/agent` | POST | action protocol and live legacy path: require `agent.use`; non-live legacy path returns 204 before capability enforcement | non-live action protocol returns JSON from the deterministic rules planner, which may propose typed actions; legacy `{ event, message }` returns 204 |
| `/api/files/[name]` | GET | public (content-hashed name) | |
| `/api/dev/email-preview` | GET | dev only; 404 in production | |
| `/api/fulfillment/prodigi/callbacks/[token]` | POST | Prodigi (capability token in the path) | off unless `TICKETSTUB_PRODIGI_CALLBACKS=sandbox`: 404. A wrong token is a 404. Callbacks are untrusted hints; only an authenticated read changes state. See `docs/operations/prodigi-callbacks-runbook.md` |

## Route-state matrix

States a screen can show. `yes` means the code has a screen for it, `n/a` means it cannot happen there, and a blank is not built. "Recovery" is the action on that screen. The matrix was filled from the component sources (`FriendlyError`, `EmptyState`, `useAccount`, the sandbox labels); it is not a claim that every cell is covered by a browser test, which is a gap (see "Not yet verified").

| Route | loading | empty | success | partial | unsupported | unauthorized | cancelled | failure | Recovery |
|---|---|---|---|---|---|---|---|---|---|
| `/make`, `/search` | n/a | yes | yes | | demo: "try a demo event" | n/a | n/a | yes | search again, demo shortcuts |
| `/new` | yes | n/a | yes | | demo: 422 copy | n/a | yes (back to `/make`) | yes | Make, Search |
| `/studio/[id]` | yes | yes ("not on this device") | yes | art falls back to procedural | | n/a | n/a | yes | Wall, Make |
| `/checkout/[id]` | | yes | yes (sandbox) | "Preview, not yet orderable" lines | yes | sign in to pay | yes | yes | Wall, edit the stub |
| `/wallet/[id]`, `/friends/[id]`, `/gift/[id]` | | yes | yes (simulated) | | yes (simulated pass) | n/a | n/a | | Wall |
| `/wall` | | yes | yes | stubs not yet synced | | sign-in prompt | yes (dismiss prompt) | yes | sign in, Make |
| `/cart`, `/cart/unclaimed/[id]` | | yes | yes | | | n/a | n/a | | Make, Wall |
| `/s/[token]` | | n/a | yes | | | n/a | n/a | yes (link cut short, or share stopped) | Make |
| `/u/[token]` | | yes | yes | torn stubs only | | n/a | n/a | yes | Make |
| `/claim/[set]`, `/claim/g/[token]` | yes | yes | yes | | | sign in to claim | | yes (link cut short, server unreachable) | ask the organizer, retry |
| `/organizer`, `/organizer/claim` | | yes | yes | guests unpublished | | sign in to publish | | yes ("session ran out") | sign in again |
| `/account` | yes | yes | yes | | | sign-in prompt | | yes | sign in |
| `/signin/confirm` | | n/a | yes | | | n/a | | yes (expired link) | send a new link |
| `/admin/**` | n/a | n/a | yes (staff) | | n/a | real 404 | n/a | boundary (`error.tsx`) | Make, Wall, Help |
| unknown path | n/a | n/a | n/a | | n/a | n/a | n/a | `not-found.tsx` | Make, Wall, Help |
| any route, render error | n/a | n/a | n/a | | n/a | n/a | n/a | `error.tsx` (`global-error.tsx` if the root layout fails) | Try again, Make, Wall, Help |

## Reserved paths

These are reserved for the platform and for the landing page's artifact handoff; the landing page must not ship files at them.

- `/admin/*`: host-controlled admin space; currently renders a local fixture after the staff gate. A future team-dashboard package must stay below this prefix.
- `/api/*`: server routes, above.
- `/signin/*`: sign-in confirmation (`/signin/confirm` today).
- `/claim/*`: claim pages.
- Also in use: `/_next/*`, `/brand/*` (public brand assets).

## Landing-page handoff boundary (LP-01.C)

There is not yet an accepted integration contract for the separate `landing-page-repo` artifact. That artifact uses its own `/assets/...` URLs and intake; the host has its own implemented landing and intake. The earlier proposal for a static-artifact mount does not describe PR #104's app-native landing, and merging that host work did not integrate the separate artifact. Owners still need to agree on source/artifact form, route and asset mapping, intake ownership, script/style isolation, external asset/CSP allowances, rebuild/rollback and actual-host tests before that handoff is claimed. Until then, keep the host root and reserved-route ownership described above. See landing's [static output proposal](https://github.com/Jevelopers-neatHack-2026/landing-page-repo/blob/main/integration/static-output.md).

## Admin mount interface and current fixture

The app-owned display projection is `ticketstub.admin-mount/2` (`src/app/admin/contract.ts`). It carries no credential and does not redefine the Dashboard package interface. The current `AdminMount` renders the app-owned unavailable shell `src/app/admin/fixture/FixtureMount.tsx`; the actual `team-dashboard` package is not installed. See [trusted host boundary and remaining inputs](../integration/dashboard-host.md).

- **Base path.** `/admin`. The dashboard owns everything below it (`/admin/<anything>/<nested>`) and nothing above it. Routing is a single optional catch-all, `src/app/admin/[[...path]]/page.tsx`; segments are limited to `[A-Za-z0-9._~-]{1,64}` and depth 8, anything else is a 404.
- **Access.** Server-gated by `openAdminDashboard`, which calls `requireStaff` from `src/server/context.ts`: a verified account whose email is on `ADMIN_EMAILS` holds the `staff` role and the `admin.view` capability. Everyone else (anonymous, guest, signed-in non-staff) gets `notFound()`, a real 404 identical to a path that does not exist. The sidebar entry is cosmetic.
- **Reload and deep links.** Every `/admin/...` URL is server-rendered, so a hard reload or a pasted deep link (`/admin/x/y`) renders the same mount at the same path. The dashboard must derive its location from the `path` prop on first render and may use the host router for client navigation afterwards. Tested by `verify:product --suite foundation` (entry and reload, staff and non-staff).
- **Mount point.** `<AdminMount context={{ summary, finance, mount }} nav={...} path={[...]} />` is an app-owned display boundary. Its navigation bridge only accepts paths under `/admin` and preserves the server-validated selected project. Actual package adoption must implement its accepted host interface; replacing one import is insufficient.
- **Context.** Every request derives the account and selected `?project=stub:id` or `?project=event:id` from current server storage, issues a fresh five-minute `/2` context, and calls `verifyContextTokenLive` in process with the fixed `ticketstub.finance` audience. The credential remains in a server-only private handle. Only the display summary crosses into the client. Duplicate/malformed, foreign and missing project selections deny without distinguishing foreign from missing. No selection is the platform scope for staff; the internal nonstaff no-project state does not admit nonstaff to `/admin`.
- **Navigation injection.** `nav.root` is `{ label: "Admin", href: "/admin" }`: the first crumb of every dashboard page. `nav.items` are host-owned menu entries; the dashboard adds its own routes beneath. The host's sidebar shows an "Admin" row for staff only (`src/customer/nav/routes.ts`, `useStaff`, which reads `/api/context`).
- **Style ownership.** The host owns the root: `<main class="ts-admin desk-surface">` in `src/app/admin/layout.tsx`, with `admin.css` mapping the desk tokens to `--admin-*` variables. The package scopes every rule under `.ts-admin`, uses those variables, and never styles `html`, `body` or `:root`. The app is always cream paper; no dark stage.
- **React and runtime peers.** `react` and `react-dom` 19.3.x (`19.3.0` pinned here), `next` 16.4.x, Node `>=22.23.3 <23`, npm `>=11.16.0 <12`. The package must declare React as a peer dependency and must not bundle its own copy.
- **Pins.** The inspected Dashboard source is `eeefeb3497f3ce43fb9cc456ca67e5bbbe3b1a0f`; its Node `>=24.15.0 <25` declaration is incompatible with the app's Node 22 support range. Actual adoption requires an owner-accepted compatible artifact or runtime decision, plus the real Finance read port and consumer ACK. The app has not overridden that declaration. `admin-fixture/1` remains an explicitly unavailable shell, without financial data or synthetic fallback.
- **Read availability.** `GET /api/admin/dashboard` uses the same staff gate and fresh authority; it returns an uncached display projection with explicit restricted/unavailable Finance state. It accepts no authority token, tenant or grant. The production host has no configured Finance read adapter.
- **Fixture error route.** `/admin/fixture-error` throws on purpose for staff so the error boundary can be exercised on a real route.

## Not yet verified

- No browser test of the state matrix. `foundation` checks status codes and markup from the server, not that every cell renders.
- The error boundary UI renders in the browser; the smoke checks the 500, that nothing leaks, and that the boundary ships in the page's chunks.
- Owner approval and the landing owner's acceptance of the artifact contract are not recorded here.
