// A newly executed, correlated journey through available app adapters. No archived
// leaf evidence, synthetic project injection, provider caller or canonical ACK.
// Run only through verify:product --suite integration --mode fixture.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { bindStub, artRefHash } from "../src/server/approval-token.ts";
import { DownloadBrowserSessions } from "./lib/download-browser-sessions.mjs";
import { clickVisibleButton } from "./lib/visible-pointer.mjs";
import { submitSheetEmail } from "./lib/analytics-sheet-readiness.mjs";
import { IntegrationEvidence, INTEGRATION_PLAN, approvalBindsSnapshot, nativeFileBindsAction, integrationFetchProbe, evidenceIsSafe, objectHash, sha256 } from "./lib/integration-evidence.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const base = process.argv[2];
const output = process.argv[3] && resolve(process.argv[3]);
const DB = process.env.TICKETSTUB_DB;
const fixtureUrl = "https://ticketstub.example.invalid/pale-hours";
const ledger = new IntegrationEvidence();
const notes = { scope: "available_app_adapters", acceptance: "not_recorded", providers: "not_configured",
  inputs: "synthetic_shipped_demo_facts_and_sample_art", timingFaults: "explicit_response_hold_and_loss",
  cancellation: "local_research_result_ownership_only_upstream_not_canceled",
  approvalLimit: "input_commitments_not_exported_png_authority", orderLimit: "sandbox_records_do_not_consume_approval_or_production_bundle",
  screenshots: "first_retained_frame_only_no_pixel_comparison_claim", account: "disposable_fixture_account", requiredCases: INTEGRATION_PLAN.length };
const supplemental = { notes, documents: [], pointerActions: [], artifacts: [], approvalBindings: [], errors: [] };
const state = {};
let page, browser, receipts, manager, documentOrdinal = 0, passed = 0, failed = 0, currentCase = null, executionStopped = false;
const completed = new Set();
let blockedBrowserRequests = 0, stopNetworkObservation;
const SAFE_CODES = new Set(["case_deadline", "page_predicate_failed", "native_click_not_received", "field_unavailable", "missing_local_project",
  "missing_server_project", "missing_observed_response", "cross_project_snapshot", "invalid_project_snapshot", "no_signin_link", "signin_failed",
  "invalid_art_reference", "art_file_unavailable", "database_fixture_unavailable", "browser_setup_failed", "unexpected_exception"]);
const codeOf = (error) => SAFE_CODES.has(error?.message) ? error.message : "unexpected_exception";
const deadline = async (operation, ms = 45_000) => {
  let timer;
  try { return await Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("case_deadline")), ms); })]); }
  finally { clearTimeout(timer); }
};
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(read, predicate, ms = 12_000) {
  const end = performance.now() + ms;
  while (performance.now() < end) { const value = await deadline(read, Math.max(1, end - performance.now())); if (predicate(value)) return value; await pause(50); }
  throw new Error("page_predicate_failed");
}
function check(name, ok, detail = {}) {
  const accepted = ledger.assert(currentCase, name, ok, detail);
  if (accepted) passed++; else failed++;
  console.log(`${accepted ? "ok  " : "FAIL"} integration/${currentCase}/${name}`);
  return accepted;
}
function requireCheck(name, ok, detail = {}) { if (!check(name, ok, detail)) throw new Error("page_predicate_failed"); }
async function runCase(id, dependencies, operation) {
  // A timed-out async operation must not overlap another case on the same page.
  // Stop its browser target and retain every remaining required case as blocked.
  if (executionStopped) {
    ledger.blocked(id, "prior_case_deadline"); failed++;
    console.log(`FAIL integration/${id}/prior_case_deadline`); return;
  }
  if (dependencies.some((dependency) => !completed.has(dependency))) {
    ledger.blocked(id, dependencies.find((dependency) => !completed.has(dependency)));
    failed++; console.log(`FAIL integration/${id}/dependency_available`); return;
  }
  currentCase = id; ledger.begin(id);
  try { await deadline(operation, 70_000); ledger.finish(id); completed.add(id); }
  catch (error) {
    const code = codeOf(error);
    if (code === "case_deadline") {
      executionStopped = true;
      if (page) await deadline(() => page.close(), 2000).catch(() => {});
    }
    ledger.assert(id, "case_completed", false, { code }); failed++;
    console.log(`FAIL integration/${id}/case_completed ${code}`); ledger.finish(id, code);
  }
  finally { currentCase = null; }
}
async function wait(expression, ms = 12_000) {
  if (!await page.waitFor(expression, ms)) throw new Error("page_predicate_failed");
}
async function tap(text, scope = "body") {
  const receipt = await clickVisibleButton(page, { text, scope });
  supplemental.pointerActions.push({ case: currentCase, text, scope, ...receipt });
  if (!receipt.clicked) throw new Error("native_click_not_received");
}
async function fill(selector, value) {
  if (!await page.eval(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e || e.disabled) return false; e.focus(); e.select(); return document.activeElement === e; })()`)) throw new Error("field_unavailable");
  await page.type(value);
}
async function activateNavigation(selector) {
  const key = `integration-nav-${randomUUID()}`;
  let trusted = 0;
  await page.send("Runtime.addBinding", { name: "__integrationNavigationReceipt" });
  const off = browser.conn.on((event) => {
    if (event.sessionId === page.sid && event.method === "Runtime.bindingCalled" && event.params.name === "__integrationNavigationReceipt" && event.params.payload === key) trusted++;
  });
  try {
    const focused = await page.eval(`(() => {
      const nodes=[...document.querySelectorAll(${JSON.stringify(selector)})].filter(e=>e.offsetParent && !e.disabled && !e.closest('[inert]'));
      if(nodes.length!==1)return false;
      const node=nodes[0]; node.focus();
      const listener=event=>{ if(event.isTrusted && event.composedPath().includes(node)) __integrationNavigationReceipt(${JSON.stringify(key)}); };
      node.addEventListener('click',listener,{capture:true,once:true});
      globalThis.__integrationNavigationCleanup=()=>node.removeEventListener('click',listener,true);
      return document.activeElement===node;
    })()`);
    if (!focused) throw new Error("field_unavailable");
    await page.key("Enter");
    await until(async () => trusted, (count) => count === 1, 2000);
    supplemental.pointerActions.push({ case: currentCase, action: "native_navigation_activation", trustedActivations: trusted });
  } finally {
    off(); await deadline(() => page.eval("globalThis.__integrationNavigationCleanup?.()"), 1000).catch(() => {});
  }
}
async function flushDocument() {
  if (!page) return;
  const summary = await page.eval("globalThis.__ticketstubIntegrationFixture?.summary() ?? null");
  if (summary) supplemental.documents.push({ ordinal: documentOrdinal, ...summary });
}
async function navigate(path) {
  await flushDocument();
  await page.goto(new URL(path, base).href, { settle: 0 });
  documentOrdinal++;
  await wait("!!globalThis.__ticketstubIntegrationFixture");
}
const localWall = () => page.eval('JSON.parse(localStorage.getItem("ticketstub.wall.v1") || "[]")');
async function localStub() {
  const wall = await localWall();
  const stub = wall.find((item) => item?.id === state.stubId);
  if (!stub) throw new Error("missing_local_project");
  return stub;
}
const snapshot = async (label) => ledger.snapshot(label, await localStub());
function withDb(operation, writable = false) {
  if (!DB || basename(DB) !== "verify.sqlite" || !basename(dirname(DB)).startsWith("ticketstub-verify-")
    || lstatSync(DB).isSymbolicLink() || realpathSync(DB) !== resolve(DB)) throw new Error("database_fixture_unavailable");
  const db = new DatabaseSync(DB, { readOnly: !writable });
  try { return operation(db); } finally { db.close(); }
}
function serverStub() {
  const row = withDb((db) => db.prepare("SELECT data FROM wall_stubs WHERE account_id=? AND stub_id=? AND deleted=0").get(state.accountId, state.stubId));
  if (!row) throw new Error("missing_server_project");
  return JSON.parse(row.data);
}
async function synced() {
  const local = await localStub();
  const remote = await until(() => {
    try { return serverStub(); } catch { return null; }
  }, (stub) => stub?.currentVersionId === local.currentVersionId && stub.event.dateISO === local.event.dateISO
    && stub.material === local.material && stub.finish === local.finish && objectHash(stub.personal) === objectHash(local.personal), 15_000);
  return remote;
}
async function api(method, path, body) {
  return page.eval(`fetch(${JSON.stringify(path)}, {method:${JSON.stringify(method)}, headers:{"content-type":"application/json"}, ${body === undefined ? "" : `body:JSON.stringify(${JSON.stringify(body)}),`} signal:AbortSignal.timeout(10000)}).then(async r=>({status:r.status,json:await r.json()}))`);
}
async function observed(route, method = "POST", minimumId = 0) {
  const summary = await until(() => page.eval("__ticketstubIntegrationFixture.summary()"),
    (s) => s.records.some((r) => r.route === route && r.method === method && r.id > minimumId && r.responseObserved));
  const row = summary.records.filter((r) => r.route === route && r.method === method && r.id > minimumId && r.responseObserved).at(-1);
  const raw = await page.eval(`__ticketstubIntegrationFixture.raw(${row.id})`);
  if (!raw?.response) throw new Error("missing_observed_response");
  return { row, ...raw };
}
async function say(text) { await fill('[role="dialog"] form input', text); await tap("Send", '[role="dialog"]'); }
async function agent() { await tap("Ask"); await wait('!!document.querySelector(\'[role="dialog"] form input\')'); }
async function dismissDialog() { await page.key("Escape"); await wait('!document.querySelector(\'[role="dialog"]\')'); }
async function versions() {
  if (!await page.eval('!!document.querySelector(\'[role="region"][aria-label="Versions"]:not([inert])\')')) await tap("Versions");
  await wait('!!document.querySelector(\'[aria-label="Design versions, newest first"]\')');
}
async function signIn() {
  await navigate("/wall");
  await wait('[...document.querySelectorAll("button")].some(b => ["Save to your wall", "Save your wall"].includes(b.textContent.trim()))');
  const saveText = await page.eval('[...document.querySelectorAll("button")].find(b=>["Save to your wall","Save your wall"].includes(b.textContent.trim()) && b.offsetParent)?.textContent.trim()');
  await tap(saveText);
  const result = await submitSheetEmail(page, state.email);
  supplemental.pointerActions.push({ case: currentCase, action: "sign_in_submit", ...result });
  if (!result.ok) throw new Error("signin_failed");
  await wait('[...document.querySelectorAll(\'[role="dialog"] a\')].some(a=>a.textContent.includes("Open the link"))');
  const href = await page.eval('[...document.querySelectorAll(\'[role="dialog"] a\')].find(a=>a.textContent.includes("Open the link")).href');
  if (new URL(href).origin !== base) throw new Error("no_signin_link");
  // The fixture link is used transiently; no URL, address, cookie or token is retained.
  await navigate(href);
  await wait('!!document.querySelector(\'form[action="/api/auth/confirm"] button\')');
  await activateNavigation('form[action="/api/auth/confirm"] button');
  await wait('location.pathname === "/wall"');
  documentOrdinal++;
  const me = await api("GET", "/api/auth/me");
  if (me.status !== 200 || !me.json.account?.id || me.json.account.email !== state.email) throw new Error("signin_failed");
  state.accountId = me.json.account.id;
  await synced();
  return me.json.account;
}
function computedBinding(stub) {
  const version = stub.versions.find((item) => item.id === stub.currentVersionId);
  if (!version) throw new Error("invalid_art_reference");
  const file = /^\/api\/files\/([a-f0-9]{64}\.(?:png|jpg|webp))$/.exec(version.art.src ?? "");
  let art = { hash: artRefHash(version.art), source: "ref" };
  if (file) {
    const path = join(process.env.TICKETSTUB_FILES, file[1]);
    if (!existsSync(path) || lstatSync(path).isSymbolicLink()) throw new Error("art_file_unavailable");
    art = { hash: sha256(readFileSync(path)), source: "bytes" };
  }
  return bindStub(stub, stub.material === "digital" ? "file" : stub.material === "framed" ? "framed" : "classic", art);
}
async function approveCurrent(label) {
  await versions(); await wait('[...document.querySelectorAll("button")].some(b=>b.textContent.trim()==="Approve for print" && !b.disabled)');
  const before = await snapshot(`${label}_before`);
  const remote = await synced();
  const selectedDisplay = await page.eval('document.querySelector(\'section[aria-label="Selected version"]\')?.innerText.match(/#[a-f0-9]{6}\\b/)?.[0] ?? null');
  await tap("Approve for print", '[role="region"][aria-label="Versions"]');
  await wait('[...document.querySelectorAll(\'[role="dialog"] button\')].some(b=>b.textContent.trim()==="Approve this version" && !b.disabled)');
  const review = await page.eval('document.querySelector(\'[role="dialog"]\')?.innerText ?? ""');
  requireCheck(`${label}_review_names_current_version`, !!selectedDisplay && review.includes(`Approving covers version ${selectedDisplay}`) && review.includes("not an order"),
    { displayedVersion: selectedDisplay, selectedVersionId: before.selectedVersionId });
  await tap("Approve this version", '[role="dialog"]');
  await wait('!!document.querySelector("[data-approved=true]")');
  const response = await observed("/api/approvals");
  const binding = computedBinding(remote);
  requireCheck(`${label}_server_input_binding`, response.row.status === 200 && approvalBindsSnapshot(response.response.approval, before, binding)
    && response.response.approval.actor?.kind === "account" && response.response.approval.actor.id === state.accountId);
  supplemental.approvalBindings.push({ label, approvalId: response.response.approval.id, projectId: state.stubId,
    actorId: state.accountId, selectedVersionId: before.selectedVersionId, inputBinding: binding, status: response.response.status,
    mode: response.response.approval.mode, exportedPngAuthority: false });
  return response.response;
}
async function verifyToken(view, content) {
  return api("POST", "/api/approvals/verify", { token: view.token, expect: { tenant: view.approval.tenant.id,
    project: view.approval.project, purpose: "print.compose", content } });
}
function screenshotRecord(name, bytes) {
  const path = join(output, name); writeFileSync(path, bytes, { flag: "wx" });
  supplemental.artifacts.push({ file: name, bytes: bytes.length, sha256: sha256(bytes), mode: "first_capture_retained" });
}
function sanitizeSessions(value) {
  // Collector URLs are Blob identifiers, but hash them anyway; raw paths, error messages
  // and suggested filenames are unnecessary for the project/action/digest proof.
  if (Array.isArray(value)) return value.map(sanitizeSessions);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
    if (["url", "filename", "suggestedFilename", "message"].includes(key)) return [[`${key}Sha256`, sha256(String(item))]];
    if (key === "directory") return [[key, relative(output, item)]];
    return [[key, sanitizeSessions(item)]];
  }));
  return value;
}

let cleanup = { complete: false, browser: "not_started" };
try {
  if (!base || !/^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(base) || !output
    || process.env.TICKETSTUB_INTEGRATION_FIXTURE !== "1" || process.env.TICKETSTUB_SANDBOX_MAIL !== "1"
    || process.env.TICKETSTUB_RUNTIME_MODE !== "demo" || !process.env.VERIFY_NET_LOG
    || ["DODO_PAYMENTS_API_KEY", "DODO_PAYMENTS_WEBHOOK_KEY", "DODO_PAYMENTS_PRODUCT_ID", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "RESEND_API_KEY"].some((key) => process.env[key])) {
    throw new Error("database_fixture_unavailable");
  }
  mkdirSync(output, { recursive: true });
  supplemental.source = { checkerCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    tree: execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: root, encoding: "utf8" }).trim(),
    dirty: execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim() !== "",
    buildId: readFileSync(join(root, ".next/BUILD_ID"), "utf8").trim(), node: process.version,
    files: Object.fromEntries(["package-lock.json", "scripts/check-integration.mjs", "scripts/lib/integration-evidence.mjs", "src/customer/studio/fixtures.ts", "src/server/approval-token.ts",
      "src/app/api/orders/route.ts", "src/server/vendor/creative-engine/MANIFEST.json", "src/server/vendor/agent-harness/MANIFEST.json",
      "src/server/vendor/cost-intelligence/MANIFEST.json", "src/server/vendor/fulfillment-connectors/MANIFEST.json"].map((path) => [path, sha256(readFileSync(join(root, path)))])) };
  const health = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(5000) }).then((r) => r.json());
  supplemental.runtime = { mode: health.mode, storage: health.storage, commit: health.commit };
  if (health.mode !== "demo" || health.storage !== "ok" || supplemental.source.dirty || health.commit !== supplemental.source.checkerCommit) throw new Error("database_fixture_unavailable");
  manager = new DownloadBrowserSessions(output, [{ trial: 0, viewport: { name: "integration" } }]);
  ({ browser, receipts } = await manager.open("baseline"));
  stopNetworkObservation = browser.conn.on((event) => {
    if (event.method !== "Network.requestWillBeSent") return;
    try { const url = new URL(event.params.request.url); if (["http:", "https:"].includes(url.protocol) && url.origin !== base) blockedBrowserRequests++; }
    catch { blockedBrowserRequests++; }
  });
  page = await browser.newPage({ width: 1440, height: 1000, reducedMotion: true, mobile: false });
  await receipts.install(page);
  await page.send("Page.addScriptToEvaluateOnNewDocument", { source: `(${integrationFetchProbe.toString()})()` });
  state.email = `integration-${randomUUID()}@example.com`;

  await runCase("invalid_intake", [], async () => {
    await navigate(`/new?url=${encodeURIComponent("javascript:invalid-fixture")}`);
    await wait('document.body.innerText.includes("read that link")');
    const seen = await observed("/api/research");
    check("typed_route_rejection", seen.row.status >= 400 && seen.response.error?.code === "unsupported_url", { status: seen.row.status, code: seen.response.error?.code ?? "missing" });
    check("no_project_created", (await localWall()).length === 0);
  });
  await runCase("late_research_ignored", [], async () => {
    await navigate("/make");
    await wait('!!document.querySelector(\'input[inputmode="url"]\')');
    await page.eval('__ticketstubIntegrationFixture.arm("/api/research", "hold")');
    await fill('input[inputmode="url"]', fixtureUrl); await tap("Make my stub");
    await wait('__ticketstubIntegrationFixture.fault()?.state === "held"');
    check("actual_response_held_before_project_creation", (await localWall()).length === 0 && await page.eval('!!document.querySelector("[data-receipt]")'));
    // Follow an existing Next Link using a trusted keyboard activation. Keep this
    // document alive so Printing's actual cleanup guard, not a destroyed page, is tested.
    await activateNavigation('a[href="/wall"]');
    await wait('location.pathname === "/wall" && !document.querySelector("[data-receipt]")');
    requireCheck("held_request_survives_spa_unmount", await page.eval('__ticketstubIntegrationFixture.fault()?.state === "held"'));
    await page.eval('__ticketstubIntegrationFixture.release()');
    const seen = await observed("/api/research");
    await until(() => page.eval('__ticketstubIntegrationFixture.summary()'), (summary) => summary.records.some((row) => row.route === "/api/research" && row.returned));
    // One complete browser task after the returned response and its promise jobs.
    await page.eval('new Promise(resolve=>setTimeout(resolve,0))');
    check("late_actual_response_ignored_after_navigation", seen.row.status === 200 && (await localWall()).length === 0 && await page.eval('location.pathname === "/wall"'));
    check("upstream_completed_not_canceled", seen.row.responseObserved === true, { localOwnershipCanceled: true, upstreamRequestCanceled: false, status: seen.row.status });
  });
  await runCase("url_intake", [], async () => {
    await navigate("/make"); await wait('!!document.querySelector(\'input[inputmode="url"]\')');
    await fill('input[inputmode="url"]', fixtureUrl); await tap("Make my stub");
    await wait('location.pathname.startsWith("/studio/")', 40_000);
    state.stubId = await page.eval('location.pathname.split("/").at(-1)');
    const seen = await observed("/api/research");
    const stub = await localStub(); state.initial = ledger.snapshot("intake", stub);
    requireCheck("same_real_url_request_created_one_project", seen.row.status === 200 && seen.request?.url === fixtureUrl && (await localWall()).length === 1 && !state.stubId.startsWith("demo-"));
    check("research_is_labeled_simulated", stub.event.facts.length > 0 && stub.event.facts.every((fact) => ["simulated", "pending"].includes(fact.provenance)), { inputSha256: sha256(fixtureUrl), factCount: stub.event.facts.length });
  });
  await runCase("correction_apply", ["url_intake"], async () => {
    await agent(); await say("Fix the date to 11 Oct 2024");
    await wait('/Set the date to 11 Oct 2024/.test(document.querySelector(\'[role="dialog"]\')?.innerText ?? "")');
    const proposed = await snapshot("correction_proposed");
    check("proposal_preserves_current_state", proposed.stateSha256 === state.initial.stateSha256);
    await tap("Apply", '[role="dialog"]');
    await wait('/Done: date set to 11 Oct 2024/.test(document.querySelector(\'[role="dialog"]\')?.innerText ?? "")');
    state.corrected = await snapshot("correction_applied");
    requireCheck("actual_apply_records_same_project_correction", (await localStub()).event.dateISO === "2024-10-11" && state.corrected.corrections === state.initial.corrections + 1);
    check("applied_action_is_not_available_again", await page.eval('(() => { const rows=[...document.querySelectorAll(\'[role="dialog"] li[data-status="applied"]\')]; return rows.length===1 && rows.every(row=>[...row.querySelectorAll("button")].every(b=>b.disabled || b.textContent.trim()!=="Apply")); })()'));
  });
  await runCase("revision_compare_select", ["correction_apply"], async () => {
    await say("Switch to letterpress and remix the art");
    await wait('/Apply all 2/.test(document.querySelector(\'[role="dialog"]\')?.innerText ?? "")');
    await tap("Apply all", '[role="dialog"]');
    await wait('/style switched to Letterpress; art remixed/.test(document.querySelector(\'[role="dialog"]\')?.innerText ?? "")');
    const revised = await snapshot("revision_created");
    requireCheck("actual_art_adapter_created_linked_versions", revised.versions.length >= state.corrected.versions.length + 2 && (await observed("/api/art")).row.status === 200);
    check("earlier_correction_preserved", revised.corrections === state.corrected.corrections && (await localStub()).event.dateISO === "2024-10-11");
    await dismissDialog(); await versions();
    await tap("Compare", '[aria-label="Design versions, newest first"] li:nth-child(1)');
    await tap("Compare", '[aria-label="Design versions, newest first"] li:nth-child(2)');
    requireCheck("two_actual_versions_compared", await page.waitFor('!!document.querySelector(\'section[aria-label^="Comparing "]\')'));
    const before = await localStub();
    const selected = before.versions.find((v) => v.id === before.currentVersionId);
    requireCheck("selected_version_has_actual_parent", !!selected?.parentId && before.versions.some((v) => v.id === selected.parentId));
    await tap("Select", '[aria-label="Design versions, newest first"] li:nth-child(2)');
    await wait(`JSON.parse(localStorage.getItem("ticketstub.wall.v1")).find(s=>s.id===${JSON.stringify(state.stubId)}).currentVersionId !== ${JSON.stringify(before.currentVersionId)}`);
    const restored = await snapshot("version_selected");
    check("selection_keeps_all_version_bytes", restored.versionsSha256 === revised.versionsSha256 && restored.selectedVersionId !== revised.selectedVersionId);
  });
  await runCase("account_sync", ["revision_compare_select"], async () => {
    await signIn(); const remote = await synced(); const local = await localStub();
    requireCheck("actual_account_sync_retains_same_project_and_version", remote.id === state.stubId && remote.currentVersionId === local.currentVersionId);
    check("server_sync_keeps_correction_and_history", remote.event.dateISO === "2024-10-11" && remote.versions.length === local.versions.length && (remote.corrections ?? []).length === (local.corrections ?? []).length);
    ledger.snapshot("server_synced", remote);
    await navigate(`/studio/${state.stubId}`); await wait('!!document.querySelector("figure[data-edition]")');
  });
  await runCase("current_approval", ["account_sync"], async () => { state.firstApproval = await approveCurrent("initial_approval"); });
  await runCase("duplicate_approval", ["current_approval"], async () => {
    const current = await localStub();
    const repeated = await api("POST", "/api/approvals", { stubId: state.stubId, purpose: "print.compose", expectedVersionId: current.currentVersionId });
    check("identical_request_is_idempotent", repeated.status === 200 && repeated.json.created === false && repeated.json.approval.id === state.firstApproval.approval.id);
    const history = await api("GET", `/api/approvals?project=stub:${state.stubId}`);
    check("one_current_approval_record", history.status === 200 && history.json.approvals.length === 1);
  });
  await runCase("changed_content", ["current_approval"], async () => {
    await agent(); await say("Fix the date to 12 Oct 2024");
    await wait('/Set the date to 12 Oct 2024/.test(document.querySelector(\'[role="dialog"]\')?.innerText ?? "")');
    await tap("Apply", '[role="dialog"]'); await wait('/Done: date set to 12 Oct 2024/.test(document.querySelector(\'[role="dialog"]\')?.innerText ?? "")');
    await dismissDialog();
    await tap("Digital", '[role="region"][aria-label="Material & finish"]');
    await until(localStub, (stub) => stub.material === "digital" && stub.event.dateISO === "2024-10-12");
    await synced(); const changed = await snapshot("facts_and_composition_changed");
    const history = await api("GET", `/api/approvals?project=stub:${state.stubId}`);
    check("prior_approval_is_stale_after_real_edits", history.json.approvals.find((v) => v.approval.id === state.firstApproval.approval.id)?.status === "stale");
    const binding = computedBinding(serverStub());
    const denied = await verifyToken(state.firstApproval, binding);
    check("consumer_rejects_stale_approval", denied.status === 200 && denied.json.ok === false && ["stale", "content_mismatch"].includes(denied.json.reason));
    check("both_bound_content_groups_changed", changed.factsSha256 !== state.corrected.factsSha256 && binding.factsHash !== state.firstApproval.approval.binding.factsHash && binding.compositionHash !== state.firstApproval.approval.binding.compositionHash);
    state.approval = await approveCurrent("updated_approval");
  });
  await runCase("native_download", ["changed_content"], async () => {
    const before = await snapshot("before_download");
    // One first screen, retained exclusively. No pixel-match claim or replacement frame.
    const capture = await page.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    screenshotRecord("integration-first-screen.png", Buffer.from(capture.data, "base64"));
    const action = await receipts.arm(page, "front", "correlated_selected_version");
    await tap("Download PNG", "[data-download-root]");
    const file = await receipts.download(action);
    requireCheck("current_action_blob_matches_actual_native_file", nativeFileBindsAction(file, action, file.buf));
    writeFileSync(join(output, "integration-current-action.png"), file.buf, { flag: "wx" });
    const after = await snapshot("after_download");
    check("download_uses_unchanged_selected_input", before.stateSha256 === after.stateSha256 && state.approval.approval.binding.versionId === after.selectedVersionId);
    supplemental.artifacts.push({ file: "integration-current-action.png", bytes: file.buf.length, sha256: sha256(file.buf),
      projectId: state.stubId, selectedVersionId: before.selectedVersionId, approvalId: state.approval.approval.id,
      actionId: action.id, documentId: action.documentId, guid: file.receipt.guid, bindingConsumedByExporter: false });
  });
  await runCase("failed_local_preflight", ["account_sync"], async () => {
    const before = await api("GET", "/api/orders");
    const rejected = await api("POST", "/api/orders", { attemptId: randomUUID().replaceAll("-", ""), order: { stubIds: [state.stubId],
      lines: [{ title: "Synthetic integration preflight", material: "print", finish: "holo", size: "classic", totalMinor: 4900 }], totalMinor: 4900, method: "card" } });
    check("unavailable_local_variant_rejected_before_order", rejected.status === 422 && rejected.json.error?.code === "variant_not_orderable");
    const after = await api("GET", "/api/orders");
    check("failed_preflight_creates_no_order", before.status === 200 && after.status === 200 && after.json.orders.length === before.json.orders.length,
      { canonicalPrintPreflight: false, localCapabilityGate: true });
  });
  await runCase("ambiguous_sandbox_handoff", ["native_download"], async () => {
    await navigate(`/checkout/${state.stubId}`);
    await wait('[...document.querySelectorAll("button")].some(b=>b.textContent.trim().startsWith("Pay") && !b.disabled)');
    await page.eval('__ticketstubIntegrationFixture.arm("/api/orders", "drop")');
    await tap("Pay"); await wait('__ticketstubIntegrationFixture.fault()?.state === "dropped"');
    const observedOrder = await observed("/api/orders");
    state.orderRequest = observedOrder.request; state.order = observedOrder.response.order;
    requireCheck("actual_sandbox_commit_precedes_synthetic_response_loss", observedOrder.row.status === 200 && state.order?.mode === "sandbox"
      && state.order.stubIds.length === 1 && state.order.stubIds[0] === state.stubId && !observedOrder.response.checkoutUrl && !state.order.payment);
    const history = await api("GET", "/api/orders");
    check("server_history_has_the_committed_same_project_order", history.json.orders.filter((order) => order.id === state.order.id && order.stubIds.includes(state.stubId)).length === 1);
    await wait('document.body.innerText.includes("Try again")');
    check("lost_response_does_not_claim_definite_server_refusal", !await page.eval('document.body.innerText.includes("The server didn\'t take it")'),
      { fault: "response_loss_after_actual_commit", upstreamRequestCanceled: false });
    await tap("Try again");
    const replay = await observed("/api/orders", "POST", observedOrder.row.id);
    check("actual_retry_reuses_same_attempt_and_server_order", replay.request?.attemptId === state.orderRequest.attemptId && replay.response.order?.id === state.order.id);
    supplemental.order = { orderId: state.order.id, attemptIdSha256: sha256(state.orderRequest.attemptId), projectId: state.stubId,
      mode: state.order.mode, responseLostAfterCommit: true, providerDispatch: false, approvalInputAbsent: true, productionBundleInputAbsent: true };
  });
  await runCase("duplicate_sandbox_order", ["ambiguous_sandbox_handoff"], async () => {
    const again = await api("POST", "/api/orders", state.orderRequest);
    const history = await api("GET", "/api/orders");
    check("duplicate_attempt_preserves_exact_server_order", again.status === 200 && again.json.order?.id === state.order.id && objectHash(again.json.order) === objectHash(state.order));
    check("only_one_sandbox_order_in_owner_history", history.status === 200 && history.json.orders.length === 1 && history.json.orders[0].stubIds.includes(state.stubId));
  });
  await runCase("expired_session_recovery", ["account_sync"], async () => {
    const expiry = Date.now() - 1;
    const changed = withDb((db) => db.prepare("UPDATE sessions SET expires_at=? WHERE account_id=? AND expires_at>?").run(expiry, state.accountId, expiry).changes, true);
    requireCheck("actual_disposable_session_expiry_was_changed", Number(changed) === 1, { setup: "synthetic_database_expiry_of_actual_session", affectedRows: Number(changed) });
    const current = await localStub();
    const deniedSync = await api("POST", "/api/wall/sync", { stubs: [current], deleted: [] });
    const deniedApproval = await api("POST", "/api/approvals", { stubId: state.stubId, purpose: "print.compose", expectedVersionId: current.currentVersionId });
    check("expired_authority_cannot_sync_or_approve", deniedSync.status === 401 && [401, 404].includes(deniedApproval.status));
    const owner = state.accountId;
    await signIn();
    check("actual_signin_recovers_same_account_and_project", state.accountId === owner && (await synced()).id === state.stubId);
    ledger.snapshot("recovered_after_expiry", serverStub());
  });
} catch (error) {
  supplemental.errors.push({ code: codeOf(error) }); failed++; console.log(`FAIL integration/setup_or_execution ${codeOf(error)}`);
} finally {
  try { await deadline(flushDocument, 3000); } catch { supplemental.errors.push({ code: "final_probe_unavailable" }); failed++; console.log("FAIL integration/final_probe_unavailable"); }
  if (page) await deadline(() => page.close(), 2000).catch(() => { supplemental.errors.push({ code: "page_close_unconfirmed" }); });
  if (manager) {
    try { await manager.closeAll(); } catch { supplemental.errors.push({ code: "browser_cleanup_unconfirmed" }); }
    const sessions = manager.snapshot(); supplemental.browserSessions = sanitizeSessions({ ...sessions, policy: "one_fresh_process_profile_for_correlated_journey_no_cold_matrix_claim" });
    const probeComplete = supplemental.documents.length > 0 && supplemental.documents.every((document) => document.faults.length === 0);
    supplemental.browserNetwork = { externalRequests: blockedBrowserRequests, loopbackOnly: true };
    cleanup = { complete: sessions.passed === true && !supplemental.errors.length && probeComplete && blockedBrowserRequests === 0,
      browser: sessions.passed ? "confirmed" : "incomplete", probeComplete, externalRequests: blockedBrowserRequests };
  }
  stopNetworkObservation?.();
  if (page) {
    supplemental.pageErrors = { exceptions: page.consoleErrors.length, failedRequests: page.failed.length };
    if (page.consoleErrors.length || page.failed.length) cleanup.complete = false;
  }
  const safeSupplemental = evidenceIsSafe(supplemental);
  if (!safeSupplemental) { cleanup.complete = false; failed++; console.log("FAIL integration/unsafe_supplemental_evidence_refused"); }
  const result = ledger.result(cleanup);
  if (!result.passed) { failed++; console.log("FAIL integration/fixed_plan_lineage_and_cleanup_complete"); }
  else { passed++; console.log("ok   integration/fixed_plan_lineage_and_cleanup_complete"); }
  if (output) {
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, "integration-evidence.json"), JSON.stringify({ ...result, ...(safeSupplemental ? supplemental : { supplementalRefused: true }), passedChecks: passed, failedChecks: failed }, null, 2) + "\n", { flag: "wx" });
  }
  console.log(`\n${passed} passed, ${failed} failed, 0 skipped`);
  process.exit(failed || !result.passed ? 1 : 0);
}
