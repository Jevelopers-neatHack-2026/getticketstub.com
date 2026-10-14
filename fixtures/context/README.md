# Context fixtures (`ticketstub.context/1` and `/2`)

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
| `schema` | `ticketstub.context/1` for this section. `/2` is supported below; any other schema is `unsupported_version`. |
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
| `unsupported-version.json` | `unsupported_version` (schema `ticketstub.context/3`, validly signed; `/1` and `/2` are known) |
| `cross-project-a.json`, `cross-project-b.json` | ok. The same user on `stub_fx_1` and on `stub_fx_2`. A token for one must not authorize the other. |
| `tenant-a-owner.json`, `tenant-b-owner.json` | ok. Two tenants, each owning a stub called `stub_fx_shared`. Key every lookup by tenant **and** project. |

Run from the repository root with the [application toolchain](../../README.md#quickstart). Regenerate with `node fixtures/context/generate.mjs` (deterministic). Check with `node fixtures/context/verify.mjs`, which needs no installed dependencies.

## How a consumer verifies

1. **Signature, version, expiry (offline).** `verifyContext(token, key, {now, state})` in `verify.mjs` uses Node built-ins. The complete reference module also imports the pure scope projection `src/server/finance-scope.ts`; include that module if copying the whole fixture. Run with the declared application Node 22 toolchain (native type stripping). It checks, in this order: shape (`unknown`), HMAC in constant time (`forged`), schema (`unsupported_version`), expiry (`expired`), and, when `state` is given, session (`revoked`) then revision (`stale`).
2. **Stale and revoked (needs the issuer).** `state` is `{ membershipRevision, sessionLive }` for the token's account, which only the issuer knows. Get it by calling the issuer's `POST /api/context/verify` with `{token}` on every mutation, read, retry, import, job, export and download (200 with the context, or 401 with `{ok:false, reason}`), or have the issuer push the state.
3. **Bind it to the request.** After the token is good, check `authorizes(ctx, {tenant, project, capability})`: `ctx.tenant.id`, `ctx.project` and the capability must match the tenant, project and action being asked for. A tenant, project, role, filter, cursor, correlation id or signed evidence reference supplied by the caller grants nothing.
4. **Fail closed.** Unknown, forged, stale, revoked, expired and unsupported-version are all denials. A denied mutation must change no state. Never show the existence of a project the token does not cover: answer as if it were not there.
5. **Do not mint, widen or cache past `expiresAt`.** The consumer is not an identity authority.

Production consumers hold the issuer's `CONTEXT_SECRET`-derived key through their own secret store. It is never in this folder, and the fixture key must never be set as `CONTEXT_SECRET`.

## Context `/2` and finance fixtures (`v2/`)

`ticketstub.context/2` is the version for finance consumers. `/1` and everything above is unchanged and still verifies. Why a new version, the grant matrix, the mode mapping and the GT-FIN-001..003 map are in `docs/architecture/identity.md` ("Context /2 and the finance handoff"). Same token format and key, same fixture-only warning: **the fixtures prove a consumer can read the format, not that the live issuer is integrated, and Finance has not accepted the grant matrix or the mode mapping.**

What changes in `ctx`:

| Field | `/2` |
| --- | --- |
| `actor.id`, `tenant.id` | Kind-prefixed and equal: `account:<id>`, `guest:<id>`, `anonymous:0`. Two kinds never collide. |
| `project` | `{kind, id, ref}`, `ref` is `<kind>:<id>` |
| `environment` | `development`, `preview`, `live`: where it runs |
| `economicMode` | `none`, `sandbox`, `paid_test`, `live`: whether real money is at stake. `paid_test` is real money spent in testing, an actual expense. |
| `evidenceMode` | `fixture`, `synthetic`, `live`: what kind of record backs it |
| `issuer`, `audience` | `getticketstub.com`, and the host the token is for |
| `capabilities` | the `/1` capabilities plus explicit `finance.*` grants. The role is informational. |

Finance grants: `finance.read`, `finance.export`, `finance.command.budget_change`, `finance.command.expense_adjust`, `finance.command.reservation`, `finance.command.reconcile`, `finance.command.recovery`. An event captain holds read and export on that event. An event member (never issued yet) holds read. A stub owner, a guest and an ordinary account hold none. Staff hold every grant in the platform scope (a context with no project) and nothing on a project they do not hold.

| File in `v2/` | Expect |
| --- | --- |
| `finance-read-allowed.json`, `finance-read-denied.json` | captain holds `finance.read`; a stub owner holds no finance grant |
| `finance-export-allowed.json`, `finance-export-denied.json` | captain holds `finance.export`; an event member does not |
| `finance-command-allowed.json`, `finance-command-denied.json` | staff in the platform scope hold every `finance.command.*`; the captain holds none |
| `finance-guest-denied.json` | a guest holds no finance grant |
| `injective-account.json`, `injective-guest.json` | the same raw id as `account:` and as `guest:`: different actor and tenant |
| `economic-sandbox.json`, `economic-none.json`, `economic-paid-test.json`, `economic-live.json` | each carries its three modes and the proposed versioned finance adapter result (`financeAdapter`). `economic-paid-test` is `preview` / `paid_test` / `fixture`: billingMode `live`, an actual expense. |
| `wrong-audience.json`, `right-audience.json` | verified with `audience` set to another host, `wrong_audience`; with the right one, ok |
| `revoked-membership.json` | `revoked` (state `sessionLive: false`) |
| `project-membership-removed.json` | `revoked` (state `projectMember: false`: the account no longer holds the project) |
| `stale-revision.json` | `stale` |
| `boundary-actor-128.json`, `boundary-actor-129.json`, `boundary-actor-raw-128.json`, `boundary-project-128.json`, `boundary-project-129.json`, `boundary-project-raw-128.json` | kind-prefixed id length against Finance's 128 limit. All six are valid `/2` tokens. The adapter accepts the 128 ones (and they pass `TrustedScope`) and refuses the 129 and 128-raw ones with `identifier_too_long`. `tenant.id` equals `actor.id`, so the actor rows are the tenant rows. |
| `malformed-shapes.json` | 95 validly signed contexts, each malformed in one field, every one `unknown`: the original 40 (retained, in order, with their reasons) then 55 wrong-type negatives, each enum field (`/1`: `environment`, `mode`, `project.kind`, `actor.kind`, `role`; `/2`: `environment`, `economicMode`, `evidenceMode`, `project.kind`, `actor.kind`, `role`) as an array, object, `null`, number and boolean. A wrong-typed `schema` is `unsupported_version`, and is checked in the tests and the `finance-context` suite rather than in this file. The first 40: This includes the seven shapes the Finance receipt found passing the old offline verifier (missing actor id, missing or unknown environment, missing or unknown mode, malformed project kind or id, missing `issuedAt`), and the `/2` shapes: unprefixed or wrongly prefixed ids, tenant not equal to actor, missing or unknown economic or evidence mode, `paid_test` from a live environment, live money from development, a project ref that does not match, a finance grant held by a guest, an unknown `finance.*` string. |

`verify.mjs` adds, for `/2`: `verifyContext(token, key, {now, state, audience})`, where `state` may carry `projectMember`; `authorizesFinance(ctx, {tenant, project?, capability, expect?})`, which reads only `capabilities`, binds tenant and project scope exactly, refuses `/1`, and, when `expect` pins the three modes, refuses a mismatch; and `toFinanceScope(ctx)`, the proposed adapter onto Finance's `TrustedScope`. It returns a versioned result, never a bare scope:

- `{ ok: true, schema: "ticketstub.finance-scope-adapter/1", scope, evidenceMode }`. `scope` is exactly `tenantId`, `projectId`, `environment`, `billingMode`, `actorId` (the consumer schema is `additionalProperties: false`). `evidenceMode` (`mocked` / `sandbox` / `live`) is not part of `TrustedScope`, so it travels beside the scope and the consumer decides where to record it. `paid_test` still maps to `billingMode: "live"`.
- `{ ok: false, schema, reason: "identifier_too_long", fields }` when a mapped id is over 128 characters (Finance's `maxLength`). The kind prefix adds 5 to 8 characters to a raw id the producer accepts at up to 128. The adapter never truncates, never drops the kind and never invents an id. The producer does not cap raw ids at issue: its own ids are about 20 characters, `/1` and `/2` verifiers keep accepting raw ids to 128 (a cap would reject tokens `/1` accepts today), and the bound lives where Finance's limit is.
- `{ ok: false, schema, reason: "unsupported_context" }` for a `/1` context or an unmapped mode. Treat every refusal as a denial.

`finance-trusted-scope.schema.json` is a vendored copy of Finance's `TrustedScopeSchema` (the source commit is in its `$comment`). `tests/finance-context.test.mjs` checks every fixture row's adapter scope against it, always. With `FINANCE_CONSUMER_DIR=<a cost-intelligence checkout with node_modules>` it also runs the consumer's own TypeBox `Value.Check` on every scope, checks that the naive prefixed scope is rejected, and fails if the vendored file has drifted. If the variable is set and the checkout cannot be loaded, the test fails: skipping is failure.

`verify.mjs` and the server run the same shape rules. `tests/finance-context.test.mjs` requires identical answers on every malformed input. The product suite posts the same corpus to `POST /api/context/verify` on its isolated production-build fixture server and compares. After installing the application dependencies, run from the repository root:

```sh
npm run build
npm run verify:product -- --suite finance-context --mode fixture --evidence-dir out/evidence
```

To select a project: `GET /api/context?v=2&project=event:<id>` with the user's session. The server proves the selection from its own records, and a project the caller does not hold is a `404`. `POST /api/context/verify` accepts `{token, audience?}` and re-checks session, project membership, revision, audience and modes at that moment.

`corpus.mjs` holds the malformed corpus as data, so each caller signs it with its own key. Regenerate with `node fixtures/context/generate.mjs`; check with `node fixtures/context/verify.mjs`.
