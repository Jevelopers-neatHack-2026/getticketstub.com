# Deployed integration settings

This is the single environment inventory for the settings migration under
[getticketstub.com#27](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/issues/27) and
[#19](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/issues/19). See the
[actual canonical creative composition](../integration/creative-engine.md). Code integration, owner agreements,
account eligibility and hosted verification remain distinct. No provider charge or publication is authorized here.

**REQUEST_CHANGES / producer adoption blocked:** Finance-owner review F1–F4 supersedes the earlier48dd offline lifecycle qualification. Pinned Finance public CI05B settlement/release and exact native custody/intake adoption remain unavailable. New canonical `generate`/`edit` and direct new Finance admission/dispatch are unconditionally disabled; no configuration, registry ACK/boolean, credential or synthetic fixture enables them. Read/state/cancel and bounded already-committed-command recovery preserve durable evidence. Releasing this barrier requires the accepted public Finance release and exact independently reviewed consumer ACK.

| Name | Owner / actual consumer | Purpose | Secret? | Required environments |
| --- | --- | --- | --- | --- |
| `APP_URL` | Application / orders, email and origin checks | This deployment's canonical origin; server appends the order return path | No | Live checkout; set Preview separately before hosted test checkout |
| `DODO_PAYMENTS_RETURN_URL` | Retired / no consumer | Superseded by the canonical per-order return route | No | None |
| `DODO_PAYMENTS_API_KEY` | Application / Dodo adapter | Checkout/payment API authentication | Yes | Enabled Dodo environment, separate test/live identity |
| `DODO_PAYMENTS_WEBHOOK_KEY` | Application / webhook | Signed payment verification | Yes | Enabled Dodo environment |
| `DODO_PAYMENTS_PRODUCT_ID` | Application / Dodo adapter | Server-selected digital USD product | No | Enabled Dodo environment |
| `DODO_PAYMENTS_ENVIRONMENT` | Application / Dodo adapter | Explicit `test_mode` or `live_mode`; invalid/missing disables payments | No | Enabled Dodo environment |
| `TICKETSTUB_RUNTIME_MODE` | Application / providers and context | Existing live execution gate; default demo does not dispatch | No | Deployment's intended runtime |
| `TICKETSTUB_ART_PROVIDER` | Application / studio executor | Direct `openai` or `openrouter` | No | Live studio images |
| `TICKETSTUB_ART_MODEL` | Application / real provider request | Explicit direct ID or OpenRouter slash ID; no implicit model | No | Live studio images |
| `GPT_IMAGE_MODEL` | Application / direct compatibility path | Alias only when canonical model absent; both must match if present | No | Migration only, direct OpenAI only |
| `GPT_IMAGE_ACCESS_MODE` | Development tooling / no deployed adapter | Subscription/API tooling preference; grants no deployed API entitlement | No | Development only; exclude from hosting requirements |
| `OPENAI_API_KEY` | Application / direct provider | Server API credential; development subscription login is not this key | Yes | Direct OpenAI studio execution |
| `TICKETSTUB_ART_OPENROUTER_API_KEY` | Application / studio provider | Independent studio credential | Yes | OpenRouter studio execution |
| `TICKETSTUB_CREATIVE_CONFIG` | Application / canonical creative host | Grouped nonsecret environment, private volume paths and staged image profile | No | Enabled canonical creative host |
| `CREATIVE_ENGINE_OPENROUTER_API_KEY` | Host credential port / engine adapter | Staged dedicated creative identity; no studio/OpenAI fallback or dispatch while gated | Yes | Canonical creative image execution |
| `TYPESAFE_API_KEY` | Host injection / harness DecisionPort / JEV transport | Staged dedicated TypeSafe server API credential; no paid dispatch while gated | Yes | Canonical operations requesting JEV decisions |
| `TICKETSTUB_FINANCE_DATABASE_URL` | Application pool / Finance SQL APIs | Restricted PostgreSQL recovery connection; verified TLS in Production; not an adoption grant | Yes | Enabled canonical creative host |
| `CONTEXT_SECRET` | Application context issuer | Existing signed/current context authority | Yes | Live execution |
| `ADMIN_EMAILS` | Application current membership | Staff commissioning; does not replace delegated Finance grants | No, private metadata | Commissioning environments |
| `TICKETSTUB_DB`, `TICKETSTUB_FILES` | Application storage | Durable sessions/ownership/quotas and images | No, private paths | Persistent deployments |
| `TICKETSTUB_OPS_ENVIRONMENT` | Application / isolation gate and telemetry | `production`, `preview`, `test`, `development`; creative maps Preview to Finance `test` | No | Enabled canonical host; Preview/Production differ |
| Existing full source revision (`GIT_SHA` etc.; build `TICKETSTUB_BUILD_COMMIT`) | `deployedCommit` / health and creative manifest | Reproduced application SHA; reuses established metadata | No | Enabled canonical host |
| `TICKETSTUB_ANALYTICS_ENV`, `TICKETSTUB_GA_MEASUREMENT_ID`, `TICKETSTUB_GA_DEBUG` | Application browser analytics | Existing public Preview overrides | No | Restore manually after each authorized publication |

Existing Research/agent, Neatlogs, mail, backup and fulfillment settings retain their ownership and rotation.
Never place credential values in grouped configuration, an authority registry, a manifest, an issue or a diagnostic.

## Dodo and image migration decisions

Retire `DODO_PAYMENTS_RETURN_URL`. The [official Dodo checkout integration](https://github.com/dodopayments/skills/blob/main/dodo-payments/checkout-integration/SKILL.md)
accepts a per-checkout redirect and distinguishes it from verified payment. The application already sends
`APP_URL/payment/return?order=<server id>` and waits for the signed, re-fetched payment webhook before marking
paid. Tests exercise the real orders route: separate Preview/Production origins, retained order metadata,
ignored obsolete/client redirect values, and missing/invalid live configuration with zero provider calls.

`APP_URL` is required for live checkout. Issue27 reports Preview inherited the Production origin; restore the
Preview origin before any hosted checkout verification. This manual correction is **not completed** by local
tests. Configure hosted test mode explicitly rather than depending on the request-host fallback. No independent
return host or client-controlled redirect is introduced.

The studio owns `TICKETSTUB_ART_MODEL` for either provider. Direct OpenAI accepts `GPT_IMAGE_MODEL` as a
migration alias, rejects blank/conflicting/unsupported values before transport, and never uses a subscription
preference as API access. OpenRouter uses its own slash ID and capability lookup. Model IDs follow the
[official Images API inventory](https://developers.openai.com/api/reference/resources/images/methods/generate).
As checked 2026-10-12, [official deprecations](https://developers.openai.com/api/docs/deprecations) list
`gpt-image-1` shutdown on 2026-10-23 and other retained legacy image IDs on 2026-12-01. These are explicit
compatibility inputs only; choose/verify an eligible replacement before retirement. No silent model upgrade occurs.

Deploy alias support first, then set/verify the canonical model, then remove `GPT_IMAGE_MODEL` if no longer
needed. If both direct names remain, their values must match. Exclude `GPT_IMAGE_ACCESS_MODE` from hosted
settings while retaining any intentionally used development preference. Documentation/accepted IDs do not prove
account entitlement. Configured studio errors now remain errors; default demo behavior still works offline.

## Creative configuration and provisioning

Absent `TICKETSTUB_CREATIVE_CONFIG` leaves the canonical host off with a clear unavailable error. Its strict JSON
object contains `schema_version: "ticketstub.creative-host/1"`, `environment` (`development`, `test`, `production`),
absolute `database_path`, `object_root`, `registry_path`, and `image_profile` with exactly `model_id`,
`provider_tag`, `capabilities`, `supported_parameters`, `configuration`. The owned engine validates that profile.
There are no default models or embedded keys. Preview must use separate paths, registry, Finance test partition
and credential/delegation identities from Production; the ops environment must match.

The private registry is `ticketstub.creative-authority/1` with `projects`. Records bind existing application
project/owner, canonical tenant/project/budget UUIDs, brief reference, allowed commissioning actors, explicit
creative permissions, delegated Finance service operations, bounded maximum and budget-policy refs, independent
current image/decision access evidence, current Research package and asset rights. Optional usage profiles and
decision tariffs are owner-reviewed, expiry-bound, exact-model-bound records. Missing/stale/revoked/wrong-scope
or malformed records fail closed. Requests never install them. Use an owner/root-owned regular mode600 file in
a private directory/volume and replace it atomically. Credentials remain separate server secrets.

Provision PostgreSQL with the exact vendored cost-intelligence migrations and migrator role before startup.
The runtime login inherits only `ci_finance_runtime`, without superuser/owner/migrator access. Provision budget
policies and approved immutable tariffs through real Finance owner APIs. The route never initializes capacity
from a key balance, quotas, a customer role or request amount. Existing CI05B/FC semantics and the explicit
`PricingEstimateReceipt` compatibility projection remain owner agreements; seeded offline policies are not
accepted production records.
The Finance URI must be a TCP PostgreSQL URL with user/password/database and no query or fragment. The host
parses it once and passes explicit pg options; Production always verifies TLS certificates and retains bounded
connect/statement timeouts. URI `sslmode`, `ssl`, timeout overrides and TLS file parameters are rejected before
pg parsing. Remove those query parameters when provisioning this host; they cannot weaken its TLS policy.

The earlier image usage, Finance-compatible UUID/model label and PricingEstimateReceipt projections are unaccepted historical compatibility proposals. They no longer submit new intake, settle/release the lower engine, allocate new projection identities or upgrade profile-mapping-pending counters to financial completeness. Preserve their original evidence, but do not treat a profile/registry field or matching hash as owner acceptance. Provider-reported unsettled cost and tariff estimates do not establish financial finality. The accepted native identity/custody, pricing dimension and atomic public lifecycle are owner dependencies, not a runtime option.

Actual historical intake `accepted`/`duplicate` with durableCommit preserves intake/outbox work, not posted expense or completed atomic settlement. Pending/retry outboxes remain recoverable holds. This host performs no new expense posting, quote delivery, outbox drain or financial release while the custody/lifecycle gate is closed. Original observations, commands, receipts and unknown holds remain durable; do not overwrite quarantine or blindly resend a provider request.

Current recovery compares the complete held/current service/source/policy and account/project/grant/model/operation record after asynchronous digests, owner SQL reads and exact dispatch replay. It also repeats the existing storage-owned synchronous session/staff/revision/ownership check. Missing/partial old custody is unavailable. A new dispatch cannot be appended: recovery requires an existing dispatched owner state at a revision newer than the persisted command, then the exact owner `replay` outcome with matching reservation/revision/hold. New, missing and divergent commands remain held. Settlement/release stay unavailable until the accepted public contract; no estimate/counter or locally registered request digest supplies finality.

Recovery updates merge into the latest SQLite row with an exact-byte conditional write, including across request instances and connections to the same physical database. Immutable observations, original requests/receipts and prior hold reasons survive concurrent replay acknowledgements. Conflicting bytes for an existing observation ID are denied without replacing the original. This protects recovery evidence; it supplies no lifecycle acceptance.

These delegated service records authorize only the listed creative Finance operations. They grant no Dashboard
read/export capabilities and do not approve the separate `/2` Finance namespace proposals. The deployed customer
studio still uses its existing image path; customer creative commissioning requires an owner-approved delegation
journey. A repeated running creative job returns HTTP202 with its existing job reference and no published result.

Configuration/profile/environment/DB connection changes and credential rotation require a process restart.
The host refuses opening two different configurations on the same active creative database. The pinned creative
source does not qualify multiprocess publication; separate CE PR50 remains its owner's work. Within one host
process, every request uses the same store-owned adapter/controller and serialization queue. Request-specific
actor, registry, planning, credential and cancellation closures are rebuilt for each request. Private Finance
mapping writes refuse an active owner publication transaction; they never join a different request's transaction.

## Dependency order, hosting changes and rollback

1. **Finance first:** coordinate the accepted released public intake/custody and atomic settlement/unused-release lifecycle, then obtain the exact Product consumer ACK after money/supervisor review. Do not deploy or toggle the paid host in the interim. Preserve the accepted creative-engine/harness dependency order. The application pins **exact reviewed SHAs** in its existing vendor manifests.
   Current draft pins: creative `e4fa66488f31577f516b27238e945a1fb3c2143f`, harness
   `fd4eaf2a54cb68740c960d5e061d4c4b11e79251`, Finance `a08760e9ea65bda1e116867ac00b3e03d737bb7e`.
   Final deployment requires the independently reviewed exact heads. Refresh scripts preserve harness observability.
2. Build/test on Node22.23.3/npm11.16.0. After committing, build/verify the existing assembly snapshot and inspect
   application SHA, package-lock hash and installed component pins. A planning inventory/snapshot is not behavior evidence.
   `npm run verify:creative-host` is mandatory qualification: provision/cache the PostgreSQL16 digest
   `sha256:ca0bd484cb98bf4b24eb1010e73fb3fcbd6714d240fbc1a10eea5b7dbecb641d`, then run with a minimal environment.
   It must report zero required skips. The default `npm test` skips this engine-owning test and cannot qualify
   the assembly alone. CI separately pulls that exact image and runs the mandatory command. The test creates
   and removes its own disposable container, applies all ten pinned migrations and uses a restricted runtime login.
   The new suite qualifies unavailable/recovery behavior only: actual application session/read state and owner SQL, zero new Product admissions/provider writes/artifacts, exact already-committed dispatch replay, custody changes and durable pending/retry holds. Owner fixture records/IDs remain synthetic, never acceptance. Earlier48dd provider/artifact evidence remains preserved but superseded for Finance compatibility.
3. Keep the unconditional paid lifecycle barrier until the released owner contract, native custody/intake/finality semantics and exact consumer ACK exist. Then provision isolated private volumes, restricted Finance/TLS access, actual current delegation/tariffs/account eligibility. Provisioning alone cannot enable the old pinned lifecycle.
4. An authorized Preview publication installs supported code/config before removals and corrects Preview `APP_URL`.
   Qualify sharp0.35.5 on the actual GoDaddy Node22 host using saved offline PNG/JPEG/WebP through the owned
   inspector. Local installation is not hosted native-codec qualification.
5. After **every** authorized publication, follow [the mandatory analytics gate](analytics-rollout.md#after-every-publish-restore-and-verify-preview):
   restore only the four public Preview overrides in two saves, restart Preview, and verify fresh sessions against
   separate properties. Preserve unrelated settings. The fourth override is `TICKETSTUB_OPS_ENVIRONMENT`; verify
   the creative environment mapping after restoration.
6. Only after the accepted released Finance contract and exact consumer ACK, with separate explicit authorization/budgets, execute staff-owned brief/generate/edit/decision/cancel/recovery
   journeys in Preview and verify real reservations, usage-or-unknown observations and immutable artifacts.
   Production needs its separate account/policy/host evidence. Do not close issues from local tests.

Proposed GoDaddy **additions**, names only: `TICKETSTUB_CREATIVE_CONFIG`, `TICKETSTUB_FINANCE_DATABASE_URL`.
**Existing settings newly consumed:** `CREATIVE_ENGINE_OPENROUTER_API_KEY`, `TYPESAFE_API_KEY`; verify each
environment's credential identity and rotation independently without duplicating its value into grouped config.
**Replacements/corrections:** `APP_URL` (Preview), `TICKETSTUB_ART_MODEL`, existing full source-revision metadata.
**Removals after support/verification:** `DODO_PAYMENTS_RETURN_URL`, hosted `GPT_IMAGE_ACCESS_MODE`, then
`GPT_IMAGE_MODEL` when the canonical model is verified. Rotate creative and studio credentials independently.
This removes confirmed obsolete entries and groups only nonsecret configuration; it does not authorize changing
other settings to meet the hosting limit.

Rollback: clear only `TICKETSTUB_CREATIVE_CONFIG`, restart, and restore the previous application commit/lockfile
with its exact vendored pins and deployment-specific model/origin/ops settings. Preserve creative SQLite/objects,
Finance PostgreSQL ledger/reservations, unknown holds, private attribution and usage queues for reconciliation.
Never reset them to make rollback appear clean. Restore legacy aliases only for a consumer that needs them;
do not restore the unused Dodo setting. Any authorized rollback publication also requires the Preview analytics gate.

Mandatory adoption blocker: accepted released public Finance intake/custody, atomic settlement/unused-release/finality contract and exact independent Product consumer ACK. Remaining live evidence: owner service/customer delegation; real Finance
network/TLS/policies/tariffs; hosted native codec; model/account/quota eligibility and key limits; authorized paid
journeys; hosted origin/analytics isolation; durable recovery and multiprocess qualification. Offline tests seed
external records and intercept transport; they prove code behavior, not these live gates.
