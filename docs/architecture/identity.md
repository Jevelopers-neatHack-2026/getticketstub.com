# Session and identity ADR (GT-08)

**Status:** Implemented in this repository and tested by `scripts/smoke-server.mjs`. Not yet reviewed by the named reviewer (CompleteDotTech), so GT-08 is not closed. See [Known limitations](#known-limitations).
**Owner:** Lars (@lmvdz), implementation. **Reviewer:** CompleteDotTech.
**Code:** `src/server/context.ts` (derivation, matrix, signing), `src/server/context-token.ts` (token format and verifier), `src/server/project.ts` (public projections), `src/app/api/**`.

## Decision

The server decides who is asking and what they own. It does this from two httpOnly cookies and its own records, and from nothing else. A body field, a query string, a URL token, a correlation id, a decoded share payload or a value in `localStorage` is never an input to identity or ownership. A route may *name* a project (`stub:<id>`, `event:<id>`), and `getRequestContext` answers whether this caller can see it.

| Concept | Meaning here |
| --- | --- |
| Tenant | One account is one tenant. A guest device is the tenant `guest:<id>`. |
| Project | One stub, or one organizer event. |
| Actor | `account`, `guest` (a server-bound device) or `anonymous` (no cookie at all). |
| Role | `owner` (a stub), `captain` (the creator of an event), `staff` (on `ADMIN_EMAILS`), `member` and `viewer` (modelled and tested, not issued: no invites yet), `none`. |

## Guest to account: claim policy (GT-08.1)

- A guest is a **server-issued device cookie** (`ts_device`, 256-bit random, httpOnly, SameSite=Lax, one year, Secure in production). The browser never chooses its guest id: the tenant is `guest:` plus the first 16 hex characters of the cookie's SHA-256, so the cookie value never leaves the server.
- A guest can make **drafts only**: build and remix stubs, generate art (capped), place a guest order with an email, and publish an unlisted share snapshot. A guest cannot sync a wall, publish a wall, create an event, redeem a claim or read orders. Those answer 401.
- **Durable save and claim need an account.** An account exists only after someone opens an emailed link, which proves the email. The browser's claim of an owner id is ignored.
- **The binding.** When a guest device completes an emailed-link sign-in, the shares that device made move to the account (`adoptShares`, same links, still working). Ids the account already shares stay with the guest. Nothing else moves, because nothing else is stored server-side for a guest. Local drafts reach the account through `POST /api/wall/sync`, which writes under the session's account and ignores any id in the body.
- **Cross-device resume.** Sign in with the same email on the other device, and sync pulls the wall. A guest on a second device has a different `ts_device`, so it resumes nothing until it signs in.
- **Claim races.** `claim()` runs in one `BEGIN IMMEDIATE` transaction. The first account wins, the same account repeating is idempotent, and any other account gets 409.
- **Roles that exist.** Captain is the only organizer role: the account that created the event. Member and viewer are in the matrix so consumers can test them, and nothing grants them yet.

## Magic-link issuer (GT-08.1, GT-08.3)

- `POST /api/auth/link` mints a 256-bit link token, stores only its SHA-256, and mails (Resend) or, in demo mode, shows the link on screen. Expiry is **15 minutes**. Limits: 20 per IP and 5 per email per 15 minutes. Throwaway domains are refused.
- A link **opens a confirm page, and only a tap on that page (`POST /api/auth/confirm`) uses it up**, so a mail scanner that fetches the URL burns nothing. Links are single use, and an email-change link cannot sign in (and the reverse).
- Demo mode (`TICKETSTUB_RUNTIME_MODE` is anything but `live`) shows sandbox sign-in links on screen and says so. In live mode with no mail key the endpoint answers 503 and shows nothing.

## Sessions, cookies, CSRF (GT-08.3)

| Item | Setting |
| --- | --- |
| Session cookie | `ts_session`: 256-bit random, only its SHA-256 stored, httpOnly, SameSite=Lax, Path=/, Secure in production, 90-day expiry kept on the server too |
| Guest cookie | `ts_device`, as above |
| Revocation | Plain sign-out deletes that session. `POST /api/auth/signout {"everywhere":true}` deletes every session of the account and bumps its `membershipRevision`. Deleting the account removes its sessions. |
| CSRF | Every mutating route calls `checkOrigin`: the `Origin` header must be `APP_URL` or this request's own host. A missing or foreign Origin is 403 and changes nothing. Two routes that guests call without a session (`/api/art`, `/api/agent`) refuse a *foreign* Origin and allow a missing one, because they change no account state. `/api/context/verify` uses no cookie, so it has nothing to ride. |
| Replay | Magic links are single use. Claim links are one claimer. Context tokens live five minutes and are checked against the session and revision. |
| Bounds | JSON bodies are size-checked before parsing (1 KB to 32 MB by route). Stubs are re-validated and capped at 2 MB after art moves to files. |
| Rate limits | In memory, per IP and per account or email, before any work: links, email change, orders, shares, revoke, context verify. Art has daily caps in SQLite. |
| Secrets | `CONTEXT_SECRET`, `RESEND_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` are read on the server only. The smoke test scans every response body and the built client chunks for them. |

## The signed context (GT-08.2, GT-08.5)

`getRequestContext(req, project?)` returns the `ticketstub.context/1` shape (`RequestContext`). Every API read and write calls it, then `requireCapability(ctx, cap)`.

- **Denials never say more than the caller may know.** A project the caller cannot see is **404**, identical to a project that does not exist (the smoke test compares the bodies). Missing `admin.*` is 404. An anonymous or guest caller short of an account capability is 401. A role too weak for a project they can see is 403.
- **`membershipRevision`** is stored per account and only goes up. It moves when the email changes, when the account signs out everywhere, and when its `ADMIN_EMAILS` status changes (noticed on the next request). Deleting the account removes the row, so its sessions are gone and its tokens read as revoked.
- **`revoked`** is true when a session cookie was presented that no longer resolves. The caller is then handled as anonymous and no token is issued.
- **Token.** `header.payload.signature`, each part base64url. Header `{"alg":"HS256","typ":"ticketstub.context"}`. Payload `{"ctx": <RequestContext>, "sid": <session reference or null>}`. Signature is HMAC-SHA256 over `header.payload`, keyed by `CONTEXT_SECRET`. `sid` is the first 24 hex characters of the stored session hash: a reference, not a credential. Lifetime is **5 minutes**.
- **Keying.** With `CONTEXT_SECRET` (32 or more characters) the token says `mode: "live"` in live mode. Without it, outside live mode, a random per-process key is used and the token says `mode: "sandbox"` (it dies on restart). **In live mode without it, issuing throws 503.** Fixture tokens say `mode: "fixture"` and use a published key that no deployment holds.
- **Verification order:** shape (`unknown`), constant-time HMAC (`forged`), schema version (`unsupported_version`), expiry (`expired`), session (`revoked`), membership revision (`stale`). `verifyContextToken(token, now?, state?)` is synchronous and so checks the last two only when handed `state`; `verifyContextTokenLive(token)` loads that state from storage.
- **`GET /api/context?project=<kind>:<id>`** returns `{ context, token }` for the session. **`POST /api/context/verify {token}`** is the port for a consumer that cannot hold the key: 200 with the context, or 401 with `{ok:false, reason}`.

### Capability matrix

One table, in code (`CAPABILITY_MATRIX`), repeated in `fixtures/context/README.md`, and checked against both by the smoke test.

| Actor and role | Capabilities |
| --- | --- |
| Everyone (anonymous, guest, account) | `stub.draft` `art.generate` `agent.use` `share.create` `share.view` `wall.public.view` `claim.view` `file.read` `order.create` |
| Account, any role | the row above and `account.read` `account.email.change` `account.delete` `session.revoke` `wall.sync` `wall.publish` `order.read` `event.create` `claim.redeem` |
| `owner` of a stub | `stub.read` `stub.write` `share.revoke` `gift.create`, and `stub.approve` and `order.authorize` for a signed-in account only (a guest device that owns a stub is refused) |
| `captain` of an event | `event.read` `event.publish` `claims.read` |
| `member`, `viewer` | `stub.read` on a stub, `event.read` on an event (never issued yet) |
| `staff` (account on `ADMIN_EMAILS`) | `admin.view`, and no project access |
| `none` on a project | nothing beyond the public row, and the project answers 404 |

### Endpoint by role

`-` means refused. Statuses are the denial a caller sees.

| Endpoint | Capability | anonymous / guest | account, own data | account, someone else's data | staff |
| --- | --- | --- | --- | --- | --- |
| `GET /api/context` | none | own context | own context | `?project=` 404 | `role: staff`, `admin.view` |
| `POST /api/context/verify` | none (rate limited) | verdict | verdict | verdict | verdict |
| `POST /api/wall/sync` | `wall.sync` | 401 | own wall only | ids in the body write to the caller's wall | same as account |
| `GET`/`PUT /api/wall/public` | `wall.publish` | 401 | own token, `rotate` | not addressable | same |
| `GET /api/u/<token>` | `wall.public.view` | projected wall | projected wall | n/a | n/a |
| `POST /api/share` | `share.create` | owned by the device | owned by the account | a body id just names the caller's own row | same |
| `GET /api/share/<token>`, `/api/stub-image/<token>` | `share.view` | projection | projection | n/a | n/a |
| `POST /api/gift` | `gift.create` on `stub:<id>` | the device's own shared stub, else 404 | 200, `{giftToken, sharePath}` | 404 | 404 |
| `GET /api/gift/<token>` | none: the token is the capability | message and stub | same | same | same |
| `DELETE /api/gift/<token>` | `share.revoke` on the gift's stub | the device's own gift, else 404 | 200 | 404 | 404 |
| `POST /api/share/revoke` | `share.revoke` on `stub:<id>` | the device's own shares, else 404 | 200 | 404 | 404 |
| `POST /api/approvals`, `POST /api/approvals/revoke`, `GET /api/approvals?project=stub:<id>` | `stub.approve` on `stub:<id>` | 404 for a project it can't see, 401 for a guest that owns the stub | 200 | 404 | 404 |
| `POST /api/approvals/verify` | none: the signed token is the capability (rate limited, no cookie, no Origin) | verdict | verdict | verdict | verdict |
| `POST /api/order-authorizations`, `POST /api/order-authorizations/revoke`, `GET /api/order-authorizations?project=stub:<id>` | `order.authorize` on `stub:<id>` | 404 for a project it can't see, 401 for a guest that owns the stub | 200 | 404 | 404 |
| `POST /api/order-authorizations/{verify,claim,revalidate,claims/lookup}` | none of the above: a signed consumer request (`ORDER_AUTH_CONSUMER_KEY`) carrying the signed token | verdict | verdict | verdict | verdict |
| `POST`/`GET /api/orders` | `order.create` / `order.read` | create with an email / 401 | own orders | not addressable | own |
| `POST /api/organizer/events` | `event.create` | 401 | caller becomes captain | n/a | same |
| `GET /api/claim/<token>` | `claim.view` | projected preview | same | same | same |
| `POST /api/claim/<token>` | `claim.redeem` | 401 | lands on the caller's wall; a taken link is 409 | same | same |
| `DELETE /api/account`, `POST /api/account/email` | `account.delete`, `account.email.change` | 401 | own account | not addressable | own |
| `POST /api/auth/signout` | origin check; `session.revoke` for `everywhere` | 200 (nothing) / 401 | own sessions | not addressable | own |
| `GET /api/files/<hash>` | `file.read` | art by content hash | same | same | same |
| `POST /api/art` | `art.generate` | capped | capped | n/a | capped |
| `/admin` (GT-01) | `admin.view` | 404 | 404 | 404 | allowed |

## Sharing and retention (GT-08.4)

- **Private by default.** A stub is on no link until its owner shares it. The public wall is off until switched on.
- **Opaque, unlisted, revocable.** Share tokens are random (72-bit for stubs, 96-bit for walls). They do not expire, and are never listed. `/s/*` and `/u/*` pages carry `robots: noindex, nofollow`. "Stop sharing" is the way out:
  - a stub: `POST /api/share/revoke {stubId}` deletes the snapshot. The old link is 404, and sharing again mints a new one;
  - the wall: `PUT /api/wall/public {isPublic:false, rotate:true}` makes it private and replaces the token. `{isPublic:true, rotate:true}` keeps it public on a new link.
- **Minimal projections.** `publicStub` (`src/server/project.ts`) rebuilds a stub from a whitelist on the way **in** (what a share stores) and on the way **out** (so rows stored whole before this change are still safe). Out: guest lists (`friends`), private `note`, `photos`, the claim `setId`, ticket or barcode fields, any field not listed, inline `data:` images, and everything about the account. In: title, venue, city, date, setlist, cast, programme, score, facts, edition, art reference, typography, material, finish, wall position, and the guest name when a stub was issued to a named guest. `seat` is shown if the owner printed it.
- **Gift messages live with the gift token, nowhere else.** The gift flow no longer writes `personal.note`. `POST /api/gift {stub, to, message}` (capability `gift.create`: the caller owns that stub, or is the guest device that shared it) stores the message (at most 280 characters, control characters stripped) in a `gifts` row keyed by the SHA-256 of a 128-bit gift token. `GET /api/gift/<token>` returns `{stub, to, message, openedAt, shareToken}` to whoever holds the token, with `no-store` and `X-Robots-Tag: noindex`, and records the first open (not when the sender looks). The gift link is `/s/<shareToken>?gift=<giftToken>`; the page asks the gift API, and with no valid token it is an ordinary share page with no message. The share token, `/api/share/*`, `/s/*` HTML, `/u/*` and the stub image never carry it. The sender revokes with `DELETE /api/gift/<token>` (404 for anyone else), which deletes the row and message; stopping the stub's share, deleting the account, or a failed adoption also deletes it. Old `?gift=1&to=` links still unwrap, with no message.
- **Retention.** A share lives until its owner stops sharing or deletes the account (shares are deleted with it). Orders are kept for the books and anonymised on account deletion. Art files are content-addressed and are deleted when nothing references them.
- **Art files by hash** (`/api/files/<sha256>.<ext>`) are served to anyone who knows the name, with a one-year immutable cache. The name is 256 bits and cannot be listed, but stopping a share does not delete or un-cache its art. See limitations.

## Legacy payload links (GT-08.6)

Before the server stored shares, `/s/<payload>` carried the whole stub, base64url, in the URL. These links keep rendering, as **untrusted, read-only data**:

- there is no API route that accepts a payload: `/api/share/<payload>`, `/api/claim/<payload>` and `/api/u/<payload>` all 404 (the token alphabet and length check fail first);
- the decoded id never reaches the server as authority: ownership comes from the session and storage, and the smoke test shows a payload that names another account's stub id gives no context, no revoke and no share;
- the memory page treats a payload link as **not owned**, even if a stub with that id sits in this browser: no "Share your stub", no print or download, no claim link, no photo upload. It shows a quiet "Old share link";
- `localStorage` claims are likewise ignored by the server. The wall syncs them up only when a signed-in account pushes them, as that account's own drafts.

**Not retired yet:** `/claim/<set>?from=<payload>` in the browser still decodes a payload to *preview and build a local stub* (`ClaimClient`). It creates only a local draft and calls no server API, so it grants no server-side ownership or claim. It does read the payload's guest list, which new snapshots no longer contain.

## Context /2 and the finance handoff (GT-FIN-001..003)

Finance (cost-intelligence) and the dashboard asked for explicit finance grants, injective ids, separate environment / economic / evidence modes, and verification that matches the server shape for shape. **Status: implemented at interface and fixture depth. Not reviewed or accepted by Finance. No consumer is integrated with it.**

### Version decision: `ticketstub.context/2`, with `/1` still verifiable

`/1` is unchanged and is still the default of `GET /api/context`. `/2` is a new version, not an additive `/1.x`, because three existing fields change meaning:

- `actor.id` and `tenant.id` become kind-prefixed (`account:<id>`), where `/1` had a bare id;
- `mode` (`fixture|sandbox|live`) is replaced by three fields, `environment`, `economicMode` and `evidenceMode`;
- the capability set now includes `finance.*`, and the verifier rejects an unknown `finance.*` string.

A `/1` consumer reading a `/2` token would misread ids and modes, so the schema string says which one it holds. Both verify side by side in `verifyWithKey`, `verify.mjs` and `POST /api/context/verify`. A `/1` token never carries finance grants and never authorizes finance (`authorizesFinance` refuses it). Ask for `/2` with `GET /api/context?v=2&project=<kind>:<id>`. When every consumer has moved, `/1` can be retired by a later change; nothing here does that.

Fields of `/2` (`ContextV2` in `src/server/context-token.ts`):

| Field | Meaning |
| --- | --- |
| `schema` | `ticketstub.context/2` |
| `issuer`, `audience` | `getticketstub.com`, and the host the token is for (`CONTEXT_AUDIENCE`, default `ticketstub.finance`). Server configuration only. |
| `actor` | `{kind, id}`. `id` is `account:<id>`, `guest:<id>` or `anonymous:0`. |
| `tenant.id` | The same string as `actor.id`. |
| `project` | `{kind, id, ref}`, `ref` is `<kind>:<id>`. Present only when a project was selected and proved. |
| `role` | Informational. Nothing may authorize from it. |
| `capabilities` | Every grant, the `/1` capabilities plus `finance.*`. This is the only thing a consumer authorizes from. |
| `membershipRevision`, `revoked`, `issuedAt`, `expiresAt` | As `/1`. |
| `environment`, `economicMode`, `evidenceMode` | Three separate axes, below. |

### Injective ids (GT-FIN-002)

An id is `<kind>:<raw>`, split at the first colon, and kinds never contain one. An account `abc` and a guest `abc` are `account:abc` and `guest:abc`, so no two kinds collide, and the same holds for `project.ref` (`stub:p1` is not `event:p1`). The verifiers refuse a `/2` token whose actor id lacks its own kind's prefix, whose tenant differs from the actor, or whose project ref does not equal `<kind>:<id>`. The finance mapping keeps the prefixes in `tenantId`, `projectId` and `actorId`.

### Three mode axes (GT-FIN-002)

Never one word for all three. They are derived in `src/server/context-modes.ts`.

| Axis | Values | Derived from |
| --- | --- | --- |
| `environment`: where it runs | `development`, `preview`, `live` | `TICKETSTUB_RUNTIME_MODE=live` is `live`. Otherwise `NODE_ENV=production` is `preview`, else `development`. |
| `economicMode`: whether real money is at stake | `none`, `sandbox`, `paid_test`, `live` | `live` environment: `live`. Otherwise `paid_test` if any paid provider key is configured (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, the three `TICKETSTUB_*_OPENROUTER_API_KEY`), else `none`. `TICKETSTUB_BILLING_MODE` states it explicitly. |
| `evidenceMode`: what kind of record backs it | `fixture`, `synthetic`, `live` | `live` only in a live environment with a usable `CONTEXT_SECRET`. Else `synthetic`. `fixture` only in the published fixtures. |

`paid_test` is real money spent while testing, for example a paid provider call from a preview deploy. It is an **actual expense** whatever the environment or the evidence says: `preview` / `paid_test` / `fixture` is a valid, honest combination. Combinations that cannot be mapped honestly are refused, not guessed: the issuer answers `503 context_unavailable`, and a verifier answers `unknown` for a signed token carrying one.

- `live` environment with `paid_test`, and a non-live environment with `live` money, are refused.
- A configured paid provider with an explicit `none` or `sandbox` is refused: a statement cannot hide spend.
- An unknown `TICKETSTUB_BILLING_MODE` is refused.

The key-presence rule is a heuristic that leans toward over-reporting: a key being configured does not prove a call was made, but a paid test must never read as `none`.

Proposed mapping onto cost-intelligence's `TrustedScope` (`toFinanceScope` in `verify.mjs`; Finance owns its enums and has not accepted this). The result is versioned, `ticketstub.finance-scope-adapter/1`: `{ ok: true, scope, evidenceMode }` where `scope` holds exactly the five fields `TrustedScope` permits and `evidenceMode` sits beside it, or `{ ok: false, reason }`. A mapped id over Finance's 128 characters is refused `identifier_too_long` (never truncated, never unprefixed, never replaced); the producer does not cap raw ids at issue, so `/1` stays as it is.

| Studio | Finance field | Maps to |
| --- | --- | --- |
| `environment` `development` / `preview` / `live` | `environment` | `development` / `test` / `production` |
| `economicMode` `none` / `sandbox` / `paid_test` / `live` | `billingMode` | `simulated` / `sandbox` / `live` / `live` |
| `tenant.id`, `project.ref` (or `platform`), `actor.id` | `tenantId`, `projectId`, `actorId` | unchanged, kind-prefixed, at most 128 characters or the mapping is refused |
| `evidenceMode` `fixture` / `synthetic` / `live` | beside `scope`, not inside it | `mocked` / `sandbox` / `live` |

### Finance grants (GT-FIN-001)

Explicit capability strings in `CAPABILITY_MATRIX.finance` (`src/server/context-token.ts`), issued per role and per scope. A consumer asks whether `ctx.capabilities` holds a string. It never reads the role name.

| Scope | Holder | Grants |
| --- | --- | --- |
| Event project | `captain` | `finance.read` `finance.export` |
| Event project | `member`, `viewer` (never issued yet) | `finance.read` |
| Stub project | `owner` | none: a personal stub has no finance surface |
| Platform (context with no project) | `staff` (`ADMIN_EMAILS`) | `finance.read` `finance.export` `finance.command.budget_change` `finance.command.expense_adjust` `finance.command.reservation` `finance.command.reconcile` `finance.command.recovery` |
| Any | guest, anonymous, a plain account | none |

A context with a project carries that project's grants and nothing wider, and staff get nothing on a project they do not hold. The matrix is the host's proposal; Finance has not approved it. `finance.command.*` has no per-project holder today.

### Trusted selected-project context

The dashboard names a project with `GET /api/context?v=2&project=event:<id>`. That is only a question. The server answers from the session cookie and its own records (`ownsStub`, `getEventCaptain`): a project the caller does not hold is a `404` identical to one that does not exist. A body field, query field, header or correlation id (a `tenant`, `role`, `audience` or `capabilities` parameter) changes nothing. The proof of the selection is the signed token, whose `project.ref` was set only after that check, and which `POST /api/context/verify` re-checks on every call.

### Current membership and revocation (GT-FIN-003)

`verifyContextTokenLive` re-checks at verify time. For `/2` it checks, in order: shape, signature, version, expiry, audience (the issuer's configured one, and the verifier's when it sends `audience`), then session (`revoked`), then project membership (`revoked`: the stub is gone, the event has another captain), then the account's `membershipRevision` (`stale`). It also re-derives the three modes from current configuration and answers `stale` if they moved or can no longer be mapped. A consumer that never calls the port honours a token for up to five minutes after a change.

There is one shape validator per version, run by the server (`shapedV1`, `shapedV2`) and mirrored in `fixtures/context/verify.mjs`. Both refuse the same malformed inputs with the same reason: `tests/finance-context.test.mjs` signs each of the 40 malformed contexts and requires identical answers, and `npm run verify:product -- --suite finance-context` posts the same corpus to `POST /api/context/verify` and compares it with the offline result. The `/1` shape rules were tightened to match: a non-empty actor id, a project id matching `^[\w.:-]{1,128}# Session and identity ADR (GT-08)

**Status:** Implemented in this repository and tested by `scripts/smoke-server.mjs`. Not yet reviewed by the named reviewer (CompleteDotTech), so GT-08 is not closed. See [Known limitations](#known-limitations).
**Owner:** Lars (@lmvdz), implementation. **Reviewer:** CompleteDotTech.
**Code:** `src/server/context.ts` (derivation, matrix, signing), `src/server/context-token.ts` (token format and verifier), `src/server/project.ts` (public projections), `src/app/api/**`.

## Decision

The server decides who is asking and what they own. It does this from two httpOnly cookies and its own records, and from nothing else. A body field, a query string, a URL token, a correlation id, a decoded share payload or a value in `localStorage` is never an input to identity or ownership. A route may *name* a project (`stub:<id>`, `event:<id>`), and `getRequestContext` answers whether this caller can see it.

| Concept | Meaning here |
| --- | --- |
| Tenant | One account is one tenant. A guest device is the tenant `guest:<id>`. |
| Project | One stub, or one organizer event. |
| Actor | `account`, `guest` (a server-bound device) or `anonymous` (no cookie at all). |
| Role | `owner` (a stub), `captain` (the creator of an event), `staff` (on `ADMIN_EMAILS`), `member` and `viewer` (modelled and tested, not issued: no invites yet), `none`. |

## Guest to account: claim policy (GT-08.1)

- A guest is a **server-issued device cookie** (`ts_device`, 256-bit random, httpOnly, SameSite=Lax, one year, Secure in production). The browser never chooses its guest id: the tenant is `guest:` plus the first 16 hex characters of the cookie's SHA-256, so the cookie value never leaves the server.
- A guest can make **drafts only**: build and remix stubs, generate art (capped), place a guest order with an email, and publish an unlisted share snapshot. A guest cannot sync a wall, publish a wall, create an event, redeem a claim or read orders. Those answer 401.
- **Durable save and claim need an account.** An account exists only after someone opens an emailed link, which proves the email. The browser's claim of an owner id is ignored.
- **The binding.** When a guest device completes an emailed-link sign-in, the shares that device made move to the account (`adoptShares`, same links, still working). Ids the account already shares stay with the guest. Nothing else moves, because nothing else is stored server-side for a guest. Local drafts reach the account through `POST /api/wall/sync`, which writes under the session's account and ignores any id in the body.
- **Cross-device resume.** Sign in with the same email on the other device, and sync pulls the wall. A guest on a second device has a different `ts_device`, so it resumes nothing until it signs in.
- **Claim races.** `claim()` runs in one `BEGIN IMMEDIATE` transaction. The first account wins, the same account repeating is idempotent, and any other account gets 409.
- **Roles that exist.** Captain is the only organizer role: the account that created the event. Member and viewer are in the matrix so consumers can test them, and nothing grants them yet.

## Magic-link issuer (GT-08.1, GT-08.3)

- `POST /api/auth/link` mints a 256-bit link token, stores only its SHA-256, and mails (Resend) or, in demo mode, shows the link on screen. Expiry is **15 minutes**. Limits: 20 per IP and 5 per email per 15 minutes. Throwaway domains are refused.
- A link **opens a confirm page, and only a tap on that page (`POST /api/auth/confirm`) uses it up**, so a mail scanner that fetches the URL burns nothing. Links are single use, and an email-change link cannot sign in (and the reverse).
- Demo mode (`TICKETSTUB_RUNTIME_MODE` is anything but `live`) shows sandbox sign-in links on screen and says so. In live mode with no mail key the endpoint answers 503 and shows nothing.

## Sessions, cookies, CSRF (GT-08.3)

| Item | Setting |
| --- | --- |
| Session cookie | `ts_session`: 256-bit random, only its SHA-256 stored, httpOnly, SameSite=Lax, Path=/, Secure in production, 90-day expiry kept on the server too |
| Guest cookie | `ts_device`, as above |
| Revocation | Plain sign-out deletes that session. `POST /api/auth/signout {"everywhere":true}` deletes every session of the account and bumps its `membershipRevision`. Deleting the account removes its sessions. |
| CSRF | Every mutating route calls `checkOrigin`: the `Origin` header must be `APP_URL` or this request's own host. A missing or foreign Origin is 403 and changes nothing. Two routes that guests call without a session (`/api/art`, `/api/agent`) refuse a *foreign* Origin and allow a missing one, because they change no account state. `/api/context/verify` uses no cookie, so it has nothing to ride. |
| Replay | Magic links are single use. Claim links are one claimer. Context tokens live five minutes and are checked against the session and revision. |
| Bounds | JSON bodies are size-checked before parsing (1 KB to 32 MB by route). Stubs are re-validated and capped at 2 MB after art moves to files. |
| Rate limits | In memory, per IP and per account or email, before any work: links, email change, orders, shares, revoke, context verify. Art has daily caps in SQLite. |
| Secrets | `CONTEXT_SECRET`, `RESEND_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` are read on the server only. The smoke test scans every response body and the built client chunks for them. |

## The signed context (GT-08.2, GT-08.5)

`getRequestContext(req, project?)` returns the `ticketstub.context/1` shape (`RequestContext`). Every API read and write calls it, then `requireCapability(ctx, cap)`.

- **Denials never say more than the caller may know.** A project the caller cannot see is **404**, identical to a project that does not exist (the smoke test compares the bodies). Missing `admin.*` is 404. An anonymous or guest caller short of an account capability is 401. A role too weak for a project they can see is 403.
- **`membershipRevision`** is stored per account and only goes up. It moves when the email changes, when the account signs out everywhere, and when its `ADMIN_EMAILS` status changes (noticed on the next request). Deleting the account removes the row, so its sessions are gone and its tokens read as revoked.
- **`revoked`** is true when a session cookie was presented that no longer resolves. The caller is then handled as anonymous and no token is issued.
- **Token.** `header.payload.signature`, each part base64url. Header `{"alg":"HS256","typ":"ticketstub.context"}`. Payload `{"ctx": <RequestContext>, "sid": <session reference or null>}`. Signature is HMAC-SHA256 over `header.payload`, keyed by `CONTEXT_SECRET`. `sid` is the first 24 hex characters of the stored session hash: a reference, not a credential. Lifetime is **5 minutes**.
- **Keying.** With `CONTEXT_SECRET` (32 or more characters) the token says `mode: "live"` in live mode. Without it, outside live mode, a random per-process key is used and the token says `mode: "sandbox"` (it dies on restart). **In live mode without it, issuing throws 503.** Fixture tokens say `mode: "fixture"` and use a published key that no deployment holds.
- **Verification order:** shape (`unknown`), constant-time HMAC (`forged`), schema version (`unsupported_version`), expiry (`expired`), session (`revoked`), membership revision (`stale`). `verifyContextToken(token, now?, state?)` is synchronous and so checks the last two only when handed `state`; `verifyContextTokenLive(token)` loads that state from storage.
- **`GET /api/context?project=<kind>:<id>`** returns `{ context, token }` for the session. **`POST /api/context/verify {token}`** is the port for a consumer that cannot hold the key: 200 with the context, or 401 with `{ok:false, reason}`.

### Capability matrix

One table, in code (`CAPABILITY_MATRIX`), repeated in `fixtures/context/README.md`, and checked against both by the smoke test.

| Actor and role | Capabilities |
| --- | --- |
| Everyone (anonymous, guest, account) | `stub.draft` `art.generate` `agent.use` `share.create` `share.view` `wall.public.view` `claim.view` `file.read` `order.create` |
| Account, any role | the row above and `account.read` `account.email.change` `account.delete` `session.revoke` `wall.sync` `wall.publish` `order.read` `event.create` `claim.redeem` |
| `owner` of a stub | `stub.read` `stub.write` `share.revoke` `gift.create` |
| `captain` of an event | `event.read` `event.publish` `claims.read` |
| `member`, `viewer` | `stub.read` on a stub, `event.read` on an event (never issued yet) |
| `staff` (account on `ADMIN_EMAILS`) | `admin.view`, and no project access |
| `none` on a project | nothing beyond the public row, and the project answers 404 |

### Endpoint by role

`-` means refused. Statuses are the denial a caller sees.

| Endpoint | Capability | anonymous / guest | account, own data | account, someone else's data | staff |
| --- | --- | --- | --- | --- | --- |
| `GET /api/context` | none | own context | own context | `?project=` 404 | `role: staff`, `admin.view` |
| `POST /api/context/verify` | none (rate limited) | verdict | verdict | verdict | verdict |
| `POST /api/wall/sync` | `wall.sync` | 401 | own wall only | ids in the body write to the caller's wall | same as account |
| `GET`/`PUT /api/wall/public` | `wall.publish` | 401 | own token, `rotate` | not addressable | same |
| `GET /api/u/<token>` | `wall.public.view` | projected wall | projected wall | n/a | n/a |
| `POST /api/share` | `share.create` | owned by the device | owned by the account | a body id just names the caller's own row | same |
| `GET /api/share/<token>`, `/api/stub-image/<token>` | `share.view` | projection | projection | n/a | n/a |
| `POST /api/gift` | `gift.create` on `stub:<id>` | the device's own shared stub, else 404 | 200, `{giftToken, sharePath}` | 404 | 404 |
| `GET /api/gift/<token>` | none: the token is the capability | message and stub | same | same | same |
| `DELETE /api/gift/<token>` | `share.revoke` on the gift's stub | the device's own gift, else 404 | 200 | 404 | 404 |
| `POST /api/share/revoke` | `share.revoke` on `stub:<id>` | the device's own shares, else 404 | 200 | 404 | 404 |
| `POST`/`GET /api/orders` | `order.create` / `order.read` | create with an email / 401 | own orders | not addressable | own |
| `POST /api/organizer/events` | `event.create` | 401 | caller becomes captain | n/a | same |
| `GET /api/claim/<token>` | `claim.view` | projected preview | same | same | same |
| `POST /api/claim/<token>` | `claim.redeem` | 401 | lands on the caller's wall; a taken link is 409 | same | same |
| `DELETE /api/account`, `POST /api/account/email` | `account.delete`, `account.email.change` | 401 | own account | not addressable | own |
| `POST /api/auth/signout` | origin check; `session.revoke` for `everywhere` | 200 (nothing) / 401 | own sessions | not addressable | own |
| `GET /api/files/<hash>` | `file.read` | art by content hash | same | same | same |
| `POST /api/art` | `art.generate` | capped | capped | n/a | capped |
| `/admin` (GT-01) | `admin.view` | 404 | 404 | 404 | allowed |

## Sharing and retention (GT-08.4)

- **Private by default.** A stub is on no link until its owner shares it. The public wall is off until switched on.
- **Opaque, unlisted, revocable.** Share tokens are random (72-bit for stubs, 96-bit for walls). They do not expire, and are never listed. `/s/*` and `/u/*` pages carry `robots: noindex, nofollow`. "Stop sharing" is the way out:
  - a stub: `POST /api/share/revoke {stubId}` deletes the snapshot. The old link is 404, and sharing again mints a new one;
  - the wall: `PUT /api/wall/public {isPublic:false, rotate:true}` makes it private and replaces the token. `{isPublic:true, rotate:true}` keeps it public on a new link.
- **Minimal projections.** `publicStub` (`src/server/project.ts`) rebuilds a stub from a whitelist on the way **in** (what a share stores) and on the way **out** (so rows stored whole before this change are still safe). Out: guest lists (`friends`), private `note`, `photos`, the claim `setId`, ticket or barcode fields, any field not listed, inline `data:` images, and everything about the account. In: title, venue, city, date, setlist, cast, programme, score, facts, edition, art reference, typography, material, finish, wall position, and the guest name when a stub was issued to a named guest. `seat` is shown if the owner printed it.
- **Gift messages live with the gift token, nowhere else.** The gift flow no longer writes `personal.note`. `POST /api/gift {stub, to, message}` (capability `gift.create`: the caller owns that stub, or is the guest device that shared it) stores the message (at most 280 characters, control characters stripped) in a `gifts` row keyed by the SHA-256 of a 128-bit gift token. `GET /api/gift/<token>` returns `{stub, to, message, openedAt, shareToken}` to whoever holds the token, with `no-store` and `X-Robots-Tag: noindex`, and records the first open (not when the sender looks). The gift link is `/s/<shareToken>?gift=<giftToken>`; the page asks the gift API, and with no valid token it is an ordinary share page with no message. The share token, `/api/share/*`, `/s/*` HTML, `/u/*` and the stub image never carry it. The sender revokes with `DELETE /api/gift/<token>` (404 for anyone else), which deletes the row and message; stopping the stub's share, deleting the account, or a failed adoption also deletes it. Old `?gift=1&to=` links still unwrap, with no message.
- **Retention.** A share lives until its owner stops sharing or deletes the account (shares are deleted with it). Orders are kept for the books and anonymised on account deletion. Art files are content-addressed and are deleted when nothing references them.
- **Art files by hash** (`/api/files/<sha256>.<ext>`) are served to anyone who knows the name, with a one-year immutable cache. The name is 256 bits and cannot be listed, but stopping a share does not delete or un-cache its art. See limitations.

## Legacy payload links (GT-08.6)

Before the server stored shares, `/s/<payload>` carried the whole stub, base64url, in the URL. These links keep rendering, as **untrusted, read-only data**:

- there is no API route that accepts a payload: `/api/share/<payload>`, `/api/claim/<payload>` and `/api/u/<payload>` all 404 (the token alphabet and length check fail first);
- the decoded id never reaches the server as authority: ownership comes from the session and storage, and the smoke test shows a payload that names another account's stub id gives no context, no revoke and no share;
- the memory page treats a payload link as **not owned**, even if a stub with that id sits in this browser: no "Share your stub", no print or download, no claim link, no photo upload. It shows a quiet "Old share link";
- `localStorage` claims are likewise ignored by the server. The wall syncs them up only when a signed-in account pushes them, as that account's own drafts.

**Not retired yet:** `/claim/<set>?from=<payload>` in the browser still decodes a payload to *preview and build a local stub* (`ClaimClient`). It creates only a local draft and calls no server API, so it grants no server-side ownership or claim. It does read the payload's guest list, which new snapshots no longer contain.

, and a string `issuedAt`.

### GT-FIN map

| Request | What implements it | Has | Lacks |
| --- | --- | --- | --- |
| **GT-FIN-001** explicit finance grants, or an action-verification port, with positive and negative fixtures | `CAPABILITY_MATRIX.finance`, `financeCapsFor`, `authorizesFinance`, fixtures `v2/finance-*` | Read, export and command grants as capabilities, per role and scope. Allowed and denied fixtures for each. No role-name authority. | Owner approval of the matrix. **No service principal model**: there is no `service` actor, so a worker, recovery job or service call has no grant path (not supported). **No separately authenticated action-verification port**: the port says whether a token is good, not whether an action is allowed. Nobody holds `finance.command.*` per project. |
| **GT-FIN-002** trusted mapping for environment, economic mode, evidence mode, audience; injective project kind and ID; a paid test is expense; deny unsupported | `context-modes.ts`, `toContextV2`, `audience`, `project.ref`, `toFinanceScope`, fixtures `v2/economic-*`, `wrong-audience`, `injective-*` | Three axes, `paid_test` stays `billingMode: live`, injective actor, tenant and project refs, one configured audience, refusal of inconsistent mappings (unit-tested; `503` on issue). | Owner review of the mapping, and Finance acceptance of the vocabulary. Per-consumer audiences (one string only). `paid_test` is inferred from key presence unless stated, which is a heuristic. The `503` refusal is covered by unit tests but not by an HTTP test. No live issuer evidence. |
| **GT-FIN-003** align the offline verifier with server shape validation; add the seven negatives | `shapedV1`, `shapedV2`, `verify.mjs`, `fixtures/context/corpus.mjs`, `v2/malformed-shapes.json`, the unit test, the `finance-context` suite | The seven shapes, plus 33 more, plus 55 wrong-type enum values (array, object, null, number, boolean; both verifiers require a string before any enum check), are `unknown` offline and from the server, with identical reasons. Current membership, session, revision, audience and modes are re-checked live. | Push revocation. A `/2` `stale` over HTTP is covered offline only. Consumers must configure the issuer endpoint and key themselves; nothing from a token chooses them. |
| Trusted selected-project context | `GET /api/context?v=2&project=`, `derive()` in `context.ts` | Server-derived selection, `404` for a project the caller does not hold, re-checked at verify. | Dashboard integration. |
| Approved read/command port | Not in this repository | Not supported. The host issues and verifies identity. Query, export and command behaviour belongs to cost-intelligence (#8) and the dashboard bridge (team-dashboard #11, and the admin-mount request). | The port itself. |

Everything above is fixture and interface evidence plus unit and local-server tests. It is not Finance acceptance and not an integration.

## Downstream verification port

Dashboard and cost-intelligence consume a context; neither is an identity authority.

- Take `{context, token}` from `GET /api/context?project=...`, or from a trusted server-side call that forwards the user's session.
- **Offline:** verify the token with the issuer's key and `fixtures/context/verify.mjs` (copy `verifyContext`). Without `state` that proves signature, version and expiry.
- **Stale and revoked:** pass `state` from the issuer (`membershipRevision` of the account, `sessionLive`), or call `POST /api/context/verify` on every mutation, read, retry and export.
- **Always** check the context against the request: `ctx.tenant.id` and `ctx.project` must equal the tenant and project being touched, and `ctx.capabilities` must hold the capability. A caller-supplied tenant, project, role, filter, cursor or correlation id grants nothing. `authorizes()` in `verify.mjs` does this.
- Unknown, forged, stale, revoked, expired and unsupported-version all deny. A denied mutation changes no state.
- Finance consumers use `/2` (see above) and `authorizesFinance`, and never read `role`.
- Fixtures: `fixtures/context/` and `fixtures/context/v2/`. They are fixture evidence only, and do not show a consumer integrated with the live issuer.

## Known limitations

- **Rate limits are in memory** and per process: they reset on restart and are not shared across instances. The client IP comes from `x-real-ip` or `x-forwarded-for`, which is only trustworthy behind a proxy that sets it.
- **No member invites yet.** `member` and `viewer` are modelled and tested through fixtures, but nothing assigns them. Captain is the creator only; a captain cannot hand an event over.
- **SQLite only**, one writer, one process. The `Storage` interface is the seam for Postgres. Migrations are forward-only.
- **`verifyContextToken` is synchronous**, so alone it cannot see stale or revoked. Use `verifyContextTokenLive` or pass `state`.
- **Token revocation is a lookup**, not a push: a consumer that never asks the issuer will honour a token for up to five minutes after a sign-out.
- **Finance (`/2`) is interface and fixtures only.** The grant matrix and the mode mapping are proposals Finance has not approved, there is no service principal, and nothing is integrated. See the GT-FIN map.
- **One signing key, no rotation.** Rotating `CONTEXT_SECRET` invalidates outstanding tokens. There is no `kid` handling beyond the fixture key.
- **Art files stay readable by hash** after sharing stops, and may sit in caches.
- **Old anonymous share rows** (owner `anon`, before device binding) have no owner: nobody can revoke them.
- **Gift messages** are readable by anyone holding the gift link (that is the design) and are kept until the sender revokes, stops the share or deletes the account; there is no expiry. `ClaimClient` still decodes legacy payloads locally.
- **Staff access is by email allowlist** and gives `admin.view` only. There is no audit log of admin reads yet.
- The mail provider is outside this test. Sandbox links appear on screen in demo mode by design.
