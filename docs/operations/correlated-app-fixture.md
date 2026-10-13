# Correlated available-app fixture

Run a new, bounded journey through the application's available adapters:

```sh
NEXT_TELEMETRY_DISABLED=1 npm run build
npm run verify:product -- --suite integration --mode fixture --evidence-dir out/integration-001
```

Use a new evidence directory for each attempt. The checker exclusively creates its receipt, first screenshot and native PNG: an existing artifact is never replaced. A production build from the clean current revision, the pinned Node/npm toolchain and Chrome are required. The dispatcher starts a disposable database/files root and a loopback-only server. It removes payment credentials for this suite, uses demo runtime and explicitly enables sandbox sign-in links. The browser retains the existing loopback restriction and disposable process/profile cleanup; no live email, paid request, supplier call or external publication is authorized or attempted.

## Three different commands

| Command | Scope |
| --- | --- |
| `--suite all --mode fixture` | Every declared independent leaf suite, currently 18, executed serially with each actual result retained. |
| `--suite integration --mode fixture` | A separate correlated journey using one newly created project, its actual revisions and the same account/order lineage. It is outside the leaf catalog; `all` does not silently include or replace it. |
| `verify:release` | The separately pinned canonical manifest/evidence consistency gate. A local journey is not an integration-evals Assembly or OwnerResponse. |

The integration receipt records `scope: available_app_adapters`, `acceptance: not_recorded`, and `canonicalAssembly: false`. A passing available-app journey does not close GT-10B, the release gate or a foreign consumer criterion. Required cases which fail, time out, are blocked by an earlier dependency, or are not run prevent a passing result. The checker retains a first failure even when a subsequent recovery succeeds.

The separate **Correlated available-app fixture** workflow runs the same 14-case command once after a fresh build and uploads its evidence even on failure. A case deadline closes the active page and marks all remaining required cases blocked; it cannot overlap another case or leave an incomplete plan green.

## What actually runs

The fixture submits a URL-shaped synthetic input containing the shipped Pale Hours demo keyword through the real intake form and `/api/research`. The route validates it and returns explicitly simulated facts. The named public page is not fetched. The app creates its own random project ID; the checker never injects a stub, a fabricated approval or a successful order into local storage.

That same project goes through an agent correction proposal, explicit Apply, a real app-demo art revision, comparison and selection of actual versions, sandbox email-link confirmation, actual account synchronization, and current server `print.compose` approval. The checker recomputes the selected input commitments from the server-held stub and source art instead of copying a claimed binding from the approval. It clicks the actual Download button and binds the resulting Blob digest to the current document/action/native GUID and saved bytes. It then uses the same project and attempt ID through sandbox checkout and authenticated order history.

The fixed negative/recovery cases are invalid intake; a delayed research response ignored after actual navigation unmount; duplicate approval; changed facts and composition making an approval stale; unavailable local capability preflight; lost response after a real sandbox order commit followed by same-attempt recovery/replay; and a real disposable session made expired in the fixture database followed by actual sign-in recovery. No missing case becomes a skip or a pass.

Response timing/loss and database expiry are **synthetic fault inputs**. The underlying application, HTTP routes, database, UI actions and native download are actual. The research cancellation case establishes only that the unmounted local work cannot create a project from its late result. Its upstream request completes; it is not a transport abort, generation Stop, or supplier cancellation. The original `fetch` Response is returned unchanged in the hold case. The order-loss control discards only the already observed HTTP response after the real server has answered, then checks actual reconciliation without choosing a favorable result.

## Authority and unimplemented joins

The approval signs design, source art, printed facts and composition **inputs**. It does not sign the exported PNG bytes. The current exporter does not consume the approval verifier, and `/api/orders` has no approval-token or ProductionBundle input. The receipt therefore records the linked approval/input/file observations without claiming an approved PNG hash or an enforced approval-to-order authority chain. The first display screenshot is retained as evidence; this suite does not substitute its screenshot for the separate download parity/cold matrix or claim a new pixel comparison.

The following remain explicit pending boundaries: the elected canonical private caller/EventIntelligencePackage, canonical Creative generation, ProductionBundle and Print consumer preflight, downstream approval use, accepted supplier SKU/spec/template/destination and order/status caller, generation/provider cancellation, canonical Assembly execution and accountable acceptance. Paid Creative adoption remains governed by the current owner scope; this checker does not turn a deferred expansion into an MVP prerequisite. A local capability refusal is not a canonical Print preflight. A sandbox order record is not a supplier order, charge or fulfillment confirmation.

No Editor/store, focus-hook, foreign SDK or production authority interface is changed by this checker. Actual defects exposed there remain with their current single writer. In particular, losing an HTTP response cannot establish that the server definitely refused the operation: the ambiguous-order case checks the current UI against actual persisted server state and retains a contradiction as a failure.

## Evidence and review

`integration/integration-evidence.json` contains the fixed case plan and every assertion, exact source/build identity, source/vendor hashes, safe project/version/approval/order references, state commitments, actual request status observations, current native download associations and final process/profile/collector cleanup. Tokens, cookies, raw sign-in URLs, addresses, request/response payloads and private error text are excluded; the transient in-page probe exports only fixed route names/status/counts. The dispatcher separately records the network-guard self-test and actual outbound-attempt count.

Focused helper controls are synthetic integrity tests, not application acceptance:

```sh
node --test tests/integration-evidence.test.mjs
```

They exercise missing/duplicate/failed cases, cleanup, cross-project and stale binding rejection, native file mismatch, payload privacy, response identity, held-response deadline, post-commit response loss, observer cleanup and the actual CLI's missing-prerequisite behavior. Qualify the new source with independent review and one bounded native journey on a fresh same-revision build. Preserve all earlier and new failed results; do not rerun unchanged source until it happens to pass.
