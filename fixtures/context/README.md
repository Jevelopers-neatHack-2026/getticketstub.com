# Context fixtures (`ticketstub.context/1`)

Sanitized, deterministic examples of the signed request context that `getticketstub.com` issues to downstream consumers (team-dashboard, cost-intelligence). No real account, email or session appears in them: every id is `*_FIXTURE_*` or `fx...`.

> **FIXTURE ONLY. NEVER PRODUCTION.** `fixture-key.json` holds the HMAC key these tokens are signed with. It is public on purpose. Tokens made with it say `"mode": "fixture"`. No deployment is configured with it, so a production verifier using its own key rejects every one of them as `forged`. Fixture success shows a consumer reads the format. It does not show integration with the live issuer.

## Token format

```
base64url(header) . base64url(payload) . base64url(signature)
header    {"alg":"HS256","typ":"ticketstub.context"}
payload   {"ctx": <RequestContext>, "sid": <string or null>}
signature HMAC-SHA256(key, base64url(header) + "." + base64url(payload))
```

`ctx` is the `RequestContext` of `src/server/context-token.ts`:

| Field | Meaning |
| --- | --- |
| `schema` | `ticketstub.context/1`. Anything else is `unsupported_version`. |
| `actor` | `{kind:"account",id}`, `{kind:"guest",id}` or `{kind:"anonymous"}` |
| `tenant.id` | account id, or `guest:<id>` |
| `project` | `{kind:"stub"\|"event", id}`, when the context is for one project |
| `role` | `owner`, `captain`, `member`, `viewer`, `staff`, `none` |
| `capabilities` | what this actor may do here, from the matrix below |
| `membershipRevision` | the account's counter. It rises when the email changes, on sign-out everywhere, and when staff status changes. |
| `revoked` | true if the session behind it was revoked when issued |
| `environment`, `mode` | `development`/`preview`/`live`, and `fixture`/`sandbox`/`live` |
| `issuedAt`, `expiresAt` | ISO. The lifetime is 5 minutes. |

`sid` is a non-secret reference to the session the context came from (null for guests). The issuer uses it to tell whether the session is still live.

## Capability matrix

| Actor and role | Capabilities |
| --- | --- |
| Everyone (anonymous, guest, account) | `stub.draft` `art.generate` `agent.use` `share.create` `share.view` `wall.public.view` `claim.view` `file.read` `order.create` |
| Account, any role | the row above and `account.read` `account.email.change` `account.delete` `session.revoke` `wall.sync` `wall.publish` `order.read` `event.create` `claim.redeem` |
| `owner` of a stub | `stub.read` `stub.write` `share.revoke` `gift.create`, and `stub.approve` and `order.authorize` for a signed-in account only (a guest device that owns a stub is refused) |
| `captain` of an event | `event.read` `event.publish` `claims.read` |
| `member`, `viewer` | `stub.read` on a stub, `event.read` on an event (modelled, never issued yet) |
| `staff` (account on `ADMIN_EMAILS`) | `admin.view`, and no project access |
| `none` on a project | nothing beyond the first row |

The matrix is `CAPABILITY_MATRIX` in `src/server/context-token.ts`. The smoke test checks every fixture against it, and checks this table lists every capability.

## Fixtures

Each file is `{fixture, description, verifyAt, token, state?, expect}`. Verify at `verifyAt` (not the wall clock) with the fixture key and `state`, and expect `expect`.

| File | Expect |
| --- | --- |
| `owner.json` | ok, role `owner` on `stub:stub_fx_1` |
| `captain.json` | ok, role `captain` on `event:evt_fx_1` |
| `staff.json` | ok, role `staff`, `admin.view`, no project |
| `guest.json` | ok, actor guest, role `none`, no account capabilities |
| `unknown.json` | ok, actor anonymous, role `none`: a valid token that grants nothing private |
| `malformed.json` | `unknown` (not a token) |
| `forged.json` | `forged` (signed with another key) |
| `stale.json` | `stale` (state revision 4, token says 3) |
| `revoked.json` | `revoked` (state `sessionLive: false`) |
| `expired.json` | `expired` (issued ten minutes before `verifyAt`) |
| `unsupported-version.json` | `unsupported_version` (schema `ticketstub.context/2`, validly signed) |
| `cross-project-a.json`, `cross-project-b.json` | ok. The same user on `stub_fx_1` and on `stub_fx_2`. A token for one must not authorize the other. |
| `tenant-a-owner.json`, `tenant-b-owner.json` | ok. Two tenants, each owning a stub called `stub_fx_shared`. Key every lookup by tenant **and** project. |

Regenerate with `node fixtures/context/generate.mjs` (deterministic). Check with `node fixtures/context/verify.mjs`.

## How a consumer verifies

1. **Signature, version, expiry (offline).** Copy `verifyContext(token, key, {now, state})` from `verify.mjs`. It has no dependencies. It checks, in this order: shape (`unknown`), HMAC in constant time (`forged`), schema (`unsupported_version`), expiry (`expired`), and, when `state` is given, session (`revoked`) then revision (`stale`).
2. **Stale and revoked (needs the issuer).** `state` is `{ membershipRevision, sessionLive }` for the token's account, which only the issuer knows. Get it by calling the issuer's `POST /api/context/verify` with `{token}` on every mutation, read, retry, import, job, export and download (200 with the context, or 401 with `{ok:false, reason}`), or have the issuer push the state.
3. **Bind it to the request.** After the token is good, check `authorizes(ctx, {tenant, project, capability})`: `ctx.tenant.id`, `ctx.project` and the capability must match the tenant, project and action being asked for. A tenant, project, role, filter, cursor, correlation id or signed evidence reference supplied by the caller grants nothing.
4. **Fail closed.** Unknown, forged, stale, revoked, expired and unsupported-version are all denials. A denied mutation must change no state. Never show the existence of a project the token does not cover: answer as if it were not there.
5. **Do not mint, widen or cache past `expiresAt`.** The consumer is not an identity authority.

Production consumers hold the issuer's `CONTEXT_SECRET`-derived key through their own secret store. It is never in this folder, and the fixture key must never be set as `CONTEXT_SECRET`.
