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

## Downstream verification port

Dashboard and cost-intelligence consume a context; neither is an identity authority.

- Take `{context, token}` from `GET /api/context?project=...`, or from a trusted server-side call that forwards the user's session.
- **Offline:** verify the token with the issuer's key and `fixtures/context/verify.mjs` (copy `verifyContext`). Without `state` that proves signature, version and expiry.
- **Stale and revoked:** pass `state` from the issuer (`membershipRevision` of the account, `sessionLive`), or call `POST /api/context/verify` on every mutation, read, retry and export.
- **Always** check the context against the request: `ctx.tenant.id` and `ctx.project` must equal the tenant and project being touched, and `ctx.capabilities` must hold the capability. A caller-supplied tenant, project, role, filter, cursor or correlation id grants nothing. `authorizes()` in `verify.mjs` does this.
- Unknown, forged, stale, revoked, expired and unsupported-version all deny. A denied mutation changes no state.
- Fixtures: `fixtures/context/`. They are fixture evidence only, and do not show a consumer integrated with the live issuer.

## Known limitations

- **Rate limits are in memory** and per process: they reset on restart and are not shared across instances. The client IP comes from `x-real-ip` or `x-forwarded-for`, which is only trustworthy behind a proxy that sets it.
- **No member invites yet.** `member` and `viewer` are modelled and tested through fixtures, but nothing assigns them. Captain is the creator only; a captain cannot hand an event over.
- **SQLite only**, one writer, one process. The `Storage` interface is the seam for Postgres. Migrations are forward-only.
- **`verifyContextToken` is synchronous**, so alone it cannot see stale or revoked. Use `verifyContextTokenLive` or pass `state`.
- **Token revocation is a lookup**, not a push: a consumer that never asks the issuer will honour a token for up to five minutes after a sign-out.
- **One signing key, no rotation.** Rotating `CONTEXT_SECRET` invalidates outstanding tokens. There is no `kid` handling beyond the fixture key.
- **Art files stay readable by hash** after sharing stops, and may sit in caches.
- **Old anonymous share rows** (owner `anon`, before device binding) have no owner: nobody can revoke them.
- **Gift messages** are readable by anyone holding the gift link (that is the design) and are kept until the sender revokes, stops the share or deletes the account; there is no expiry. `ClaimClient` still decodes legacy payloads locally.
- **Staff access is by email allowlist** and gives `admin.view` only. There is no audit log of admin reads yet.
- The mail provider is outside this test. Sandbox links appear on screen in demo mode by design.
