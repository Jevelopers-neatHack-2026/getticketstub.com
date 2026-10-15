# Trust boundaries and types

GT-01 (#7). Three kinds of data meet in this app and they are never the same type: what the browser sends (untrusted), what the server derives about the caller (trusted), and what a domain adapter exchanges with another repo's contract (local, versioned or proposed elsewhere). A value only crosses from one to the next through a named function, and each route must call the guards that apply to its boundary. The helpers below are not universal middleware: authentication, Origin checks, body-size limits and rate limits vary by handler. See the [HTTP API catalog](../api/HTTP-API.md) for route-specific behavior and [current architecture](CURRENT-STATE.md) for actual cross-repository connections.

```mermaid
flowchart LR
  subgraph Browser["Browser (untrusted)"]
    UI["customer/* screens<br/>localStorage stubs"]
    DTO["DTOs: Stub, Order body,<br/>URL, ?project=, tokens"]
  end
  subgraph Server["Server (trusted)"]
    HTTP["src/server/http.ts<br/>route(), checkOrigin, readJson, limit"]
    VAL["src/server/validate.ts<br/>readStub, parseEmail, parseToken,<br/>safeReturnTo, parseText"]
    CTX["src/server/context.ts<br/>getRequestContext, requireCapability,<br/>issueContextToken"]
    ST["src/server/storage.ts / sqlite.ts<br/>tenants, projects, sessions"]
    PRJ["src/server/project.ts<br/>publicStub projection"]
  end
  subgraph Adapters["Domain adapters (contracts owned by other repos)"]
    CRE["customer/studio/creative/*<br/>creative-engine brief, controls"]
    TM["customer/studio/research/ticketmaster*.ts<br/>Ticketmaster Discovery, event-intelligence"]
    COM["customer/pages/commerce.ts, capabilities.ts<br/>orders, supplier capability map"]
  end
  DASH["team-dashboard<br/>(future package; host fixture now)"]

  UI --> DTO --> HTTP --> VAL --> CTX
  CTX --> ST
  ST --> PRJ --> UI
  CTX -- "issueContextToken" --> DASH
  DASH -- "token, verified server side" --> CTX
```

The diagram shows the trust path for routes that derive caller context. The adapter inventory below is not a universal runtime chain: the research route is public and has its own Ticketmaster path, the creative-engine adapter is a pure local mapping layer, and commerce operations have their own route/service boundaries.

## 1. Untrusted: browser DTOs

Everything that arrives in a request is a claim, not a fact: bodies, query strings, URL tokens, cookies' contents, `Origin`, ids, roles, and "project" names. Types for these live with the screens that send them (`src/customer/studio/types.ts` `Stub`, `src/customer/pages/commerce.ts` `Order`, `src/customer/account/api.ts` client calls) and are **not** reused on the server as proof of anything.

Where they are checked:

- `src/server/http.ts`: the handler wrapper `route()` turns thrown `HttpError`s into the `{ error: { code, message } }` shape. A handler must explicitly call `checkOrigin` to enforce the shared origin rule, `readJson` to apply its supplied byte ceiling before parsing, and `limit` to apply a process-local rate limit. The research route does not currently call those origin, capability or route-limiter guards; `/api/art` uses streaming `readJson()` with a 256 KiB byte ceiling. See the route catalog and [HTTP origin boundaries](../operations/http-boundaries.md).
- `src/server/validate.ts`: reusable runtime validation. `readStub` size-caps and checks a stub body; `parseEmail` / `parseAccountEmail`, `parseToken` (URL tokens), `safeReturnTo` (no open redirects), and `parseText` validate their named values when called. Routes use different combinations, and TypeScript types alone prove nothing about request data.
- Other domain inputs get their own checks at the route: `src/app/api/research/route.ts` (URL allow-listing, demo mode refuses arbitrary URLs), `src/app/api/art/route.ts`, `src/app/api/orders/route.ts`.

## 2. Trusted: server-derived context

`src/server/context.ts` is the only place that answers "who is this, and what may they do". The `RequestContext` (`src/server/context-token.ts`) is derived from the httpOnly session cookie or the guest device cookie plus storage records, never from a body, query string or URL token. A route may name a project (`getRequestContext(req, { id, kind })`) and the answer is the caller's role on it; a project the caller cannot prove is theirs is role `none` and a 404, exactly as if it did not exist.

- Tenant: an account is a tenant; a guest is `guest:<id>` (drafts only). Stubs and organizer events are projects.
- Roles: `owner | captain | member | viewer | staff | none`; capabilities come from one matrix, `CAPABILITY_MATRIX`. Today the only organizer role is captain. Staff are accounts on `ADMIN_EMAILS` and hold only `admin.view`; they get no read access to anyone's projects.
- Enforcement: `requireCapability(ctx, cap)` throws a 404 (admin and invisible projects), 401 (not signed in) or 403.
- Downstream: `issueContextToken(ctx)` signs a versioned (`ticketstub.context/1`), five-minute copy for the dashboard and other consumers; `verifyContextToken` / `verifyContextTokenLive` check signature, version, expiry, and (live) revocation and membership revision.
- Outbound projection: `src/server/project.ts` (`publicStub`) removes guest lists, private notes, photos and account data from anything a link holder can read.

## 3. Domain adapter types

Each adapter converts between our `Stub`/`Order` types and a contract owned by another repo. The contract is a proposal there; the adapter is the single place our types touch it, and it is checked offline against that repo's fixtures.

| Adapter | Files | Contract owner | Check |
|---|---|---|---|
| Creative engine | `src/customer/studio/creative/` (`contracts.ts`, `controls.ts`, `adapter.ts`, `fixtures/`), `docs/integration/creative-engine.md` | creative-engine | `scripts/check-creative-adapter.mjs` (`verify:product --suite creative`) |
| Ticketmaster / event intelligence | `src/customer/studio/research/ticketmaster.ts`, `ticketmasterPackage.ts`, `docs/integration/event-intelligence.md` | event-intelligence | `scripts/smoke-ticketmaster.mjs` against `scripts/fixtures/ticketmaster-discovery-event.json` (`--suite research`) |
| Commerce and supplier capabilities | `src/customer/pages/commerce.ts`, `src/customer/pages/capabilities.ts`, `src/app/api/orders/route.ts` | print-production / fulfillment (supplier SKUs) | `--suite production` smoke (demo mode only) |
| Dashboard | `src/app/admin/contract.ts` (`ticketstub.admin-mount/1`) | team-dashboard | `--suite foundation` (host admin fixture; team-dashboard package is not imported) |

Rules that follow from this:

1. A browser DTO is never passed to an adapter or to storage unvalidated, and an adapter type is never sent to the browser without a projection.
2. A route that needs caller authority derives it from server context and checks the required capability at that boundary. Screens and the dashboard may hide things; they never grant anything. Routes that are intentionally public still need their own exposure limits and input rules.
3. When `TICKETSTUB_RUNTIME_MODE` is not `live`, external behavior is still route-specific: research uses fixtures, art is `simulated`, and the schema-bearing action-agent protocol returns its JSON response from the deterministic rules planner, which may propose typed actions. The legacy `/api/agent` `{ event, message }` branch, not the action-protocol branch, returns HTTP 204 in non-live mode. This is not a general promise that every handler is inert. `verify:product` runs the documented product checks with outbound network blocked; see the [runtime configuration](../operations/preview-runtime.md).
4. No adapter invents ownership of work another repo does. Research, creative production, print production, fulfillment and the ledger are specified there; this app consumes them through these adapters.
