# `getticketstub.com` responsibility and boundaries

**Repository:** Public application source. **Accountable role:** Product and frontend. **Observed source:** [`main` at `138e4b9019c0f5a55ad5e3f586d129216b680e4d`](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/tree/138e4b9019c0f5a55ad5e3f586d129216b680e4d).

Acceptance and evidence are owned by the [master integration-evals checklist](https://github.com/Jevelopers-neatHack-2026/integration-evals/blob/main/planning/acceptance-checklist.md). This document describes repository ownership and architecture boundaries; it does not assign criterion state or accept integrations.

## Responsibility

Own the customer application, server-derived customer identity and authorization, app-side project/order records, customer-facing review and download flows, public API boundary, and the integration/release record when one is actually assembled. Keep approval of creative work distinct from purchase authorization. Keep a customer order's authority in this repository unless a later accepted decision assigns it elsewhere.

## Implemented areas in the current source

This is one Next.js App Router application rather than the complete multi-repository deployment plan. The public application origin is configured independently for each deployment with `APP_URL`; forwarded host headers do not establish trusted authority. The main code areas are:

- `src/app/`: customer pages, admin host route and HTTP route handlers under `src/app/api/`.
- `src/customer/`: customer screens and app-owned adapters for research, artwork, commerce, and navigation.
- `src/server/`: request parsing, cookies and sessions, context/capability derivation, SQLite-backed records, files, provider selection, and domain operations.
- `src/server/harness-export.ts` and the byte-pinned `src/server/vendor/agent-harness/`: optional product-event telemetry handoff and local durable outbox; this is not a general-purpose job worker and is off until explicitly configured.
- `public/brand/` and `src/brand/`: local brand asset/style files served or consumed by the app. The brand-kit repository has not published a versioned package for this app to consume.
- `tests/`, `scripts/`, and `.github/workflows/runtime.yml`: offline route/provider checks, product-suite checks and production smoke tooling.

The root page now renders the host-owned landing experience introduced in PR [#104](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/pull/104); it does not serve the separate `landing-page-repo` artifact. The admin route checks staff access and injects host context, but its rendered child is the local fixture mount. See the actual-state [architecture companion](CURRENT-STATE.md) and [route inventory](routes.md).

## Dependencies and handoff

`integration/repository-map.json` is dated planning inventory, explicitly not a dependency lockfile. `package.json` does not import the other product repositories as workspace packages. Most cross-repository shapes use local adapters or fixture copies. The specific exception is an opt-in product-event handoff to a byte-pinned, vendored subset of agent-harness; it is a real isolated telemetry path, not a general package assembly or worker service. The landing page, dashboard, brand-kit package, specialist services and finance ledger have not been assembled as one pinned runtime. Refer to [current architecture and integration state](CURRENT-STATE.md) for the source pins and exact distinction between copied shapes, fixtures, local consumers, and missing runtime connections.

Preserve the other repository's ownership of its provider, contract, product, or finance capability. An app-side adapter or test against fixtures does not transfer that ownership or establish owner acceptance. Use the [maintained shared-contract catalog](https://github.com/Jevelopers-neatHack-2026/shared-contracts/blob/main/docs/contract-catalog.md) and the central acceptance tracker for cross-repository agreement.

## Acceptance boundary

The cross-repository release needs evidence for at least these concerns:

- Customer and staff routes derive access from trusted server context and enforce the documented capabilities.
- Creative approval binds the reviewed design and artifacts; a separate purchase authorization binds the exact order terms.
- Customer order ownership and financial record ownership are explicit and not duplicated between repositories.
- A clean, pinned assembly identifies every selected source revision and reproduces its required checks.
- Landing and team-dashboard handoffs are agreed and tested in the real host before either is described as integrated.
- Evidence distinguishes fixtures, synthetic outputs, paid tests, production observations and live product behavior.
- Live payment, fulfillment, budget control and recovery satisfy their own authorization and operational criteria.

The [repository acceptance view](ACCEPTANCE.md) lists relevant master criterion IDs without keeping a second status tracker. Read API method/auth/payload boundaries in [HTTP API reference](../api/HTTP-API.md), runtime and deployment in [preview operations](../operations/preview-runtime.md), and the [central implementation plan](../planning/implementation-plan.md) for planned sequencing.

## Architecture sources

- [Current architecture and integration state](CURRENT-STATE.md): maintained, source-pinned view of actual implementation and cross-repository modes.
- [Architecture kit v1.0](../architecture-kit/v1.0/docs/architecture.md): immutable 2026-10-10 design intent, including proposed one-app/worker/PostgreSQL/object-storage topology.
- [Master acceptance checklist](https://github.com/Jevelopers-neatHack-2026/integration-evals/blob/main/planning/acceptance-checklist.md): authoritative criterion states and evidence.
- [Organization contribution guidance](https://github.com/Jevelopers-neatHack-2026/.github/blob/main/CONTRIBUTING.md): contributor process. Preserve local agent instructions and the applicable security policy.
