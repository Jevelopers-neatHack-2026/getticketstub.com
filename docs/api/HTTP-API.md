# HTTP API reference

**Source snapshot:** [`getticketstub.com` main `138e4b9019c0f5a55ad5e3f586d129216b680e4d`](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/tree/138e4b9019c0f5a55ad5e3f586d129216b680e4d), audited 2026-10-12. The app-native landing changes merged after the API boundary review did not change route handlers. This is a source-derived reference to the route handlers in `src/app/api/**`; it is not an OpenAPI document, an owner-approved cross-repository contract, or a deployment probe. Payloads can change with source. Pin the source and rerun the checks before relying on an endpoint.

The examples and field descriptions below use synthetic shapes and placeholders. The audit made no API calls and does not include credentials. Do not paste customer, ticket, payment, provider, or live token data into example requests.

## HTTP and trust conventions

There is no single API authentication or request-validation rule. A route's security check depends on what it does:

| Request class | How the source authorizes it |
|---|---|
| Session/account route | Server reads the httpOnly `ts_session` cookie and derives identity, project scope and capabilities from storage. Some routes also allow a guest-device cookie; an anonymous or guest actor is not an account. |
| Public projection/link route | An unlisted path token is the capability to read the specifically projected resource. It does not grant account identity or general project access. Some token routes are read-only; `GET /api/gift/[token]` also records the first open. |
| Signed consumer route | Order-authorization consumer endpoints verify a timestamped HMAC request using `ORDER_AUTH_CONSUMER_KEY`, then validate the authorization token and expected terms. Cookie and `Origin` are not used for this server-to-server class. |
| Provider webhook | Dodo or Stripe signature verification uses the provider-specific verifier and the raw body. Do not send a browser session or treat a successful HTTP response as payment proof without checking the handler's verified provider readback. |
| Public/status/input route | A few routes accept public requests without a caller capability. `GET /api/health` is public. `/api/research` currently has no `Origin`, caller-capability, or route-rate-limit guard; see the research row and security notes below. |

`requireCapability` returns 404 for an invisible project or missing `admin.*`, 401 when an account is required but the request has no account, and 403 for an insufficient signed-in project role. It is not called by every route. A `checkOrigin` route requires an `Origin` equal to the exact trusted origin. On a public deployment that origin comes only from a valid, credential-free `APP_URL`; `Host`, `x-forwarded-host`, and `x-forwarded-proto` do not establish it. Without configured `APP_URL`, only a loopback request URL is trusted. `/api/art` and `/api/agent` reject a present foreign origin but allow no `Origin`; if one is present they use the same exact authority check. Consumer HMAC and webhook signature checks are separate trust controls. `/api/research` has no origin check in this source snapshot. See [HTTP origin boundaries](../operations/http-boundaries.md) for deployment details.

The shared `route()` wrapper converts thrown `HttpError`s to `{ "error": { "code": "…", "message": "…" } }` and unexpected failures to a bounded 500 `internal` response. Some endpoints return custom verdict objects, redirects, no-content responses, image bytes, or `NextResponse` values, so that envelope is not universal. `json()` defaults to `Cache-Control: no-store`; handlers that build another response can use different cache rules. Where mutable response headers are available the wrapper adds an `x-request-id`; that is a trace identifier, not an idempotency key. Storage-failure telemetry now categorizes route templates using a fixed internal allowlist; dynamic path segments are not retained as route labels.

The `limit()` helper is a process-local fixed-window limiter. Its 429 response includes `Retry-After` in seconds. Limits reset on restart and are not shared across multiple Node instances. They do not apply to routes that do not call the helper. JSON byte limits are per handler; the source uses `readJson()` on many routes, but `/api/art` uses `req.json()` without an explicit route-level byte ceiling. See [identity and known limits](../architecture/identity.md#known-limitations) and [security boundaries](../architecture/boundaries.md).

## Auth, account, and operations

| Method and path | Caller / guard | Input and success | Limits and failure behavior |
|---|---|---|---|
| `POST /api/auth/link` | Public; `checkOrigin`, storage and link rate limits | JSON `{ email, reason: "save"\|"checkout"\|"claim", returnTo?, shareToken? }`. Creates a 15-minute, single-use link. Returns `{ ok: true }` after delivery, or `{ ok: true, sandbox: true, devLink }` when sandbox-mail rules permit it. | Body ≤4 KiB; 20 requests/IP and 5/email per 15 minutes. Invalid/disposable email or unsafe return path is 400. If mail is unavailable and sandbox mail is disabled, 503 `mail_unavailable`. Repeating the request creates and sends a new link; no idempotency key is defined. Sandbox link display depends on `NODE_ENV !== "production"` or `TICKETSTUB_SANDBOX_MAIL=1`, independently of `TICKETSTUB_RUNTIME_MODE`. A public deployment also needs a valid `APP_URL`; absent/invalid authority fails the origin check before a link is stored or sent. |
| `GET /api/auth/confirm?token=…` | Public link lookup | Returns a confirmation summary (`valid`, kind/reason, masked email and optional share token); it does **not** consume the link. | Invalid/expired links return a false validity result. The query token is treated as a credential; do not put real links in logs or issue comments. |
| `POST /api/auth/confirm` | Link holder; `checkOrigin` | JSON `{ token }` or URL-encoded `token`. A sign-in link creates a session cookie and redirects with 303 to its local destination; an email-change link updates the address and redirects to `/account` status without setting a session cookie. | For either encoding, the handler rejects a declared `Content-Length` over 4096. JSON uses streaming `readJson` with a 4096-byte ceiling. URL-encoded input is read as text and only then checked with JavaScript `text.length` (UTF-16 code units); without an accurate declared length, this is not a streaming 4096-byte ceiling. Invalid or expired links redirect to the relevant expired-link UI rather than returning the usual JSON authorization error. GET is intentionally non-consuming so mail scanners do not use a link. |
| `GET /api/auth/callback?token=…` | Public legacy route | 303 redirect to `/signin/confirm?token=…`. | Token copied with a 200-character cap; does not consume it. |
| `GET /api/account/email/confirm?token=…` | Public legacy route | 303 redirect to `/signin/confirm?token=…`. | Token copied with a 200-character cap; does not consume it. |
| `GET /api/auth/me` | Public, based on any current session | Returns `{ account: { id, email }\|null, storage: "ok"\|"unavailable" }`. | Returns the current actor view; it does not accept an account id from the caller. |
| `POST /api/auth/signout` | Session; `checkOrigin` | Optional JSON `{ everywhere: true }` revokes every account session; otherwise only the current session is removed. Returns `{ ok: true }` and clears the cookie. | If optional body parsing fails it falls back to ordinary sign-out. `everywhere` needs `session.revoke`. There is no cross-account target field. |
| `POST /api/account/email` | Account with `account.email.change`; `checkOrigin` | JSON `{ email }`. Sends a confirmation link to the new address; the account changes only after that link is used. | Body ≤4 KiB; 20/IP and 5/account per 15 minutes. Same address and disposable domains are 400. Delivery failure is 503 unless sandbox mail applies. |
| `DELETE /api/account` | Account with `account.delete`; `checkOrigin` | JSON `{ confirm: "<account email>" }`. A match permanently removes the account and its sessions and clears the session cookie. | Body ≤1 KiB. A missing or unequal confirmation is 400 `confirm_mismatch`. Orphaned artwork files are removed; shared-by-hash files remain. Treat this operation as irreversible. |
| `GET /api/admin/backup` | Staff with `admin.view` | Returns `{ backups: [...] }` for completed backups. | Non-staff receives the host's concealed 404. This is local listing, not a download endpoint. |
| `POST /api/admin/backup` | Staff with `admin.view`; `checkOrigin`, storage, per-account limiter | Creates a consistent database and artwork backup and returns `{ backup: manifest }` (201 when its integrity status is `ok`). | 6 requests/account/hour; 409 `backup_running` if another backup owns the lock; failed integrity returns 500. Files are written beside the configured database. Restore is a separate operator procedure. |
| `GET /api/admin/harness` | Staff with `admin.view` | Returns `{ harness: status }`. | Hidden 404 for non-staff. |
| `POST /api/admin/harness` | Staff with `admin.view`; `checkOrigin` and per-account limiter | Drains the local harness and reads back status; returns `{ drain, harness }`. | 20/account/hour. It may have downstream effects if a deployment has integrations configured. It was not called for this documentation work. |
| `GET /api/health` | Public | Returns `{ ok, version, commit, mode, storage, persistence, time }`. | HTTP 200 is availability/status output, not a complete readiness or source-release attestation. The first storage probe can write and read a scratch table. |
| `GET /api/dev/email-preview` | Development only | Query `kind=link\|receipt\|email`, `reason=save\|checkout\|claim`, optional `text=1` and `share`; returns preview HTML or text. | 404 in `NODE_ENV=production`. No real email is sent by this preview route. |

## Context and approvals

| Method and path | Caller / guard | Input and success | Limits and failure behavior |
|---|---|---|---|
| `GET /api/context` | Public; derives current caller from cookies | Optional `project=stub:<id>\|event:<id>` and `v=1\|2` (default 1). Returns `{ context, token }`; an invalid version is 400 and an unowned project is concealed as 404. `/2` may return a null token for a revoked session. | Token lifetime is five minutes. Project query is a request to select a scope, never proof of access. |
| `POST /api/context/verify` | Public signed-token verifier; no cookie or `Origin` requirement | JSON `{ token, audience? }`; returns `{ ok: true, context }` or a 401 refusal with reason/error. `/2` requires the expected audience. | Body ≤16 KiB; 120/IP/minute. It verifies the token against current session, membership and mode state when using the live verifier. |
| `GET /api/approvals?project=stub:<id>` | Owner with `stub.approve`; storage | Returns `{ approvals }` for the selected stub. | 120/IP/minute. Missing/unowned project follows the concealed access result. |
| `POST /api/approvals` | Signed-in owner with `stub.approve`; `checkOrigin` | JSON `{ stubId, purpose: "print.compose"\|"artifact.download", expectedVersionId, size? }`. Returns the issued approval/status/token and creation information. | Body ≤2 KiB; 60/IP/15 minutes. Approval binds the selected version and purpose-specific artifact hashes. It is not purchase authority. See [approval model](../architecture/approval.md). |
| `POST /api/approvals/revoke` | Owner with `stub.approve`; `checkOrigin` | JSON `{ stubId, approvalId }`; returns `{ ok: true, revoked: true, already }`. | Body ≤1 KiB; 60/IP/15 minutes. Unknown/non-owned records are not disclosed. Revocation does not erase the artifact. |
| `POST /api/approvals/verify` | Public verifier of signed token; no session cookie or `Origin` | JSON `{ token, expect: { tenant, project: "stub:<id>", purpose, content: { designHash?, artHash?, factsHash?, compositionHash? } } }`. Returns a verified approval and check time, or a bounded refusal verdict. | Body ≤16 KiB; 120/IP/minute. At least one 64-hex content hash is required; print composition requires all four hashes and download checks the art hash. Malformed input is 400; failed verification is 403. |

The approval token only records sign-off on the exact reviewed output. It never authorizes purchase. Verification input semantics and reasons are maintained in [approval docs](../architecture/approval.md) and the fixture README.

## Order authorization and orders

| Method and path | Caller / guard | Input and success | Limits and failure behavior |
|---|---|---|---|
| `GET /api/order-authorizations?project=stub:<id>` | Signed-in owner with `order.authorize` | Returns `{ authorizations }` for the selected stub. | 120/IP/minute. |
| `POST /api/order-authorizations` | Signed-in owner with `order.authorize`; `checkOrigin` | JSON `{ stubId, approvalId, expectedVersionId, orderRef, quote: { id, amountMinor, currency }, destination: { ref, digest }, idempotencyKey, confirm: true, quantity?, provider? }`. Returns the signed authorization view/token and creation time. | Body ≤4 KiB; 30/IP/15 minutes. `quantity` defaults to 1 and is bounded 1–100; provider defaults to `sandbox` and accepts `sandbox\|prodigi`. `orderRef` is an opaque 8–64-character value; quote amount is an integer 1–100,000,000; destination ref 8–128 chars and digest 64 hex. Not-orderable terms fail 422. See [order authorization](../architecture/order-authorization.md) for complete terms and claim semantics. |
| `POST /api/order-authorizations/revoke` | Owner with `order.authorize`; `checkOrigin` | JSON `{ stubId, authorizationId }`; returns `{ ok: true, revoked: true, already }`. | Body ≤1 KiB; 60/IP/15 minutes. Revocation cannot undo a dispatch that a consumer already made. |
| `POST /api/order-authorizations/verify` | Signed connector consumer; HMAC and storage | JSON `{ token, expect: { tenant, project: "stub:<id>", action, provider, terms } }`; returns a verified authorization or a bounded refusal. | 600/IP/minute; body ≤8 KiB. Requires `ORDER_AUTH_CONSUMER_KEY` (32+ non-fixture chars) and valid timestamp/signature headers. |
| `POST /api/order-authorizations/claim` | Signed connector consumer; HMAC and storage | JSON `{ token, idempotencyKey, expect }`; returns committed claim and replay state. | Same consumer limit and key requirement; body ≤8 KiB. Idempotency key is 8–128 chars from `[A-Za-z0-9_.:-]`. Same key replays the same committed claim while authorization remains valid; another key after claim gives 409 `already_claimed`; key reuse on another authorization gives 409 `idempotency_conflict`. |
| `POST /api/order-authorizations/revalidate` | Signed connector consumer; HMAC and storage | JSON `{ token, expect: { …, claimReference } }`; returns `dispatchable` only after current term, approval, membership and claim checks. | Same consumer limit and key requirement; body ≤8 KiB. Call immediately before dispatch; this result is not a durable permission to retry a provider submission later. |
| `POST /api/order-authorizations/claims/lookup` | Signed connector consumer; HMAC and storage | JSON `{ tenant, project: "stub:<id>", idempotencyKey, authorizationId? }`; returns `{ ok: true, found, … }`. | Same consumer limit and key requirement; body ≤2 KiB. `found: false` reports no committed claim for the key; it does not grant permission to issue a different attempt. |
| `POST /api/orders` | Guest or account with `order.create`; `checkOrigin` | JSON `{ order, attemptId? }`; returns `{ order, checkoutUrl? }`. The server derives each variant status from its capability map and sets currency to USD. Before a paid provider call it recomputes and checks the total; a local sandbox-only order is not a charge or a trusted finance record. A guest needs a receipt email; an account order uses the caller's address. | Body ≤64 KiB; 30/IP/15 minutes. `order` requires `stubIds` (up to 200), `lines` (1–200), `totalMinor` (integer 0–100,000,000) and `method` (`apple-pay\|google-pay\|card\|gift-print\|organizer-print`). Every line requires `title`, `material` (`digital\|card\|print\|framed`), `finish` (`matte\|foil\|holo`), `size` (`classic\|stamp\|framed\|file`) and integer `totalMinor` (0–100,000,000). Optional `quoteId` is a string up to 200 characters and optional `email` is validated. `attemptId` must be 16–64 `[A-Za-z0-9_-]` characters when a paid provider is selected. An unavailable variant is 422; provider failure is 502; a closed checkout is 409. A created checkout is not proof of payment or physical fulfillment. The public-origin requirement applies to same-origin browser requests as well. |
| `GET /api/orders` | Signed-in account with `order.read` | Returns that account's `{ orders }`. | No arbitrary account id is accepted. |

Consumer requests use `x-ticketstub-consumer-timestamp` (milliseconds) and `x-ticketstub-consumer-signature` (lowercase 64-hex HMAC-SHA256) over `timestamp + newline + METHOD + newline + pathname + newline + sha256(exact request body)`. Allowed clock skew is five minutes. An unset/fixture key returns 503; a missing or invalid signature returns 401. Never expose or copy the key into a client bundle. Verification, claim, lookup and revalidation have different effects; details and reason codes are in [order authorization](../architecture/order-authorization.md).

## Wall, sharing, events, and files

| Method and path | Caller / guard | Input and success | Limits and failure behavior |
|---|---|---|---|
| `POST /api/wall/sync` | Account with `wall.sync`; `checkOrigin` | JSON `{ stubs, deleted }`; returns merged `{ stubs, deleted, now }`. Ownership is always the session account; body ids do not select another account. | Body ≤32 MiB; at most 1,000 stubs and 1,000 deleted ids. Stub data is revalidated; photos are removed/externalized and remaining serialized stub is capped at 2 MiB. Over limit is 413. |
| `GET /api/wall/public` | Account with `wall.publish` | Returns the account's wall-public record. | Does not expose another account's token. |
| `PUT /api/wall/public` | Account with `wall.publish`; `checkOrigin` | JSON `{ isPublic: boolean, rotate?: boolean }`; returns the resulting public token/state. Rotating replaces the old link. | Body ≤1 KiB. |
| `POST /api/share` | Owner/device with `share.create`; `checkOrigin` | JSON `{ stub }`; returns `{ token }` and may set the guest device cookie. | Payload ≤9 MiB plus 1 KiB; 60/IP/15 minutes. Existing share for that owner/device and stub is reused until revoked. Stored/output view is projected; it omits private fields. |
| `GET /api/share/[token]` | Holder of unlisted share token | Returns a projected `{ stub }`, or 404. | Token is the narrow read capability. Private notes, guests, photos, ticket/barcode and account data are not exposed. |
| `POST /api/share/revoke` | Stub owner with `share.revoke`; `checkOrigin` | JSON `{ stubId }`; returns `{ ok: true, revoked }`. | Body ≤1 KiB; 60/IP/15 minutes. Old link becomes not found; a later share creates a new token. |
| `POST /api/gift` | Owner/device with `gift.create`; `checkOrigin` | JSON `{ stub: <id>, to, message? }`; returns `{ giftToken, sharePath }`. The stub must already be shared. | Body ≤4 KiB; 60/IP/15 minutes. Recipient name is normalized/capped at 40 chars; message ≤280 chars, with control characters stripped. Overlong message is 400. |
| `GET /api/gift/[token]` | Holder of unlisted gift token | Returns `{ stub, to, message, openedAt }`, with `noindex` response policy. | 120/IP/15 minutes. **This GET records the first open** unless the opener is the owner. The message remains until revoked, share stopped, or account deleted; the token does not expire. |
| `DELETE /api/gift/[token]` | Owner with `share.revoke`; `checkOrigin` | Returns `{ ok: true, revoked }`; removes the gift/message. | 60/IP/15 minutes. |
| `GET /api/u/[token]` | Holder of public-wall token | Returns only torn/public-projected stubs or 404. | Link token must pass the server's token parser. |
| `POST /api/organizer/events` | Account with `event.create`; `checkOrigin` | JSON `{ title, stub, guests: [{ name, seat? }], expiresInDays? }`; returns `{ eventId, claims: [{ token, name, seat? }] }`. | Body ≤9 MiB plus 256 KiB; title ≤200 chars; 1–500 guests; guest name ≤120 and seat ≤60; expiry 1–365 days, default 30. It creates local event/claim records; it does not email guests or submit fulfillment. |
| `GET /api/claim/[token]` | Public claim-link holder | Returns projected `{ stub, guestName, seat?, claimed, expired }`. | Missing/invalid token is not found; public view does not redeem it. |
| `POST /api/claim/[token]` | Account with `claim.redeem`; `checkOrigin` | No body-supplied owner id is accepted; a valid claim moves the stub to the caller's wall. | Same account repeating is idempotent; another account after a claim gets 409 `already_claimed`; expired token is 410. |
| `GET /api/events` | Staff with `admin.view` for `scope=all`, or permitted project scope | Returns up to 200 newest sanitized event records. | Event output is an operational projection, not a full request/response log. |
| `POST /api/events` | `checkOrigin`; for a valid supplied `project`, derives context for that stub and returns 404 if its role is `none`; without `project`, no capability or `admin.view` is required. | JSON `{ type, project?, fields? }`; accepts only `version_selected` or `fact_corrected`, sanitizes the fields, and returns `{ ok: true }`. | `readJson` cap 2 KiB; 120/IP/15 minutes. A syntactically valid but unseen/non-owned project is 404. `recordEvent()` derives/records actor context and sanitizes data; it does not enforce a capability. |
| `GET /api/files/[name]` | Public possession of a content-hash filename | Returns bytes with content type/length, `nosniff`, sandbox CSP and one-year immutable public cache. | Only strict content-hash filenames are served; invalid/missing file is 404. It is not an account-private download endpoint, and revoking a share does not erase or invalidate a previously cached art URL. |
| `GET /api/stub-image/[token]` | Holder of a share token | Returns a 960×400 image response or a generic brand card. | Only local stored or bounded data-URL artwork is considered; it does not fetch a remote image. Successful card response is publicly cached for one hour. |

## Research, agent, art, and payment callbacks

| Method and path | Caller / guard | Input and success | Limits and failure behavior |
|---|---|---|---|
| `POST /api/research` | Public in the current handler | JSON `{ url?, query? }`. Query-only requests return up to five simulated fixture suggestions. URL requests return app-owned event data and may include Ticketmaster/package-shaped metadata. | `readJson` cap 8 KiB; URL ≤2,048 chars and query ≤200. No `Origin`, caller capability, or route limiter is present in this source snapshot. In non-live mode arbitrary URLs are rejected; unsupported inputs fail 422. Live page fetch timeout is 8 s, raw page cap 2,000,000 bytes / decoded text cap 4,000,000, with up to 3 redirects; selected network/5xx failures get one retry. Source API fetch timeout is 6 s. Not every fact is verified, and unknowns remain pending. |
| `POST /api/agent` | Public `agent.use`; rejects present foreign `Origin`, permits missing `Origin` | Current action protocol `ticketstub.agent-action/1` accepts `{ schema, state, message?, results?, pending? }` and returns `{ schema, reply, actions, provenance }`. It proposes changes; it does not apply them. A legacy `{ event, message }` shape remains supported. | Action body ≤24,000 bytes, message ≤400, up to 4 actions, 12 facts and 6 results; action path 120/IP/15 minutes. Demo mode produces deterministic rule-based typed proposals (`provenance: "rules"`). A malformed live response gets one repair attempt before a safe no-action response. Explicit OpenRouter errors are surfaced. Legacy path has separate behavior; do not apply action-protocol limits to it. |
| `POST /api/art` | Public `art.generate`; rejects present foreign `Origin`, permits missing `Origin` | JSON `{ event, vibe?, seed?, edition?, first?, simulate? }`; returns an `ArtLayer` directly, or procedural fallback with a quota refusal. | `req.json()` has no explicit route byte ceiling. Normalized title ≤300 chars and at most 200 facts; vibe ≤120 chars. Actual generation limits are 10/day/account, 10/day/device and 30/day/IP in SQLite. Repeated live calls can consume allowance; no request idempotency key exists. Text/image provider timeouts are 15/90 s. A simulated response does not imply a provider call. |
| `POST /api/payments/stripe/webhook` | Stripe-signed provider callback | Verifies the provider signature against the raw body; reads the Checkout session back from Stripe before settling a local order. Acknowledges irrelevant/missing order events as `{ ok: true, handled: false }`; accepted event returns a bounded success result. | Raw body ≤512 KiB; missing config returns 503 `payments_off`; bad signature 401; malformed event 400; provider readback failure 502. A paid transition that needs a receipt also needs a trusted public origin; `503 origin_unavailable` rolls back the local transition so provider redelivery can retry it. Settlement is forward-only once committed. Do not settle from webhook JSON alone. |
| `POST /api/payments/dodo/webhook` | Dodo-signed provider callback | Uses the Dodo `verifyWebhook(headers, raw body)` helper, accepts supported payment events, reads the payment back from Dodo, checks currency/amount/order binding, then settles. | Raw body ≤256 KiB; missing config 503 `payments_off`; invalid signature 401; malformed event 400; provider readback failure 502. A paid transition that needs a receipt also needs a trusted public origin; `503 origin_unavailable` rolls back the local transition so provider redelivery can retry it. The header names/algorithm are defined by the verifier; this guide does not invent them. |

Payment callback source and handler existence do not prove an enabled live checkout, provider account setup, successful live payment, physical SKU, or end-to-end fulfillment. No callback or paid provider was called during this documentation audit.

## Wire models and offline examples

The route catalog above summarizes each handler's actual branch and guard. These source types and parsers define the detailed shapes; they are maintained with the application rather than as a separate, inferred OpenAPI contract.

| Shape | Required and optional fields | Source of truth |
|---|---|---|
| Research/art `EventData` | Required: `type` (`concert\|game\|show\|generic`), `title`, `facts`. Optional: `subtitle`, `venue`, `city`, `dateISO`, `seat`, `sourceUrl`, `setlist[]`, `score`, `cast[]`, `programme[]`, `assets[]`, `providerMetadata`. Each `Fact` requires `id`, `label`, `value`, `source`, numeric `confidence`, and `provenance` (`live\|sandbox\|simulated\|estimated\|pending`); optional fields are `sourceUrl`, `alternatives[]`, `kept`, and `retrievedAt`. | [`EventData`, `Fact`, and `ReviewAsset`](../../src/customer/studio/types.ts); route-specific behavior is in [`research/route.ts`](../../src/app/api/research/route.ts) and [`art/route.ts`](../../src/app/api/art/route.ts). `/api/art` reads only a normalized subset and does not enforce every TypeScript field at runtime. |
| Order request | `{ order, attemptId? }`. `order` requires `stubIds[]`, `lines[]`, `totalMinor`, and `method`. Every line requires `title`, `material`, `finish`, `size`, and `totalMinor`. Optional order fields are `quoteId` and `email`; input `variantStatus`, currency, and other extra fields are not trusted. | [`parseOrder` in orders/route.ts](../../src/app/api/orders/route.ts), [`Order`](../../src/customer/pages/commerce.ts), and [`capabilities.ts`](../../src/customer/pages/capabilities.ts). |
| Agent action protocol | Top-level required `schema`, `state`, and either `message` or non-empty `results`; optional `pending` requires a message. State requires `title`, `facts[]`, `edition`, `material`, `finish`, `art`, and `versions`; optional `subtitle`, `dateISO`, `venue`, `city`. State facts require `id`, `label`, `value`, `kept`, `provenance`. `actions[]` is a closed union: `set_fact`, `set_style`, `set_material`, `set_finish`, `set_text`, `remix_art`, `show_back`, `ask_user`, `none`. | [`protocol.ts`](../../src/customer/studio/agent/protocol.ts) parser and types; [`agent/route.ts`](../../src/app/api/agent/route.ts) route mode and response. Exact action subfields, enums, strict unknown-field rejection, and caps are in the source. |
| Signed consumer expectation | `expect` requires `tenant`, `project` as the string `stub:<id>`, `action`, `provider`, and all `terms`: `orderRef`, `sku` (string or `null`), `options` (`variantId`, `material`, `finish`, `size`, `quantity`), `quote` (`id`, `amountMinor`, `currency`), `destination` (`ref`, 64-hex `digest`), `design` (`versionId` and four 64-hex hashes), `approvalId`, and `capabilityVersion`. | [`OrderAuthExpectation` and `OrderAuthTerms`](../../src/server/order-auth-token.ts), plus [`parseExpect` and `parseTerms`](../../src/server/order-authorization.ts). The source narrows field lengths and numeric ranges. |

The following examples are syntax-checked JSON with invented event/order data. They document possible shapes only. They were **not submitted**. Do not run the order example: a guest request can create a local record and attempt receipt delivery. The consumer example contains an intentionally non-authorizing token placeholder and omits HMAC headers; a real call needs the configured consumer key and an issuer-minted token whose terms match exactly.

### Research: query-only fixture and direct `EventData`

In demo mode this query returns local fixture suggestions, wrapped in `results`; known non-pending fixture facts are labelled `simulated`.

```http
POST /api/research
Content-Type: application/json
```

```json
{"query":"neatHack 2026"}
```

```json
{"results":[{"type":"generic","title":"neatHack 2026","subtitle":"48-hour hackathon","city":"Online","dateISO":"2026-10-10","programme":["Kickoff · 10 Oct, 12:30 IST","Build · 48 hours","Submissions close · 12 Oct, 23:55 IST"],"facts":[{"id":"teams","label":"Teams: pending","value":"pending","source":"event page","confidence":0.4,"provenance":"pending"},{"id":"window","label":"48 hours","value":"10–12 Oct 2026","source":"event page (demo)","confidence":0.95,"provenance":"simulated","kept":true},{"id":"winners","label":"Winners: pending","value":"pending","source":"event page","confidence":0.3,"provenance":"pending"}]}]}
```

The URL branch returns one `EventData` object directly rather than `{ "results": [...] }`. This is a docs-only example of its demo keyword-to-fixture branch: the reserved `example.com` address is not a production event source. On a live server, a matching neatHack URL may trigger a page fetch; do not execute this sample against a running deployment.

```http
POST /api/research
Content-Type: application/json
```

```json
{"url":"https://example.com/neathack"}
```

```json
{"type":"generic","title":"neatHack 2026","subtitle":"48-hour hackathon","city":"Online","dateISO":"2026-10-10","sourceUrl":"https://example.com/neathack","programme":["Kickoff · 10 Oct, 12:30 IST","Build · 48 hours","Submissions close · 12 Oct, 23:55 IST"],"facts":[{"id":"teams","label":"Teams: pending","value":"pending","source":"event page","confidence":0.4,"provenance":"pending"},{"id":"window","label":"48 hours","value":"10–12 Oct 2026","source":"event page (demo)","confidence":0.95,"provenance":"simulated","kept":true},{"id":"winners","label":"Winners: pending","value":"pending","source":"event page","confidence":0.3,"provenance":"pending"}]}
```

### Art: normalized event input and procedural layer

`/api/art` requires an object with `event.title`. It filters facts to the prompt fields and can return procedural fallback; this example shows the source-level `ArtLayer` form and does not request or imply provider-generated art.

```http
POST /api/art
Content-Type: application/json
```

```json
{"event":{"type":"concert","title":"Sample concert","city":"Glasgow","dateISO":"2026-10-12","facts":[{"id":"set","label":"Set 1","value":"A short set","source":"local example","confidence":1,"provenance":"simulated"}]},"vibe":"midnight blue","seed":271828}
```

```json
{"kind":"procedural","seed":271828,"vibe":"midnight blue","provenance":"simulated"}
```

The route may instead return an `image` layer, an error, or a quota response according to the runtime and current state. Repeat live calls can consume generation quota.

### Order: complete sandbox request and local response shape

This example selects the locally orderable `digital.file.matte` variant and a non-provider `organizer-print` method. A sandbox-only order is a local record, not a payment. The example email uses the reserved `.invalid` domain. The response values are synthetic and are not a receipt or order that exists.

```http
POST /api/orders
Content-Type: application/json
```

```json
{"order":{"stubIds":["example-stub"],"lines":[{"title":"Sample event keepsake","material":"digital","finish":"matte","size":"file","totalMinor":900}],"totalMinor":900,"method":"organizer-print","email":"tester@example.invalid"}}
```

```json
{"order":{"id":"ord_example_01","mode":"sandbox","createdAt":"2026-10-12T00:00:00.000Z","stubIds":["example-stub"],"lines":[{"title":"Sample event keepsake","material":"digital","finish":"matte","size":"file","totalMinor":900,"variantStatus":"orderable"}],"capabilityVersion":"2026-10-12.1","totalMinor":900,"currency":"USD","method":"organizer-print","email":"tester@example.invalid"}}
```

### Agent: proposed action protocol

The protocol is strict about field names, enums, and size limits. The response is a source-valid possible rules-mode response. It is a proposal only; the route does not apply an action to a stub.

```http
POST /api/agent
Content-Type: application/json
```

```json
{"schema":"ticketstub.agent-action/1","state":{"title":"Sample concert","facts":[],"edition":"researched","material":"digital","finish":"matte","art":"procedural","versions":1},"message":"Use a cooler palette."}
```

```json
{"schema":"ticketstub.agent-action/1","reply":"A cooler palette can be used for the next layer.","actions":[{"type":"remix_art","vibe":"midnight blue"}],"provenance":"rules"}
```

### Signed consumer: claim request and response contract

For `POST /api/order-authorizations/claim`, the terms must reproduce the exact signed authorization; the example's digest values are illustrative placeholders. `project` is serialized as `stub:example-stub` even though the verifier converts it to an object internally. The token string below is deliberately invalid, so the request cannot claim anything; a successful response shape is shown only to make field names reviewable.

```http
POST /api/order-authorizations/claim
Content-Type: application/json
```

```json
{"token":"NOT_A_REAL_ORDER_AUTHORIZATION","idempotencyKey":"sample-claim-0001","expect":{"tenant":"tenant-example","project":"stub:example-stub","action":"fulfillment.submit","provider":"sandbox","terms":{"orderRef":"order_example_01","sku":null,"options":{"variantId":"digital.file.matte","material":"digital","finish":"matte","size":"file","quantity":1},"quote":{"id":"quote_example_01","amountMinor":900,"currency":"USD"},"destination":{"ref":"destination_example_01","digest":"0000000000000000000000000000000000000000000000000000000000000000"},"design":{"versionId":"version_example_01","designHash":"1111111111111111111111111111111111111111111111111111111111111111","artHash":"2222222222222222222222222222222222222222222222222222222222222222","factsHash":"3333333333333333333333333333333333333333333333333333333333333333","compositionHash":"4444444444444444444444444444444444444444444444444444444444444444"},"approvalId":"approval_example_01","capabilityVersion":"2026-10-12.1"}}}
```

```json
{"ok":true,"status":"claimed","replayed":false,"authorizationId":"oau_example_01","actionId":"act_example_01","claimReference":"clm_example_01","claimedAt":"2026-10-12T00:00:00.000Z"}
```

The successful shape requires a genuine, unexpired authorization plus valid HMAC request headers, exact issuer terms, current approval/membership/capability state, and a first or same-key claim. A real consumer should use the maintained [order-authorization guide](../architecture/order-authorization.md) and verifier fixtures to calculate/sign requests, then revalidate immediately before dispatch.

## Retry and idempotency guide

| Operation | Retry behavior visible in source |
|---|---|
| Auth-link/email-link issue | No idempotency key. A repeat mints another link and may send another email. |
| Order creation | The server uses order/attempt identity and request fields to avoid duplicating a matching attempt; paid checkout requires `attemptId`. A closed/failed checkout reports its state instead of silently reopening it. |
| Order authorization issuance | `idempotencyKey` is bound to the request; same-key/same-request returns the existing authorization, while same-key/different-request conflicts. |
| Consumer claim | Reuse the **same** idempotency key after a lost response. A committed claim is returned as replay while authority remains current. Never dispatch based on a replay without revalidation. |
| Consumer lookup | A missing committed claim is a definitive lookup result in the current transaction model, not permission to change the order and dispatch elsewhere. |
| Consumer revalidation | Recheck immediately before a supplier call. This is a time-sensitive decision, not an idempotent provider submission or a replacement for supplier-side deduplication. |
| Provider webhook | Duplicate or stale observations are processed by forward-only settlement rules and provider readback; do not infer payment from callback body alone. |
| Other POST routes | No blanket retry guarantee is defined. Check that endpoint's rate limit, side effects and idempotency logic before retrying. |

## Source files and validation

The route implementations are under [`src/app/api`](../../src/app/api); shared HTTP, origin, JSON-size and limiter helpers are in [`src/server/http.ts`](../../src/server/http.ts) and [`src/server/ratelimit.ts`](../../src/server/ratelimit.ts). The identity matrix and context token versions are in [`src/server/context.ts`](../../src/server/context.ts) and [`src/server/context-token.ts`](../../src/server/context-token.ts). The documented local test entry points are [`npm test`](../../README.md#checks), [`npm run verify:product`](../../package.json), and the [runtime workflow](../../.github/workflows/runtime.yml); they use synthetic fixtures and do not establish an external provider or consumer connection. The current source pin is also described in [current architecture](../architecture/CURRENT-STATE.md).
