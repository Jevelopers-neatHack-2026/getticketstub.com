# Creative-engine application integration

Finance-owner review of source `48dd51940381882c2160a6139aa0c0bbf46d60d6` found F1–F4 incompatible with the accepted public lifecycle. Producer adoption/shipping is **blocked**. The historical offline CI and UI/component review do not establish Finance acceptance; their receipts remain preserved as superseded evidence.

`POST /api/creative` invokes the canonical owned `creative-engine/api/v1` API for scoped read/state operations. It accepts `{projectId, operation, actionId, payload, sourceRefs?, environment?}` with a development environment that must equal the server. Current staff session, existing stub ownership and private registry scope/permissions remain required. `brief.create`, `list`, `compare`, `restore`, `cancel` and `job.status` preserve existing state and recovery. `generate` and `edit` fail with `creative_finance_lifecycle_unavailable` before C03 admission, provider DNS or provider writes. A key, registry field, environment variable or test cannot override the source-owned barrier.

Direct new Finance admission/dispatch authorization is also unavailable. The Product no longer imports or calls the exported lower settlement/release engines, creates financial finality from counters/estimates, or allocates compatibility UUID/model/quote projections. Settlement/release requests retain recovery state and existing holds. Finance must first release its accepted public intake/custody and atomic settlement/unused-release lifecycle, then the exact Product consumer needs independent review and a named owner ACK. Finance PR40, proposal schemas, development aliases, synthetic fixtures and syntactically valid registry records are not that release/ACK.

Bounded recovery may acknowledge an already committed dispatch command only. It preserves the original command bytes and IDs, verifies the actual current owner SQL state/revision/binding, prevents a new append using the old expected revision, and accepts only the owner's exact `replay` outcome. Missing, divergent, uncommitted or incomplete-custody records remain held. Source/service/policy/account/project/grant/model/operation identity is compared to the held record after every digest/snapshot/replay await; the context/storage-owned synchronous session/staff/revision/ownership fence also runs before local ACK. Comparison snapshots and request digests do not mint authority or adoption.

Original CE observations, persisted requests, actual historical intake receipts, pending/retry outboxes, reservations, jobs and artifacts remain available for recovery. No new intake/quote delivery or expense posting is enabled while public custody is unavailable. An accepted durable intake receipt is neither posted expense nor atomic completed settlement/finality/full unused release. Pending/retry receipts retain a recovery hold. Provider-reported unsettled cost and estimate provenance remain distinct from invoice reconciliation.

Concurrent recovery writers reload the latest SQLite row and compare immutable custody before merging their own fields. An exact-byte conditional update retries a competing write across request instances or connections to the same database. Distinct observations remain durable; repeated identical observation IDs are idempotent, conflicting bytes are denied, and replay ACKs preserve existing usage receipts and unknown holds. This storage coordination does not enable new Finance writes.

The existing vendored source manifests and assembly tooling pin the owned components. `npm run verify:creative-host` is mandatory real-PostgreSQL qualification of this **blocked/recovery boundary**, not a positive paid-journey acceptance test. It exercises actual app sessions/read state, zero new admissions/provider writes/artifacts, exact committed-command replay without duplicate money, current custody changes, concurrent immutable observations/replay ACKs and durable pending/retry recovery. External records and IDs are explicitly synthetic fixture data; they confer no live/source authenticity. The source at 48dd and its earlier positive artifact evidence are historical and superseded for lifecycle acceptance.

The current studio `/api/art` remains a separate credential/provider consumer. See [deployed settings](../operations/deployed-settings.md) for the inventory and Finance-first deployment/rollback gate. No production setting, paid call or publication is authorized by these repairs.

## Historical studio mapper boundary

The existing studio `/api/art` is still a separate provider consumer. Its client mapper and the material below
document the earlier proposal; they do not establish a migrated studio creative journey or new server authority.

**Historical app-source audit:** `getticketstub.com` `main` at [`138e4b9019c0f5a55ad5e3f586d129216b680e4d`](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/tree/138e4b9019c0f5a55ad5e3f586d129216b680e4d), audited 2026-10-12. The app-native landing change did not change the creative adapter or route. **Related component source:** [`creative-engine` main at `5b0f354dd8871550345863aef4017b7bbba3bd86`](https://github.com/Jevelopers-neatHack-2026/creative-engine/tree/5b0f354dd8871550345863aef4017b7bbba3bd86). At that app revision, the local pure mapping layer and offline fixture comparison did not import or call the creative-engine package or service. This observation predates the blocked/recovery host described above; it does not describe the current vendored runtime or change its exact source pins. The component revision inspected by that audit contains local synthetic API, version, controls, inspection and metering-port implementations, so the former description of main as architecture-only is stale. Its provider preflights and live gates remain fail-closed, and the external C01-C04 agreements remain pending. Neither repository's local code proves an integrated creative workflow or acceptance.

> **Compatibility-note age:** The mapping and control tables below compare the app adapter with creative-engine proposal commit `65b8036194b3b962e1fd34f7193d54791cf07c88`, not the current `creative-engine` main revision above. Treat them as a dated compatibility analysis, not a current contract. Re-check both source trees, the maintained contract catalog, owner agreements and master acceptance before using or changing the mapping.

Code: `src/customer/studio/creative/` (`contracts.ts`, `controls.ts`, `adapter.ts`, `fixtures/`).
Check: `node scripts/check-creative-adapter.mjs` (Node22.23.3). It builds a brief, edit plans, a control schema and API envelopes from the demo stub and compares keys and enums with creative-engine's fixture JSON.

The mapper originally tracked `impl/creative-brief-integrated` at `96d56f3`. Current runtime source instead
comes from the exact vendored creative-engine revision. Historical `PENDING_` refs below are not accepted
host authority; actual deployment still requires current owner agreements and live evidence.

The dated compatibility audit links [creative-engine source5b0f354dd8871550345863aef4017b7bbba3bd86](https://github.com/Jevelopers-neatHack-2026/creative-engine/tree/5b0f354dd8871550345863aef4017b7bbba3bd86), its [ownership guide](https://github.com/Jevelopers-neatHack-2026/creative-engine/blob/main/docs/architecture/OWNERSHIP.md), and the [master acceptance checklist](https://github.com/Jevelopers-neatHack-2026/integration-evals/blob/main/planning/acceptance-checklist.md). This historical source link is not a runtime repin or a producer acceptance receipt.

## Mapping table

### Types

| Ours | Theirs | Notes |
| --- | --- | --- |
| `Stub.id` | `brief_id` = `brief-<id>` | One brief per stub. |
| `Stub.event` core (`title`, `dateISO`, `venue`, `city`) | `CreativeBrief.facts.verified` keys `event_name`, `event_date`, `venue`, `city` | `seat` is deliberately not sent (personal). |
| `Fact` with `confidence >= 0.8` and provenance not `pending` | `facts.verified[]` `{fact_id, key, value, provenance_refs}` | `key` = our fact id. Same 0.8 line as the pulsing chip. |
| `Fact` below that | `facts.unresolved[]` `status: "conflicting"` (2+ `alternatives`) or `"unknown"`, `candidate_values` = `alternatives` | |
| `Fact.source` / `sourceUrl` | `source_identity[]` `{source_id, uri}`, `provenance_refs` | `source_id` is a slug; the event page is `event-page`. |
| `Fact.kept` | `locks.items[]` `{lock_id, field, value_hash, reason}` and `brief.create` `locked_fields` | |
| edition, title colour, art vibe | `preferences.items[]` `{preference_id, value}` | |
| `Provenance` / `BillingMode` | `billing_mode` `live \| sandbox \| simulated` | Our `BillingMode` already equals theirs. `estimated` and `pending` have no upstream equivalent. |
| `DesignVersion.id` | `design_version_id` | Only real after the engine made it. |
| `DesignVersion.parentId` | `parent_version_id` (`null` for root, `root:<brief_id>` in a plan's `expected_result`) | |
| `DesignVersion.createdAt` | `occurred_at` | |
| `DesignVersion.edition` | none | Edition is composition, not part of their version. `fromDesignVersion` takes it as an option. |
| `ArtLayer.src` | `artifact` `{artifact_id, content_hash, media_type}` | Artifact bytes sit behind their access owner. The caller supplies `resolveSrc`. |
| `ArtLayer.provenance` | `billing_mode` plus `provider` | `live` only when `billing_mode: "live"` and a non-fixture `provider`. Everything else stays `simulated`. |
| `ArtLayer.seed` | none | Derived from the version id when needed. |
| `Material` | none | A purchase choice (`FulfillmentQuote`, `OrderAuthorization`), not a design change. |

### Edits

| Op (ops.ts) | Their operation | Field / parameters |
| --- | --- | --- |
| `setFont` | `composition.update` | `{field: "title_font", value: 0..3}` |
| `setTitleColour` | `composition.update` | `{field: "title_colour", value: "" \| "#17140F" \| "#E4572E" \| "#F4ECDD"}` |
| foil title toggle | `composition.update` | `{field: "foil_title", value: boolean}` |
| `setEdition` / `stepEdition` | `composition.update` | `{field: "edition", value: Edition}` |
| finish | `composition.update` | `{field: "finish", value: matte \| foil \| holo}`. Print-production owns the effect. |
| `toggleKept` | `composition.update` | `{field: "kept_fact_ids", value: <whole resulting list>}` |
| `setHidden`, `hideSelection` | `composition.update` | `{field: "hidden_fields", value: <whole resulting list>}` |
| note | `composition.update` | `{field: "note", value: string <= 140}` |
| `setFactValue` | `correction.apply` | `fact_id`, `replacement_value`, `evidence_refs: [PENDING_evidence_ref]`. Upstream returns `unavailable`. |
| `addArtVersion` (remix, not first) | `image.edit` | `design_version_id`, `artifact_id`, `instruction` built from the vibe |
| `addArtVersion` (first art) | `concept.generate` | `brief_id`, `variant_count: 1`, `style_ref` = vibe |
| `addArtVersion` (photo) | none | Needs an uploaded asset and a granted `ResearchPermission`. Photos are local-only today. |
| `setMaterial` | none | See above. |

Every plan sets `invalidates: ["approval", "production_bundle"]`, `expected_result.artifact_kind: "image"` and a `plan_id`/`step_id`.

### Request envelope

`toApiRequest(operation, payload, scope)` builds `CreativeApiRequest` 1.0: `contract`, `schema_version`, `event_id`, `request_id`, `tenant_id`, `project_id`, `correlation_id`, `producer` (`ticketstub-studio`), `occurred_at`, `ingested_at`, `environment`, `billing_mode`, `source_refs`, `operation`, `action_id`, `payload`. The upstream validator rejects unknown keys, so the adapter sends only these. `action_id` is the idempotency key and must be stable per user intent (reuse it on retry). The actor is **not** in the envelope: `toTrustedActor(scope)` is what the server holds.

### Controls

`controls.ts` declares ten controls in `creative-controls/1.1` shape. Upstream's producer today knows only four fixed selects (`name_size`, `layout`, `logo_position`, `style`), so all ten need their allowlist extended. `CONTROL_UPSTREAM` says how much.

| Control id | Kind / type | Range or options | Route | Gap |
| --- | --- | --- | --- | --- |
| `edition` | select / string | researched, letterpress, risograph, minimal, classic | composition.update | new field |
| `title_font` | select / integer | 0..3 | composition.update | new field |
| `title_colour` | select / string | "", #17140F, #E4572E, #F4ECDD | composition.update | new field |
| `foil_title` | toggle / boolean | | composition.update | new kind |
| `finish` | select / string | matte, foil, holo | composition.update | new field |
| `kept_facts` | multi_select / string[] | the stub's fact ids | composition.update | new kind |
| `hidden_facts` | multi_select / string[] | `subtitle` + fact ids | composition.update | new kind |
| `note` | text / string | max 140 | composition.update | new kind |
| `art_vibe` | select / string | "", Neon, Risograph, 70s, Minimal | artwork.edit | new field |
| `art_seed` | range / integer | 0..2147483647 | artwork.edit | new kind, and no upstream seed at all |

`validateControl(controls, id, value)` returns `{ok}` or `{ok: false, code, message}` using upstream `RejectionCode` names (`unknown_control`, `invalid_value`, `locked`). `controlSchemaHash()` is a real SHA-256 of the canonical inner schema (same canonical form as upstream; reproduced exactly from their fixture by the check), so `control_schema_hash` is not a placeholder.

## Placeholders (`PENDING_` prefix)

Checked at the type level (`Pending<K>` = `` `PENDING_${K}` ``); a real hash always starts `sha256:`.

| Field | Why we cannot supply it |
| --- | --- |
| `research_package_ref.package_id`, `.content_hash` | Requires an event-intelligence package with an accepted canonical identity and hash. The app can form locally package-shaped Ticketmaster data, but no shared schema/hash agreement is accepted or wired; these fields remain unavailable. See the [event-intelligence handoff](event-intelligence.md#which-shape-we-matched) and its source-backed limits. |
| `source_identity[].uri` | A fact with no `sourceUrl`. |
| `locks.items[].value_hash` | Upstream's canonical value hashing is not published. |
| `EditPlan.base.brief_hash`, `.design_hash` | The engine's canonical hashes of its stored brief and version. We only learn them from the engine's responses. |
| `expected_versions.brief`, `.composition` | We have no brief or composition version counters. |
| `correction.apply` `evidence_refs` | A customer confirming a value is not source evidence. |
| `TrustedCreativeActor.expires_at`, `budget_scope_id`, `budget_policy_version` | Application identity and cost-intelligence budgets. Metering (C03) and approval or handoff (C04) refs are also not wired, so we send none. |

## Doesn't map, or is pending upstream

- `seed` has no home in `generate`/`edit` steps, so engine output is not reproducible from our seed.
- `style_ref` is an assumption for the vibe. Upstream hasn't said what it resolves to.
- Our `Edition` and `Material` have no upstream equivalent. Edition travels as a composition field.
- Photo art needs asset upload and permission.
- `composition.update` and `correction.apply` return typed `unavailable` upstream until a composition executor and a research correction handoff exist. Only `concept.generate` and `image.edit` can produce a `DesignVersion` today.
- `MODE=live` is not implemented. Provider route, storage, jobs, metering, approval verifier and handoff are all injected ports with test fixtures only. Their `api/v1` is a handler factory (`creative-engine/api/v1`), not a deployed service: no URL or port exists yet.
- `inspect`, `list`, `compare`, `restore`, `handoff` are supported by `toApiRequest` types but unused by the studio.
- Upstream is on Node 22.23.3 / 24.15.0 and the `.d.mts` types aren't published as a package; `contracts.ts` mirrors them by hand. Re-check against upstream when they pin a release.

## Historical `/api/art` migration sketch (2026-10-10; not an approved plan or implemented studio migration)

The steps below were a proposal based on the earlier adapter review. They are not a current interface agreement, deployment guide, or authorization to wire this app to the component. The sketch assumes a service/configuration shape that has not been approved. Any integration needs fresh source review, producer/consumer and security agreement, a trusted actor and scope boundary, failure policy, evidence and acceptance before implementation.

Today `src/app/api/art/route.ts` takes `{event, vibe, seed, edition, first}` and returns an `ArtLayer`. The client (`research/client.ts` `remixArt`) and `addArtVersion` stay unchanged, because the route keeps that request and response.

1. In `route.ts` only, replace `openAiImage(buildArtPrompt(...))` with a call to the engine. The request body needs the stub's id and current version, so `remixArt` must start sending `stubId` and `currentVersionId` (a two-field change in `client.ts`; or the route can build a minimal stub from `body.event` and a fixed `stubId`).
2. Build the request: `toArtEditRequest(stub, {vibe, seed, first}, scope, {actionId})` returns `{request, unmapped}`. `scope` comes from the session (SERVER): `tenantId`/`projectId` from the account, `correlationId` per request, `actor` from `ts_session`.
3. Run `brief.create` once per stub (`toApiRequest("brief.create", toBriefCreatePayload(stub), scope)`) before the first `generate`.
4. POST the request to the engine. When it exists, the base URL goes in an env var (suggested `CREATIVE_ENGINE_URL`; not defined upstream yet), or in-process through `creative-engine/api/v1`'s handler factory if the VPS vendors it.
5. Convert the returned `DesignVersion` with `fromDesignVersion(dv, {edition, resolveSrc, vibe, seed})` and return that `ArtLayer` (`result.art`).
6. Keep the existing fallback (procedural, `provenance: "simulated"`) for any `unavailable`, `budget_unavailable` or network error, so the studio never blocks on the engine.

Then `fromDesignVersion` fixes the provenance rule (EVAL-03): a layer is `live` only when `billing_mode` is `live` and a real provider produced it.
