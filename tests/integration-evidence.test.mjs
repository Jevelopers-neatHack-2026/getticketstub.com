// Synthetic integrity controls for the actual checker helpers. No app/provider result.
import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { IntegrationEvidence, INTEGRATION_PLAN, approvalBindsSnapshot, approvalConsumerRequest, isStaleApprovalRejection, nativeFileBindsAction, integrationFetchProbe, evidenceIsSafe, sha256 } from "../scripts/lib/integration-evidence.mjs";

const stub = (id = "fixture-project") => ({ id, currentVersionId: "v2", versions: [{ id: "v1", art: { kind: "procedural", seed: 1 } }, { id: "v2", parentId: "v1", art: { kind: "procedural", seed: 2 } }], event: { facts: [] }, personal: { hiddenFields: [] }, material: "digital", finish: "matte", corrections: [] });
const passing = (ledger, id) => { ledger.begin(id); ledger.assert(id, "observed", true); ledger.finish(id); };

test("all fixed cases and confirmed cleanup qualify only available app evidence, never acceptance", () => {
  const ledger = new IntegrationEvidence();
  for (const id of INTEGRATION_PLAN) passing(ledger, id);
  const result = ledger.result({ complete: true });
  assert.equal(result.passed, true); assert.equal(result.complete, true);
  assert.equal(result.acceptance, "not_recorded"); assert.equal(result.canonicalAssembly, false);
  assert.ok(result.pendingJoins.includes("approval_consumed_by_download_or_order"));
});
test("missing, empty, failed and unfinished cases cannot qualify", () => {
  for (const disposition of ["missing", "empty", "failed", "unfinished"]) {
    const ledger = new IntegrationEvidence(["one", "two"]); passing(ledger, "one");
    if (disposition !== "missing") ledger.begin("two");
    if (disposition === "failed") ledger.assert("two", "actual_failure", false);
    if (["empty", "failed"].includes(disposition)) ledger.finish("two");
    assert.equal(ledger.result({ complete: true }).passed, false, disposition);
  }
});
test("a later passing assertion and another case do not erase the first failure", () => {
  const ledger = new IntegrationEvidence(["one", "two"]); ledger.begin("one");
  ledger.assert("one", "first_capture_failed", false); ledger.assert("one", "later_observation_passed", true); ledger.finish("one"); passing(ledger, "two");
  const result = ledger.result({ complete: true });
  assert.equal(result.cases[0].status, "failed"); assert.equal(result.cases[0].assertions[0].ok, false); assert.equal(result.passed, false);
});
test("duplicate or unknown cases and a second terminal remain integrity failures", () => {
  for (const duplicate of ["begin", "terminal", "unknown"]) {
    const ledger = new IntegrationEvidence(["one"]); passing(ledger, "one");
    assert.throws(() => duplicate === "terminal" ? ledger.finish("one") : ledger.begin(duplicate === "unknown" ? "two" : "one"));
    assert.equal(ledger.result({ complete: true }).passed, false);
  }
});
test("missing or failed cleanup invalidates passing local cases", () => {
  for (const cleanup of [null, {}, { complete: false }]) {
    const ledger = new IntegrationEvidence(["one"]); passing(ledger, "one");
    assert.equal(ledger.result(cleanup).passed, false);
  }
});
test("snapshots retain a single real project and selected version, and reject ambiguous history", () => {
  const ledger = new IntegrationEvidence(["one"]); const input = stub();
  const first = ledger.snapshot("initial", input);
  input.versions[1].art.seed = 9;
  assert.notEqual(first.stateSha256, ledger.snapshot("changed", input).stateSha256);
  assert.throws(() => ledger.snapshot("foreign", stub("another-project")), /cross_project/);
  passing(ledger, "one"); assert.equal(ledger.result({ complete: true }).passed, false);
  for (const bad of [{ ...stub(), currentVersionId: "absent" }, { ...stub(), versions: [stub().versions[0], stub().versions[0]] }]) {
    assert.throws(() => new IntegrationEvidence().snapshot("invalid", bad), /invalid_project/);
  }
});
test("approval identity must match the held project/version and independently computed inputs", () => {
  const snapshot = { projectId: "project", selectedVersionId: "v2" };
  const binding = { versionId: "v2", factsHash: "a".repeat(64) };
  const approval = { project: { kind: "stub", id: "project" }, binding, purpose: "print.compose", mode: "sandbox", notAuthorizes: ["purchase", "payment", "order", "asset_rights"] };
  assert.equal(approvalBindsSnapshot(approval, snapshot, binding), true);
  for (const changed of [
    { ...approval, project: { kind: "stub", id: "other" } }, { ...approval, binding: { ...binding, versionId: "v1" } },
    { ...approval, mode: "live" }, { ...approval, notAuthorizes: [] },
  ]) assert.equal(approvalBindsSnapshot(changed, snapshot, binding), false);
  assert.equal(approvalBindsSnapshot(approval, snapshot, { ...binding, factsHash: "b".repeat(64) }), false);
});
test("actual retained file bytes must match the one settled action and its document/native identity", () => {
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2]);
  const action = { id: "action", settled: true, controls: 1, producerIds: ["producer"], documentId: "doc", executionContextUniqueId: "ctx" };
  const receipt = { actionId: "action", documentId: "doc", executionContextUniqueId: "ctx", guid: "native-guid", bytes: bytes.length, sha256: sha256(bytes) };
  assert.equal(nativeFileBindsAction({ receipt }, action, bytes), true);
  for (const delta of [{ actionId: "prior-action" }, { documentId: "prior-doc" }, { executionContextUniqueId: "prior-context" }, { guid: "../file" }, { sha256: "0".repeat(64) }, { bytes: 1 }]) {
    assert.equal(nativeFileBindsAction({ receipt: { ...receipt, ...delta } }, action, bytes), false);
  }
  assert.equal(nativeFileBindsAction({ receipt }, { ...action, producerIds: ["p1", "p2"] }, bytes), false);
  assert.equal(nativeFileBindsAction({ receipt }, action, Buffer.from("not a PNG")), false);
});
test("consumer request uses the app HTTP project reference and only independently held content hashes", () => {
  const view = { token: "transient-fixture-token", approval: { tenant: { id: "acc_fixture" }, project: { kind: "stub", id: "real-project" } } };
  const binding = { designHash: "a".repeat(64), artHash: "b".repeat(64), factsHash: "c".repeat(64), compositionHash: "d".repeat(64), versionId: "not-a-wire-hash" };
  const request = approvalConsumerRequest(view, binding);
  assert.equal(request.expect.project, "stub:real-project"); assert.equal(request.expect.tenant, "acc_fixture");
  assert.equal(request.expect.purpose, "print.compose"); assert.deepEqual(Object.keys(request.expect.content), ["designHash", "artHash", "factsHash", "compositionHash"]);
  assert.equal(request.expect.content.factsHash, binding.factsHash);
  assert.equal(evidenceIsSafe(request), false, "a transient consumer token must never enter retained evidence");
  for (const changed of [{ ...view, token: "" }, { ...view, approval: { ...view.approval, project: { kind: "other", id: "real-project" } } }]) {
    assert.throws(() => approvalConsumerRequest(changed, binding), /invalid_consumer_input/);
  }
  assert.throws(() => approvalConsumerRequest(view, { ...binding, factsHash: undefined }), /invalid_consumer_input/);
});
test("only the actual port's typed 403 stale/content mismatch response qualifies", () => {
  const denied = { status: 403, json: { ok: false, reason: "stale", error: { code: "approval_invalid" } } };
  assert.equal(isStaleApprovalRejection(denied), true);
  assert.equal(isStaleApprovalRejection({ ...denied, json: { ...denied.json, reason: "content_mismatch" } }), true);
  for (const changed of [{ ...denied, status: 400 }, { ...denied, status: 200 },
    { ...denied, json: { ...denied.json, ok: true } }, { ...denied, json: { ...denied.json, reason: "forged" } },
    { ...denied, json: { ...denied.json, error: { code: "bad_request" } } }]) assert.equal(isStaleApprovalRejection(changed), false);
});
test("private payloads and unsafe errors are refused before entering evidence", () => {
  for (const value of [{ token: "opaque" }, { email: "fixture@example.com" }, { url: "https://host/?token=opaque" }, { error: "Bearer credential" }, { bytes: "data:image/png;base64,AAAA" }, { x: Infinity }]) {
    assert.equal(evidenceIsSafe(value), false);
    const ledger = new IntegrationEvidence(["one"]); ledger.begin("one"); ledger.assert("one", "safe", true, value); ledger.finish("one");
    const result = ledger.result({ complete: true }); assert.equal(result.passed, false);
    assert.deepEqual(result.cases[0].assertions[0].evidence, { code: "unsafe_evidence_refused" });
  }
});
test("retained evidence does not change when caller input or a sealed ledger is mutated", () => {
  const ledger = new IntegrationEvidence(["one"]); const details = { count: 1 };
  ledger.begin("one"); ledger.assert("one", "observed", true, details); details.count = 2; ledger.finish("one");
  const result = ledger.result({ complete: true });
  assert.throws(() => ledger.assert("one", "late", false));
  assert.equal(result.cases[0].assertions[0].evidence.count, 1); assert.equal(result.passed, true);
});

function probeWith(fetch, timers = {}) {
  const context = { fetch, URL, location: { href: "http://127.0.0.1:4000/make", origin: "http://127.0.0.1:4000" }, setTimeout, clearTimeout, ...timers };
  runInNewContext(`(${integrationFetchProbe.toString()})()`, context);
  return { context, probe: context.__ticketstubIntegrationFixture };
}
const yieldTask = () => new Promise((done) => setImmediate(done));
test("the actual probe makes one original request and returns the original Response unchanged", async () => {
  const response = Response.json({ event: { fixture: true } }); const calls = [];
  const original = async (...args) => { calls.push(args); return response; };
  const { context, probe } = probeWith(original); const init = { method: "POST", body: JSON.stringify({ url: "synthetic" }) };
  assert.equal(await context.fetch("/api/research", init), response); assert.equal(calls.length, 1); assert.equal(calls[0][1], init);
  const summary = await probe.summary(); assert.equal(summary.records[0].status, 200); assert.equal(summary.records[0].returned, true);
  probe.restore(); assert.equal(context.fetch, original);
});
test("a held late research response is actual completed HTTP; release preserves its bytes and is single-use", async () => {
  const response = Response.json({ event: { fixture: true } }); let requests = 0, returned = false;
  const { context, probe } = probeWith(async () => { requests++; return response; });
  probe.arm("/api/research", "hold");
  const result = context.fetch("/api/research", { method: "POST" }).then((value) => { returned = true; return value; });
  await yieldTask(); await probe.summary();
  assert.equal(probe.fault().state, "held"); assert.equal(returned, false); assert.equal(requests, 1);
  probe.release(); assert.equal(await result, response); assert.equal(probe.fault().state, "released");
  assert.throws(() => probe.release(), /no_held_response/); probe.restore();
});
test("the ambiguous-order fault loses only an observed actual response after the server result", async () => {
  let committed = false;
  const { context, probe } = probeWith(async () => { committed = true; return Response.json({ order: { id: "sandbox-order", mode: "sandbox" } }); });
  probe.arm("/api/orders", "drop");
  await assert.rejects(context.fetch("/api/orders", { method: "POST" }), /response loss/);
  assert.equal(committed, true); assert.equal(probe.fault().state, "dropped");
  const summary = await probe.summary(); assert.equal(summary.records[0].responseObserved, true); assert.equal(summary.records[0].returned, false);
  assert.equal(probe.raw(1).response.order.id, "sandbox-order"); probe.restore();
});
test("authentication payloads remain transient and never enter the probe summary", async () => {
  const canary = "private-fixture-token-canary";
  const { context, probe } = probeWith(async () => Response.json({ devLink: `http://127.0.0.1:4000/signin?token=${canary}` }));
  await context.fetch("/api/auth/link", { method: "POST", body: JSON.stringify({ email: "fixture@example.com" }) });
  const summary = await probe.summary(); assert.equal(JSON.stringify(summary).includes(canary), false); assert.equal(JSON.stringify(summary).includes("fixture@example.com"), false);
  assert.equal(evidenceIsSafe(JSON.parse(JSON.stringify(summary))), true); probe.restore();
});
test("probe capacity and an expired hold stay visible, with no successful fault re-arm", async () => {
  let expire; const { context, probe } = probeWith(async () => Response.json({ event: {} }), { setTimeout: (fn) => { expire = fn; return 1; }, clearTimeout: () => {} });
  probe.arm("/api/research", "hold"); const pending = context.fetch("/api/research", { method: "POST" });
  await yieldTask(); await probe.summary(); expire(); await pending;
  assert.ok((await probe.summary()).faults.includes("hold_deadline")); assert.throws(() => probe.arm("/api/orders", "drop"), /invalid_fault_plan/);
  for (let i = 0; i < 256; i++) await context.fetch("/api/auth/me");
  assert.ok((await probe.summary()).faults.includes("request_limit")); probe.restore();
});
test("restoring the probe releases a held result and restores the exact original fetch", async () => {
  const original = async () => Response.json({ event: {} }); const { context, probe } = probeWith(original);
  probe.arm("/api/research", "hold"); const pending = context.fetch("/api/research", { method: "POST" });
  await yieldTask(); await probe.summary(); probe.restore(); await pending; assert.equal(context.fetch, original);
});
test("the actual dispatcher recognizes integration and fails named missing prerequisites before any browser", () => {
  const temp = mkdtempSync(join(tmpdir(), "ticketstub-integration-cli-"));
  try {
    mkdirSync(join(temp, "scripts/lib"), { recursive: true });
    copyFileSync(new URL("../scripts/verify-product.mjs", import.meta.url), join(temp, "scripts/verify-product.mjs"));
    copyFileSync(new URL("../scripts/lib/check-result.mjs", import.meta.url), join(temp, "scripts/lib/check-result.mjs"));
    const evidence = join(temp, "evidence");
    const result = spawnSync(process.execPath, [join(temp, "scripts/verify-product.mjs"), "--suite", "integration", "--mode", "fixture", "--evidence-dir", evidence], { encoding: "utf8", timeout: 10_000 });
    assert.equal(result.status, 1, result.stderr); assert.match(result.stdout, /required files and build present/); assert.doesNotMatch(result.stderr, /unknown suite/);
    const receipt = JSON.parse(readFileSync(join(evidence, readdirSync(evidence)[0]), "utf8"));
    assert.equal(receipt.suite, "integration"); assert.equal(receipt.exitCode, 1); assert.equal(receipt.counts.failed, 1); assert.equal(receipt.counts.passed, 0);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
