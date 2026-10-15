import assert from "node:assert/strict";
import { test } from "node:test";
import { registerHooks } from "node:module";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import https from "node:https";
import { Resolver } from "node:dns/promises";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { Pool } from "pg";
import ConnectionParameters from "pg/lib/connection-parameters.js";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") return { url: "data:text/javascript,export{}", shortCircuit: true };
    if (specifier === "next/server") return nextResolve("next/server.js", context);
    const candidates = specifier.startsWith("@/") ? [new URL(`../src/${specifier.slice(2)}`, import.meta.url)]
      : specifier.startsWith(".") && context.parentURL ? [new URL(specifier, context.parentURL)] : [];
    for (const base of candidates) for (const extension of ["", ".ts", ".tsx", ".mjs"]) {
      const url = new URL(`${base.href}${extension}`);
      if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith(".ts") || url.endsWith(".tsx")) return { format: "module", shortCircuit: true,
      source: ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText };
    return nextLoad(url, context);
  },
});

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const temp = mkdtempSync(join(tmpdir(), "ticketstub-creative-host-"));
const { creativeHostConfig, currentProjectAuthority, providerCredentialPort, financeConnectionOptions } = await import("../src/server/creative/config.mjs");
const { canonicalHash } = await import("creative-engine/contracts");
const { buildCreativeBrief } = await import("creative-engine/planning");
const { changeBudgetPolicy, budgetDigest, normalizedBudgetRequest, readReservationSnapshot, authorizeReservation, markReservationDispatched } = await import("@jevelopers/cost-intelligence/budgets");
const { ingestUsage } = await import("@jevelopers/cost-intelligence/metering");
const { creativeHostForRequest } = await import("../src/server/creative/host.mjs");
const { createCreativeFinance, creativeFinanceCustodySnapshot, initializeCreativeFinanceMapping, requireCreativeFinanceLifecycle } = await import("../src/server/creative/finance.mjs");
const { POST } = await import("../src/app/api/creative/route.ts");
const { POST: ART } = await import("../src/app/api/art/route.ts");

const ref = (contract, value = {}) => ({ contract, schema_version: "1.0.0", id: randomUUID(), revision: 1, content_hash: canonicalHash(value) });
const later = () => new Date(Date.now() + 30 * 60_000).toISOString();
const profile = { model_id: "synthetic-lab/offline-image", provider_tag: "synthetic-provider", capabilities: { generation: true, edit: { max_input_references: 2 } },
  supported_parameters: { aspect_ratio: { type: "enum", values: ["1:1"] }, quality: { type: "enum", values: ["low"] }, output_format: { type: "enum", values: ["png"] }, background: { type: "enum", values: ["opaque"] } },
  configuration: { aspect_ratio: "1:1", quality: "low", output_format: "png", background: "opaque" } };
const config = { schema_version: "ticketstub.creative-host/1", environment: "test", database_path: join(temp, "creative.sqlite"), object_root: join(temp, "creative-objects"),
  registry_path: join(temp, "authority.json"), image_profile: profile };
const research = (entry) => ({ contract: "EventIntelligencePackage", schema_version: "1.1", event_id: randomUUID(), tenant_id: entry.tenant_id, project_id: entry.project_id,
  correlation_id: randomUUID(), producer: "offline-external-research-data", occurred_at: new Date().toISOString(), ingested_at: new Date().toISOString(), environment: "test", billing_mode: "simulated",
  source_refs: ["page-offline"], package_id: "research-offline", source_identity: [{ source_id: "page-offline", uri: "https://example.test/event", retrieved_at: new Date().toISOString(), content_hash: canonicalHash("offline source bytes") }],
  facts: [{ fact_id: "name-offline", key: "event_name", status: "verified", value: "Offline Festival", provenance: [{ source_id: "page-offline", retrieved_at: new Date().toISOString(), evidence_ref: "source-name-offline" }] },
    { fact_id: "date-offline", key: "event_date", status: "verified", value: "2027-05-18", provenance: [{ source_id: "page-offline", retrieved_at: new Date().toISOString(), evidence_ref: "source-date-offline" }] }],
  assets: { presence: "absent", items: [] }, preferences: { presence: "absent", items: [] }, interpretations: { presence: "absent", items: [] }, permissions: { presence: "absent", items: [] }, locks: { presence: "absent", items: [] } });
const mapping = { schema_version: "ticketstub.openrouter-image-usage/1", model_id: profile.model_id, finance_model_compatibility_id: "synthetic-lab.offline-image", provider_tag: profile.provider_tag,
  budget_consumption_basis: "provider_reported_unsettled", essential_fields: ["input_tokens", "output_tokens", "total_tokens", "cost"] };
let entry = {
  application_project_id: "stub-offline", application_owner_id: "account-offline", brief_id: "brief-offline", tenant_id: randomUUID(), project_id: randomUUID(), budget_scope_id: randomUUID(),
  allowed_actor_ids: ["account-offline"], expires_at: later(), permissions: ["creative.generate", "creative.edit", "creative.read", "creative.cancel", "creative.restore", "creative.brief.create"],
  finance_service: { actor_id: "ticketstub-creative-service", grant_revision: "offline-delegation-1", operations: ["budgets.authorize", "budgets.markDispatched", "budgets.readReservation", "budgets.release", "budgets.settle", "metering.ingestUsage"],
    evidence_ref: "offline-owner-delegation", evidence_sha256: canonicalHash("offline owner-issued delegation"), source_authority_ref: ref("CreativeFinanceSource"), expires_at: later() },
  image_access: { service: "openrouter", model_id: profile.model_id, provider_tag: profile.provider_tag, account_ref: "offline-ce-account", project_ref: "offline-ce-key", grant_ref: "offline-ce-access-grant",
    eligible: true, quota_status: "available", operations: ["generate", "edit"], evidence_ref: "offline-eligibility", evidence_sha256: canonicalHash("offline eligibility data"), expires_at: later(), profile_sha256: canonicalHash(profile) },
  maximums: { image_generation: { amount: "1.00", policy_ref: ref("CreativeMaximumPolicy"), evidence_ref: "offline-maximum", evidence_sha256: canonicalHash("offline maximum"), expires_at: later() },
    image_edit: { amount: "1.00", policy_ref: ref("CreativeMaximumPolicy"), evidence_ref: "offline-edit-maximum", evidence_sha256: canonicalHash("offline edit maximum"), expires_at: later() } },
  budget_policy_ref: ref("BudgetPolicy"), research_package: {}, asset_permissions: [],
  usage_profile: { ref: "offline-reviewed-openrouter-usage/1", sha256: canonicalHash(mapping), mapping, source_authority_ref: ref("ImageUsageProfile"), expires_at: later() },
};
entry.research_package = research(entry);
entry.brief_id = buildCreativeBrief({ trusted_scope: { tenant_id: entry.tenant_id, project_id: entry.project_id }, research_package: entry.research_package,
  context: { created_at: new Date().toISOString(), environment: "test", billing_mode: "live", correlation_id: randomUUID() } }).brief.brief_id;
const writeRegistry = () => { writeFileSync(config.registry_path, JSON.stringify({ schema_version: "ticketstub.creative-authority/1", projects: [entry] }), { mode: 0o600 }); chmodSync(config.registry_path, 0o600); };
writeRegistry();

test("host configuration and private authority records fail closed; credentials remain separate", () => {
  const manifest = JSON.parse(readFileSync(join(root, "src/server/vendor/creative-engine/MANIFEST.json"), "utf8"));
  const installed = dirname(dirname(dirname(fileURLToPath(import.meta.resolve("creative-engine/api/v1")))));
  for (const [file, expected] of Object.entries(manifest.files)) if (file.startsWith("src/")) {
    assert.equal(createHash("sha256").update(readFileSync(join(installed, file))).digest("hex"), expected, `installed owned runtime must match ${file}`);
  }
  assert.equal(creativeHostConfig({}), null);
  for (const bad of ["{}", "not json", JSON.stringify({ ...config, environment: "preview" }), JSON.stringify({ ...config, apiKey: "must-not-be-grouped" })]) {
    assert.throws(() => creativeHostConfig({ TICKETSTUB_CREATIVE_CONFIG: bad }), { code: "creative_configuration_unavailable" });
  }
  assert.throws(() => currentProjectAuthority(config, entry.application_project_id, "other-owner", "account-offline"));
  assert.throws(() => currentProjectAuthority(config, entry.application_project_id, entry.application_owner_id, "other-actor"));
  chmodSync(config.registry_path, 0o666);
  assert.throws(() => currentProjectAuthority(config, entry.application_project_id, entry.application_owner_id, "account-offline"));
  chmodSync(config.registry_path, 0o600);
  const authority = () => currentProjectAuthority(config, entry.application_project_id, entry.application_owner_id, "account-offline");
  const input = { service: "openrouter", scope: { tenant_id: entry.tenant_id, project_id: entry.project_id }, account_ref: entry.image_access.account_ref,
    project_ref: entry.image_access.project_ref, grant_ref: entry.image_access.grant_ref, target_binding_sha256: canonicalHash("target"), deadline_at: later() };
  const onlyStudio = providerCredentialPort(config, authority, { TICKETSTUB_ART_OPENROUTER_API_KEY: "offline-studio-only" });
  assert.throws(() => onlyStudio.resolveCredential(input), { code: "creative_credential_unavailable" });
  const credential = providerCredentialPort(config, authority, { CREATIVE_ENGINE_OPENROUTER_API_KEY: "offline-ce-only", TICKETSTUB_ART_OPENROUTER_API_KEY: "offline-studio-only" }).resolveCredential(input);
  assert.ok(credential.token === "offline-ce-only", "the creative credential identity must remain separate");
  const connection = new ConnectionParameters(financeConnectionOptions("postgresql://offline-runtime:synthetic-password@finance.example.test/creative", "production"));
  assert.deepEqual(connection.ssl, { rejectUnauthorized: true }); assert.equal(connection.statement_timeout, 5000);
  assert.equal(connection.connect_timeout, 2);
  for (const query of ["sslmode=disable", "ssl=false", "uselibpqcompat=true", "statement_timeout=0", "sslcert=/tmp/untrusted", "sslkey=/tmp/untrusted", "sslrootcert=/tmp/untrusted"]) {
    assert.throws(() => financeConnectionOptions(`postgresql://offline-runtime:synthetic-password@finance.example.test/creative?${query}`, "production"), { code: "creative_configuration_unavailable" });
  }
});

// Real public art route/provider execution, intercepted transport only.
test("direct studio provider failures are explicit and never publish simulated success", async () => {
  const saved = { ...process.env };
  const originalFetch = globalThis.fetch;
  Object.assign(process.env, { TICKETSTUB_DB: join(temp, "app.sqlite"), TICKETSTUB_FILES: join(temp, "app-files"), TICKETSTUB_RUNTIME_MODE: "live",
    CONTEXT_SECRET: "offline-issuer-secret-with-at-least-thirty-two-characters", TICKETSTUB_ART_PROVIDER: "openai", TICKETSTUB_ART_MODEL: "gpt-image-2.5-sunburst" });
  delete process.env.GPT_IMAGE_MODEL;
  const { getStorage } = await import("../src/server/index.ts");
  const allowanceUsed = () => getStorage().db.prepare("SELECT coalesce(sum(count),0) AS total FROM art_usage").get().total;
  const call = async (signal) => {
    const response = await ART(new Request("https://ticketstub.test/api/art", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ event: { title: "Offline event", type: "generic", facts: [] }, first: true, edition: "researched" }), signal }));
    const value = await response.json();
    assert.ok(response.status >= 400); assert.equal(value.provenance, undefined); assert.equal(value.art, undefined); return value.error.code;
  };
  try {
    const before = allowanceUsed();
    delete process.env.OPENAI_API_KEY;
    assert.equal(await call(), "missing_provider_key");
    process.env.OPENAI_API_KEY = "offline-direct-canary";
    process.env.TICKETSTUB_ART_MODEL = "unsupported-model";
    assert.equal(await call(), "unsupported_image_model");
    delete process.env.TICKETSTUB_ART_MODEL;
    assert.equal(await call(), "invalid_model_configuration");
    process.env.TICKETSTUB_ART_MODEL = "gpt-image-2.5-sunburst";
    process.env.GPT_IMAGE_MODEL = "gpt-image-2";
    assert.equal(await call(), "invalid_model_configuration"); delete process.env.GPT_IMAGE_MODEL;
    assert.equal(allowanceUsed(), before, "invalid/missing image configuration cannot consume any quota");
    globalThis.fetch = async () => new Response("{}", { status: 401 });
    assert.equal(await call(), "provider_authentication_failed");
    globalThis.fetch = async () => { throw new TypeError("offline network failure"); };
    assert.equal(await call(), "provider_unavailable");
    const controller = new AbortController(); controller.abort();
    globalThis.fetch = async () => { throw new DOMException("cancelled", "AbortError"); };
    assert.equal(await call(controller.signal), "provider_request_cancelled");
  } finally { globalThis.fetch = originalFetch; for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); }
});


test("Finance-first barrier denies paid routes and direct admission without a runtime override; read state remains available", async (t) => {
  const saved = { ...process.env }; const originalFetch = globalThis.fetch; let host; let attempts = 0;
  Object.assign(process.env, { TICKETSTUB_DB: join(temp, "app.sqlite"), TICKETSTUB_FILES: join(temp, "app-files"), TICKETSTUB_RUNTIME_MODE: "live",
    CONTEXT_SECRET: "offline-issuer-secret-with-at-least-thirty-two-characters", ADMIN_EMAILS: "commissioning@example.test", TICKETSTUB_OPS_ENVIRONMENT: "test",
    GIT_SHA: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(), APP_URL: "https://ticketstub.test",
    TICKETSTUB_CREATIVE_CONFIG: JSON.stringify(config), TICKETSTUB_FINANCE_DATABASE_URL: "postgresql://fixture:fixture@127.0.0.1:1/unavailable",
    CREATIVE_ENGINE_OPENROUTER_API_KEY: "offline-ce-only", TYPESAFE_API_KEY: "offline-typesafe-only", TICKETSTUB_FINANCE_LIFECYCLE_ACCEPTED: "true" });
  globalThis.fetch = async () => { attempts += 1; throw new Error("Unexpected provider transport"); };
  t.mock.method(Pool.prototype, "connect", async () => { attempts += 1; throw new Error("Unexpected Finance connection"); });
  t.mock.method(https, "request", () => { attempts += 1; throw new Error("Unexpected decision transport"); });
  t.mock.method(Resolver.prototype, "resolve4", async () => { attempts += 1; throw new Error("Unexpected provider DNS"); });
  try {
    const { getStorage } = await import("../src/server/index.ts"); const { hashToken } = await import("../src/server/crypto.ts");
    const { newStub, NEATHACK } = await import("../src/customer/studio/fixtures.ts");
    const account = await getStorage().findOrCreateAccount("commissioning@example.test", Date.now()); const cookie = randomBytes(24).toString("base64url");
    await getStorage().createSession(hashToken(cookie), account.id, Date.now(), Date.now() + 60 * 60_000);
    await getStorage().syncWall(account.id, [newStub(NEATHACK, entry.application_project_id)], [], Date.now());
    entry.application_owner_id = account.id; entry.allowed_actor_ids = [account.id]; writeRegistry();
    const request = (operation, payload = {}) => new Request("https://ticketstub.test/api/creative", { method: "POST", headers: { origin: "https://ticketstub.test", cookie: `ts_session=${cookie}`, "content-type": "application/json" },
      body: JSON.stringify({ projectId: entry.application_project_id, operation, actionId: randomUUID(), payload }) });
    host = await creativeHostForRequest(request("list"), entry.application_project_id);
    const brief = await POST(request("brief.create")); assert.equal(brief.status, 200);
    for (const operation of ["generate", "edit"]) {
      const response = await POST(request(operation, { brief_id: entry.brief_id })); const value = await response.json();
      assert.equal(response.status, 503); assert.equal(value.error.code, "creative_finance_lifecycle_unavailable"); assert.equal(value.result, undefined);
    }
    const reading = await POST(request("list", { brief_id: entry.brief_id })); assert.equal(reading.status, 200); assert.equal((await reading.json()).result.items.length, 0);
    assert.equal(host.store.db.prepare("SELECT count(*) AS count FROM ticketstub_creative_attempts").get().count, 0);
    assert.throws(() => requireCreativeFinanceLifecycle({ accepted: true, consumerAck: "synthetic" }), { code: "creative_finance_lifecycle_unavailable" });
    const finance = createCreativeFinance({ database: host.store.db, pool: null, authority: () => entry, currentContext: async () => {}, environment: "test", lifecycleAccepted: true });
    await assert.rejects(finance.metering.reserveAttempt({}, {}), { code: "creative_finance_lifecycle_unavailable" });
    assert.equal(attempts, 0, "paid denial precedes new Finance admission, DNS and provider writes");
  } finally { if (host) await host.close(); globalThis.fetch = originalFetch; for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); }
});

const recoveryObservation = (row, id = randomUUID()) => ({ schema_version: "creative.metering.proposal/v1", tenant_id: row.attempt.tenant_id, project_id: row.attempt.project_id,
  budget_scope_id: row.attempt.budget_scope_id, logical_operation_id: row.attempt.logical_operation_id, billable_attempt_id: row.attempt.billable_attempt_id,
  source_observation_id: id, source: "provider_response", provider_name: "typesafe", model: "jev-1.13.0", transport_attempt_id: row.transport_id,
  environment: "test", billing_mode: "live", completeness: "complete", missing_fields: [], usage_units: [{ name: "input_tokens", quantity: "10", relation: "standalone" }, { name: "output_tokens", quantity: "4", relation: "standalone" }] });

test("recovery writers preserve concurrent observations and holds across request instances sharing SQLite", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(join(temp, "concurrent-recovery.sqlite")); initializeCreativeFinanceMapping(database);
  const second = new DatabaseSync(join(temp, "concurrent-recovery.sqlite"));
  try {
    // Synthetic held evidence isolates local immutable recovery storage. It is
    // not Finance admission, a native custody receipt or a released lifecycle.
    const current = structuredClone(entry); current.decision_access = { provider: "typesafe", model: "jev-1.13.0", accountRef: "fixture-account", projectRef: "fixture-project",
      grantRef: "fixture-grant", evidenceRef: "fixture-evidence", evidenceSha256: canonicalHash("synthetic recovery evidence"), expiresAt: later(), eligible: true };
    current.maximums.jev_decision = { amount: "1.00", policy_ref: ref("CreativeMaximumPolicy"), expires_at: later() };
    const bid = randomUUID(); const logical = randomUUID(); const transport = randomUUID(); const access = current.decision_access;
    const attempt = { schema_version: "creative.metering.proposal/v1", tenant_id: current.tenant_id, project_id: current.project_id, budget_scope_id: current.budget_scope_id,
      logical_operation_id: logical, billable_attempt_id: bid, retry_mapping_ref: "synthetic-recovery-storage", operation_kind: "jev_decision", environment: "test", billing_mode: "live",
      budget: { scope_id: current.budget_scope_id, policy_version: "ci-budget-policy-1.0.0" }, provider: { name: "typesafe", model: "jev-1.13.0", endpoint: "https://api.typesafe.ai/v1/systemone", sdk: { name: "agent-harness-http", version: "0.1.0" } } };
    const binding = { mappingVersion: "ci-reservation-authority-1.0.0", budgetScopeId: current.budget_scope_id, grantRef: access.grantRef, accountRef: access.accountRef, projectRef: access.projectRef,
      provider: "typesafe", model: access.model, operation: "decision", targetBindingSha256: canonicalHash("synthetic target"), leaseRef: randomUUID(), leaseExpiresAt: later() };
    const attemptBinding = { logicalOperationId: logical, transportAttemptId: transport, providerRequestId: null, providerAttemptId: bid, billableAttemptId: bid };
    const row = { attempt, scope: { tenantId: current.tenant_id, projectId: current.project_id, environment: "test", billingMode: "live", actorId: current.finance_service.actor_id },
      access: { account_ref: access.accountRef, project_ref: access.projectRef, grant_ref: access.grantRef, evidence_ref: access.evidenceRef, evidence_sha256: access.evidenceSha256, expires_at: access.expiresAt },
      maximum: current.maximums.jev_decision, source_ref: current.finance_service.source_authority_ref, custody: creativeFinanceCustodySnapshot(current, attempt), binding, attempt_binding: attemptBinding,
      reserve_request: { sourceAuthorityRef: current.finance_service.source_authority_ref, authorityBinding: binding, attemptBinding, canonicalRequest: { policy_ref: current.budget_policy_ref } },
      reservation_id: randomUUID(), transport_id: transport, state: "held_for_reconciliation", recovery_reason: "original_unknown", usage_request: { fixture: "opaque original request bytes" } };
    row.observation = recoveryObservation(row); row.observations = [row.observation];
    const originalBytes = JSON.stringify(row.observation); const requestBytes = JSON.stringify(row.usage_request);
    database.prepare("INSERT INTO ticketstub_creative_attempts VALUES (?,?)").run(bid, JSON.stringify(row));
    const read = () => JSON.parse(database.prepare("SELECT state FROM ticketstub_creative_attempts WHERE billable_attempt_id=?").get(bid).state);
    const input = { billable_attempt_id: bid, logical_operation_id: logical, reservation_id: row.reservation_id, lease_id: binding.leaseRef, transport_attempt_id: transport };
    let arrivals = 0; let entered; let resume; let block = true;
    let enteredPromise = new Promise((resolve) => { entered = resolve; }); let resumed = new Promise((resolve) => { resume = resolve; });
    const currentContext = async () => { if (block) { if (++arrivals === 2) entered(); await resumed; } };
    const finance = [database, second].map((db) => createCreativeFinance({ database: db, pool: null, authority: () => current, currentContext, assertCurrentContext() {}, environment: "test" }));
    const observations = [recoveryObservation(row), recoveryObservation(row)];
    const concurrent = Promise.all(observations.map((observation, index) => finance[index].metering.recordUsageObservation({ ...input, observation })));
    await enteredPromise; block = false; resume();
    assert.deepEqual((await concurrent).map((value) => value.status), ["held_for_reconciliation", "held_for_reconciliation"]);
    assert.equal(read().observations.length, 3); assert.equal(JSON.stringify(read().observation), originalBytes); assert.equal(JSON.stringify(read().usage_request), requestBytes);
    for (const observation of observations) assert.deepEqual(read().observations.find((item) => item.source_observation_id === observation.source_observation_id), observation);
    await Promise.all(finance.map((instance) => instance.metering.recordUsageObservation({ ...input, observation: observations[0] })));
    assert.equal(read().observations.length, 3, "same-ID identical bytes are idempotent across instances");
    const conflict = structuredClone(observations[0]); conflict.usage_units[0].quantity = "11";
    const outcomes = await Promise.allSettled([finance[0].metering.recordUsageObservation({ ...input, observation: observations[0] }), finance[1].metering.recordUsageObservation({ ...input, observation: conflict })]);
    assert.deepEqual(outcomes.map((value) => value.status), ["fulfilled", "rejected"]);
    assert.deepEqual(read().observations.find((item) => item.source_observation_id === conflict.source_observation_id), observations[0]);
    arrivals = 1; block = true; enteredPromise = new Promise((resolve) => { entered = resolve; }); resumed = new Promise((resolve) => { resume = resolve; });
    const delayed = finance[0].metering.recordUsageObservation({ ...input, observation: recoveryObservation(row) }); await enteredPromise;
    await Promise.all([finance[1].metering.markAttemptInFlight(input), finance[1].metering.markOutcomeUnknown({ ...input, reason: "concurrent_unknown" }),
      finance[1].metering.settleReservation(input), finance[1].metering.releaseBeforeDispatch(input)]);
    block = false; resume(); await delayed;
    assert.equal(read().observations.length, 4); assert.equal(read().state, "held_for_reconciliation");
    for (const reason of ["original_unknown", "finance_lifecycle_unavailable", "concurrent_unknown", "public_settlement_unavailable", "public_release_unavailable"]) assert.ok(read().recovery_reasons.includes(reason));
    assert.equal(JSON.stringify(read().usage_request), requestBytes);
  } finally { second.close(); database.close(); }
});

test("real Finance SQL qualifies only existing command replay, current custody and pending intake holds; paid adoption stays blocked", { skip: process.env.TICKETSTUB_OFFLINE_POSTGRES !== "1" }, async (t) => {
  const savedProcessEnvironment = { ...process.env };
  const name = `ticketstub-finance-recovery-${randomBytes(5).toString("hex")}`; const password = randomBytes(32).toString("base64url");
  const runtimePassword = randomBytes(32).toString("base64url"); const envFile = join(temp, "recovery-postgres.env");
  writeFileSync(envFile, `POSTGRES_PASSWORD=${password}\nPOSTGRES_DB=creative_offline\n`, { mode: 0o600 });
  const docker = (args) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const image = "postgres@sha256:ca0bd484cb98bf4b24eb1010e73fb3fcbd6714d240fbc1a10eea5b7dbecb641d";
  let admin; let runtime; let failed = false; let database; let secondDatabase;
  try {
    docker(["image", "inspect", image]); docker(["run", "--rm", "--name", name, "-d", "-p", "127.0.0.1::5432", "--env-file", envFile, image]);
    const port = Number(docker(["port", name, "5432/tcp"]).split(":").at(-1));
    for (let count = 0; count < 50; count += 1) {
      admin = new Pool({ host: "127.0.0.1", port, user: "postgres", password, database: "creative_offline", connectionTimeoutMillis: 1000 });
      try { await admin.query("SELECT 1"); break; } catch { await admin.end(); admin = null; await new Promise((resolve) => setTimeout(resolve, 100)); }
    }
    assert.ok(admin); const migrations = join(root, "src/server/vendor/cost-intelligence/migrations");
    for (const file of readdirSync(migrations).filter((file) => file.endsWith(".sql")).sort()) await admin.query(readFileSync(join(migrations, file), "utf8"));
    await admin.query(`CREATE ROLE creative_runtime LOGIN PASSWORD '${runtimePassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS`);
    await admin.query("GRANT ci_finance_runtime TO creative_runtime");
    runtime = new Pool({ host: "127.0.0.1", port, user: "creative_runtime", password: runtimePassword, database: "creative_offline" });
    const { DatabaseSync } = await import("node:sqlite"); database = new DatabaseSync(join(temp, "recovery.sqlite")); initializeCreativeFinanceMapping(database);
    const current = structuredClone(entry); current.decision_access = { provider: "typesafe", model: "jev-1.13.0", environment: "test", accountRef: "fixture-account", projectRef: "fixture-key",
      grantRef: "fixture-grant", evidenceRef: "fixture-eligibility", evidenceSha256: canonicalHash("synthetic eligibility, not acceptance"), expiresAt: later(), eligible: true };
    current.maximums.jev_decision = { amount: "1.00", policy_ref: ref("CreativeMaximumPolicy"), evidence_ref: "fixture-maximum", evidence_sha256: canonicalHash("fixture maximum"), expires_at: later() };
    const original = () => structuredClone(current);
    const scope = { tenantId: current.tenant_id, projectId: current.project_id, environment: "test", billingMode: "live", actorId: current.finance_service.actor_id };
    const ownerPorts = { database: runtime, clock: { now: () => new Date() }, trustedContext: { resolve: async (value) => value },
      financeAuthority: { authorizeCurrent: async (input) => ({ status: "allowed", decisionId: "synthetic-external-finance-owner", operation: input.operation, permission: input.permission,
        scope: input.requestedScope, principal: { kind: "service", actorId: scope.actorId, serviceStatus: "active", serviceGrantRevision: "fixture-owner-grant" }, verifiedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() }) },
      budgetEvidence: { verifyCurrent: async (query) => ({ status: "verified", queryDigest: await budgetDigest(query), verifiedAt: new Date().toISOString(), expiresAt: later(),
        maximum: { policyRef: current.maximums.jev_decision.policy_ref, authorizedCap: "1.00", currency: "USD" } }) },
      reservationAuthority: { verifyCurrent: async (query) => ({ status: "allowed", revoked: false, queryDigest: await budgetDigest(query), verifiedAt: new Date().toISOString(), expiresAt: later(), evidenceRef: current.decision_access.evidenceRef, evidenceSha256: current.decision_access.evidenceSha256 }) } };
    const policy = await changeBudgetPolicy({ schemaVersion: "1.0.0", requestId: randomUUID(), idempotencyKey: randomUUID(), scope, currency: "USD", limitAmount: "50.00", expectedPolicyRevision: 0,
      actorReference: "synthetic-external-owner", reasonReference: "offline-recovery-fixtures-only", sourceAuthorityRef: current.finance_service.source_authority_ref }, ownerPorts);
    assert.equal(policy.ok, true); current.budget_policy_ref = policy.value.policyRef;
    const sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const write = (row) => database.prepare("INSERT INTO ticketstub_creative_attempts VALUES (?,?) ON CONFLICT(billable_attempt_id) DO UPDATE SET state=excluded.state").run(row.attempt.billable_attempt_id, JSON.stringify(row));
    const read = (row) => JSON.parse(database.prepare("SELECT state FROM ticketstub_creative_attempts WHERE billable_attempt_id=?").get(row.attempt.billable_attempt_id).state);
    const provision = async ({ commitDispatch = true } = {}) => {
      const bid = randomUUID(); const logical = randomUUID(); const transport = randomUUID(); const access = current.decision_access;
      const attempt = { schema_version: "creative.metering.proposal/v1", tenant_id: current.tenant_id, project_id: current.project_id, budget_scope_id: current.budget_scope_id,
        logical_operation_id: logical, billable_attempt_id: bid, retry_mapping_ref: "offline-recovery-only", operation_kind: "jev_decision", environment: "test", billing_mode: "live",
        budget: { scope_id: current.budget_scope_id, policy_version: "ci-budget-policy-1.0.0" }, provider: { name: "typesafe", model: "jev-1.13.0", endpoint: "https://api.typesafe.ai/v1/systemone", sdk: { name: "agent-harness-http", version: "0.1.0" } } };
      const binding = { mappingVersion: "ci-reservation-authority-1.0.0", budgetScopeId: current.budget_scope_id, grantRef: access.grantRef, accountRef: access.accountRef, projectRef: access.projectRef,
        provider: "typesafe", model: access.model, operation: "decision", targetBindingSha256: canonicalHash({ fixture: bid }), leaseRef: randomUUID(), leaseExpiresAt: later() };
      const attemptBinding = { logicalOperationId: logical, transportAttemptId: transport, providerRequestId: null, providerAttemptId: bid, billableAttemptId: bid };
      const stamp = new Date().toISOString(); const common = { schema_version: "1.0.0", policy_version: "1.0.0", event_id: randomUUID(), tenant_id: current.tenant_id, project_id: current.project_id,
        correlation_id: randomUUID(), producer: { module: "getticketstub.com", source_revision: sourceRevision, build_revision: sourceRevision }, occurred_at: stamp, observed_at: stamp, ingested_at: stamp, environment: "test", billing_mode: "live", source_refs: [] };
      const reserve = { schemaVersion: "1.0.0", requestId: randomUUID(), idempotencyKey: `${bid}:reserve`, scope,
        canonicalRequest: { ...common, contract: "ReserveRequest", request_id: randomUUID(), idempotency_key: `${bid}:reserve`, budget_scope_id: current.budget_scope_id,
          logical_operation_id: logical, billable_attempt_id: bid, currency: "USD", policy_ref: current.budget_policy_ref, requested: { amount: "1.00", currency: "USD", scale: 2 }, expires_at: binding.leaseExpiresAt },
        estimate: { completeness: "unknown", knownSubtotal: "0", currency: "USD", rateCardRef: null, missingDimensions: ["usage"], boundedConservativeMaximum: "1.00", maximumPolicyRef: current.maximums.jev_decision.policy_ref },
        allowPartialAuthorization: false, attemptBinding, authorityBinding: binding, sourceAuthorityRef: current.finance_service.source_authority_ref };
      // External-owner fixture provisioning uses the actual CI05A engine, never
      // the disabled Product reserve method, and grants no producer adoption.
      const reserved = await authorizeReservation(reserve, ownerPorts); assert.equal(reserved.ok, true); assert.equal(reserved.value.status, "authorized");
      const dispatchRef = ref("CreativeDispatchIntent", { fixture: bid });
      const command = { schemaVersion: "1.0.0", requestId: randomUUID(), idempotencyKey: `${bid}:dispatch`, scope, reservationId: reserved.value.reservationId, expectedRevision: 1,
        actorReference: scope.actorId, sourceAuthorityRef: current.finance_service.source_authority_ref, attemptBinding, action: "mark_dispatched", dispatchIntentRef: dispatchRef,
        workerLeaseId: binding.leaseRef, workerLeaseExpiresAt: binding.leaseExpiresAt };
      const row = { attempt, scope, access: { account_ref: access.accountRef, project_ref: access.projectRef, grant_ref: access.grantRef, evidence_ref: access.evidenceRef, evidence_sha256: access.evidenceSha256, expires_at: access.expiresAt },
        maximum: current.maximums.jev_decision, source_ref: current.finance_service.source_authority_ref, custody: creativeFinanceCustodySnapshot(current, attempt), binding, attempt_binding: attemptBinding,
        reserve_request: reserve, reservation_id: reserved.value.reservationId, held_amount: "1.00", transport_id: transport, dispatch_ref: dispatchRef, dispatch_command: command, state: "reserved", common };
      write(row);
      const digest = await budgetDigest(normalizedBudgetRequest(row.reserve_request));
      database.prepare("INSERT INTO ticketstub_creative_finance_sources VALUES (?,?,?,?)").run(digest, bid, JSON.stringify(row.source_ref),
        JSON.stringify({ policyRef: row.maximum.policy_ref, authorizedCap: "1.00", currency: "USD" }));
      if (commitDispatch) { const committed = await markReservationDispatched(command, ownerPorts); assert.equal(committed.ok, true); assert.equal(committed.value.status, "applied"); }
      return row;
    };
    const { getStorage } = await import("../src/server/index.ts"); const { hashToken } = await import("../src/server/crypto.ts");
    const { getRequestContext, requireCreativeCommissioningContext, assertCreativeCommissioningCurrent } = await import("../src/server/context.ts");
    Object.assign(process.env, { TICKETSTUB_RUNTIME_MODE: "live", CONTEXT_SECRET: "offline-issuer-secret-with-at-least-thirty-two-characters", ADMIN_EMAILS: "commissioning@example.test", TICKETSTUB_OPS_ENVIRONMENT: "test", TYPESAFE_API_KEY: "offline-typesafe-only" });
    const account = await getStorage().findOrCreateAccount("commissioning@example.test", Date.now()); const cookie = randomBytes(24).toString("base64url");
    await getStorage().createSession(hashToken(cookie), account.id, Date.now(), Date.now() + 60 * 60_000);
    const req = new Request("https://ticketstub.test/api/creative", { headers: { cookie: `ts_session=${cookie}` } });
    const platform = await getRequestContext(req); const scoped = await getRequestContext(req, { id: entry.application_project_id, kind: "stub" });
    requireCreativeCommissioningContext(platform, scoped);
    const financeFor = (db) => createCreativeFinance({ database: db, pool: runtime, environment: "test", authority: () => current,
      currentContext: async () => { const fresh = await getRequestContext(req, { id: entry.application_project_id, kind: "stub" }); requireCreativeCommissioningContext(await getRequestContext(req), fresh); },
      assertCurrentContext: () => assertCreativeCommissioningCurrent(req, { platform, scoped }) });
    const finance = financeFor(database);
    const input = (row) => ({ billable_attempt_id: row.attempt.billable_attempt_id, logical_operation_id: row.attempt.logical_operation_id, reservation_id: row.reservation_id, lease_id: row.binding.leaseRef, transport_attempt_id: row.transport_id });
    const committed = await provision(); const commandBytes = JSON.stringify(committed.dispatch_command);
    // PostgreSQL committed, but the Product response/local acknowledgement was
    // lost. Only the exact real owner 'replay' may repair that local ACK.
    assert.equal((await finance.metering.recordTransportAttempt(input(committed))).status, "recorded");
    assert.equal(read(committed).dispatch_ack.status, "replay"); assert.equal(read(committed).dispatch_ack.owner_revision, 2);
    assert.equal(JSON.stringify(read(committed).dispatch_command), commandBytes);
    assert.equal((await finance.metering.recordTransportAttempt(input(committed))).status, "recorded");
    const events = async (row) => (await admin.query("SELECT event_type,consumed_amount::text,released_amount::text FROM cost_intelligence.budget_reservation_events WHERE reservation_id=$1 ORDER BY event_sequence", [row.reservation_id])).rows;
    assert.deepEqual((await events(committed)).map((event) => event.event_type), ["authorized", "dispatched"]);
    const absent = await provision({ commitDispatch: false }); assert.equal((await finance.metering.recordTransportAttempt(input(absent))).status, "held_for_reconciliation");
    assert.deepEqual((await events(absent)).map((event) => event.event_type), ["authorized"], "recovery cannot append a missing original dispatch");
    const missing = await provision(); delete missing.dispatch_command; write(missing); assert.equal((await finance.metering.recordTransportAttempt(input(missing))).status, "held_for_reconciliation");
    const divergent = await provision(); divergent.dispatch_command.requestId = randomUUID(); divergent.dispatch_command.dispatchIntentRef = ref("CreativeDispatchIntent"); write(divergent);
    assert.equal((await finance.metering.recordTransportAttempt(input(divergent))).status, "held_for_reconciliation");
    assert.deepEqual((await events(divergent)).map((event) => event.event_type), ["authorized", "dispatched"]);
    const partial = await provision(); delete partial.custody; write(partial); await assert.rejects(finance.readRecoveryState(input(partial)), { code: "creative_finance_unavailable" });
    const savedAuthority = original();
    for (const mutate of [
      (value) => { value.finance_service.source_authority_ref = ref("CreativeFinanceSource"); },
      (value) => { value.finance_service.grant_revision = "changed-grant-revision"; },
      (value) => { value.decision_access.accountRef = "changed-account"; },
      (value) => { value.decision_access.projectRef = "changed-project"; },
      (value) => { value.decision_access.grantRef = "changed-grant"; },
      (value) => { value.decision_access.model = "changed-model"; },
      (value) => { value.budget_policy_ref = ref("BudgetPolicy"); },
      (value) => { value.maximums.jev_decision.policy_ref = ref("CreativeMaximumPolicy"); },
    ]) {
      Object.assign(current, structuredClone(savedAuthority)); mutate(current);
      await assert.rejects(finance.readRecoveryState(input(committed)), { code: "creative_finance_unavailable" });
      assert.deepEqual((await events(committed)).map((event) => event.event_type), ["authorized", "dispatched"]);
    }
    Object.assign(current, structuredClone(savedAuthority));
    const originalDigest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle); let changeAfterDigest;
    t.mock.method(globalThis.crypto.subtle, "digest", async (...args) => {
      const result = await originalDigest(...args);
      if (changeAfterDigest && new Error().stack.includes("verifyCurrent")) { const change = changeAfterDigest; changeAfterDigest = undefined; change(); }
      return result;
    });
    changeAfterDigest = () => { current.decision_access.accountRef = "changed-after-owned-digest"; };
    await assert.rejects(finance.verifyRecoveryAuthorization({ billable_attempt_id: committed.attempt.billable_attempt_id, reservation_ref: committed.reservation_id,
      target_binding_sha256: committed.binding.targetBindingSha256 }));
    assert.equal(changeAfterDigest, undefined, "the actual owner digest callback boundary was crossed");
    Object.assign(current, structuredClone(savedAuthority));
    // Preserve the real SQL response. Mutate custody after COMMIT has awaited;
    // the final current source/session fences must deny local ACK.
    const originalConnect = runtime.connect.bind(runtime); let changeAfterCommit; let commitsUntilChange = 1; let pauseAfterCommit; let commitsUntilPause = 1;
    t.mock.method(runtime, "connect", async () => {
      const client = await originalConnect(); const originalQuery = client.query.bind(client);
      const wrapped = { release: () => client.release(), query: async (...args) => {
        const result = await originalQuery(...args);
        if (changeAfterCommit && args[0] === "COMMIT" && --commitsUntilChange === 0) { const change = changeAfterCommit; changeAfterCommit = undefined; change(); }
        if (pauseAfterCommit && args[0] === "COMMIT" && --commitsUntilPause === 0) { const pause = pauseAfterCommit; pauseAfterCommit = undefined; await pause(); }
        return result;
      } };
      return wrapped;
    });
    changeAfterCommit = () => { current.finance_service.source_authority_ref = ref("CreativeFinanceSource"); };
    await assert.rejects(finance.readRecoveryState(input(committed)), { code: "creative_finance_unavailable" }); assert.equal(changeAfterCommit, undefined);
    Object.assign(current, structuredClone(savedAuthority));
    commitsUntilChange = 2;
    changeAfterCommit = () => { void getStorage().deleteSession(hashToken(cookie)); };
    await assert.rejects(finance.metering.recordTransportAttempt(input(committed))); assert.equal(changeAfterCommit, undefined);
    await getStorage().createSession(hashToken(cookie), account.id, Date.now(), Date.now() + 60 * 60_000);
    commitsUntilChange = 1;
    const observationId = randomUUID(); const observation = recoveryObservation(committed, observationId);
    const row = read(committed); row.usage_request = { schemaVersion: "1.0.0", requestId: randomUUID(), idempotencyKey: `${observationId}:usage`, scope,
      usageEvent: { ...row.common, contract: "UsageEvent", event_id: randomUUID(), usage_event_id: randomUUID(), source_observation_id: observationId, logical_operation_id: row.attempt.logical_operation_id,
        provider_attempt_id: row.attempt.billable_attempt_id, billable_attempt_id: row.attempt.billable_attempt_id, transport_attempt_id: row.transport_id, provider_request_id: null,
        provider: "typesafe", model: "jev-1.13.0", source: "provider_response", completeness: "complete", usage_units: observation.usage_units.map((unit) => ({ ...unit, scale: 0 })), missing_fields: [],
        valuation: { basis: "estimated", money: { amount: "0.014", currency: "USD", scale: 3 }, rate_card_ref: ref("SyntheticValuationEvidence") }, outcome: "unknown", retry_mapping_ref: row.source_ref,
        supersedes_observation_id: null, reconciliation_ref: null }, evidenceMode: "sandbox", verificationStatus: "verified", evidenceProvenanceRef: "synthetic-recovery-native-data" };
    write(row); const usageBytes = JSON.stringify(row.usage_request);
    // Real Finance intake under a synthetic external owner. Its trusted clock
    // becomes unavailable only at the actual ledger append, so the real SQL
    // outbox records retry; this is not a mocked Finance response or approval.
    const retryPorts = { ...ownerPorts, clock: { now() {
      const stack = new Error().stack;
      return stack.includes("appendLedgerEventInternal") && !stack.includes("usageDecisionIsCurrent") ? new Date(Number.NaN) : new Date();
    } } };
    const intake = await ingestUsage(row.usage_request, retryPorts);
    assert.equal(intake.ok, true); assert.equal(intake.value.durableCommit, true); assert.equal(intake.value.status, "accepted"); assert.equal(intake.value.outboxStatus, "retry");
    row.intake_receipt = intake.value; write(row);
    assert.equal((await finance.metering.recordUsageObservation({ ...input(row), observation })).status, "held_for_reconciliation");
    assert.equal(read(row).intake_receipt.outboxStatus, "retry"); assert.equal(read(row).state, "held_for_reconciliation");
    assert.equal(JSON.stringify(read(row).usage_request), usageBytes);
    const repeated = await ingestUsage(row.usage_request, ownerPorts); assert.equal(repeated.ok, true); assert.equal(repeated.value.status, "duplicate");
    assert.equal(repeated.value.outboxStatus, "retry");
    // Pause the actual owner replay after its final COMMIT. Another request and
    // SQLite connection durably append usage/unknown evidence before local ACK.
    secondDatabase = new DatabaseSync(join(temp, "recovery.sqlite")); const secondFinance = financeFor(secondDatabase);
    let replayEntered; let resumeReplay; const replayBoundary = new Promise((resolve) => { replayEntered = resolve; });
    const replayResumed = new Promise((resolve) => { resumeReplay = resolve; });
    commitsUntilPause = 2; pauseAfterCommit = async () => { replayEntered(); await replayResumed; };
    const replayPromise = finance.metering.recordTransportAttempt(input(row));
    await Promise.race([replayBoundary, replayPromise.then(() => assert.fail("replay completed before the final owner COMMIT seam"))]);
    const concurrentObservation = recoveryObservation(row);
    try {
      assert.equal((await secondFinance.metering.recordUsageObservation({ ...input(row), observation: concurrentObservation })).status, "held_for_reconciliation");
      await secondFinance.metering.markOutcomeUnknown({ ...input(row), reason: "concurrent_owner_replay_unknown" });
    } finally { resumeReplay(); }
    assert.equal((await replayPromise).status, "recorded"); assert.equal(pauseAfterCommit, undefined, "actual final owner replay COMMIT seam was crossed");
    const recovered = read(row); assert.equal(recovered.dispatch_ack.status, "replay"); assert.equal(recovered.dispatch_ack.owner_revision, 2);
    assert.equal(recovered.state, "held_for_reconciliation"); assert.ok(recovered.recovery_reasons.includes("concurrent_owner_replay_unknown"));
    assert.deepEqual(recovered.observations.map((item) => item.source_observation_id), [observationId, concurrentObservation.source_observation_id]);
    assert.equal(JSON.stringify(recovered.dispatch_command), commandBytes); assert.equal(JSON.stringify(recovered.usage_request), usageBytes);
    assert.deepEqual(recovered.intake_receipt, intake.value); assert.deepEqual((await events(row)).map((event) => event.event_type), ["authorized", "dispatched"]);
    const pendingRow = await provision(); const priorObservation = randomUUID(); const nextObservation = randomUUID();
    const priorRequest = structuredClone(row.usage_request); Object.assign(priorRequest, { requestId: randomUUID(), idempotencyKey: `${priorObservation}:usage` });
    Object.assign(priorRequest.usageEvent, { event_id: randomUUID(), usage_event_id: randomUUID(), source_observation_id: priorObservation,
      logical_operation_id: pendingRow.attempt.logical_operation_id, provider_attempt_id: pendingRow.attempt.billable_attempt_id,
      billable_attempt_id: pendingRow.attempt.billable_attempt_id, transport_attempt_id: pendingRow.transport_id });
    const priorReceipt = await ingestUsage(priorRequest, retryPorts); assert.equal(priorReceipt.ok, true); assert.equal(priorReceipt.value.outboxStatus, "retry");
    const pendingRequest = structuredClone(priorRequest); Object.assign(pendingRequest, { requestId: randomUUID(), idempotencyKey: `${nextObservation}:usage` });
    Object.assign(pendingRequest.usageEvent, { event_id: randomUUID(), usage_event_id: randomUUID(), source_observation_id: nextObservation, supersedes_observation_id: priorObservation });
    const pendingReceipt = await ingestUsage(pendingRequest, ownerPorts); assert.equal(pendingReceipt.ok, true); assert.equal(pendingReceipt.value.durableCommit, true); assert.equal(pendingReceipt.value.outboxStatus, "pending");
    pendingRow.usage_request = pendingRequest; pendingRow.intake_receipt = pendingReceipt.value; write(pendingRow);
    const pendingObservation = { ...observation, logical_operation_id: pendingRow.attempt.logical_operation_id, billable_attempt_id: pendingRow.attempt.billable_attempt_id,
      transport_attempt_id: pendingRow.transport_id, source_observation_id: nextObservation };
    assert.equal((await finance.metering.recordUsageObservation({ ...input(pendingRow), observation: pendingObservation })).status, "held_for_reconciliation");
    assert.equal(read(pendingRow).intake_receipt.outboxStatus, "pending"); assert.equal(read(pendingRow).recovery_reason, "usage_outbox_pending");
    // A receipt that committed before a custody/session change cannot supply a
    // later local ACK. Real owner state stays durable; Product stays held.
    current.finance_service.source_authority_ref = ref("CreativeFinanceSource");
    await assert.rejects(finance.metering.recordUsageObservation({ ...input(pendingRow), observation: pendingObservation }));
    Object.assign(current, structuredClone(savedAuthority));
    await getStorage().deleteSession(hashToken(cookie));
    await assert.rejects(finance.metering.recordUsageObservation({ ...input(pendingRow), observation: pendingObservation }));
    await getStorage().createSession(hashToken(cookie), account.id, Date.now(), Date.now() + 60 * 60_000);
    assert.equal((await finance.metering.settleReservation({ ...input(row), source_observation_id: observationId })).status, "held_for_reconciliation");
    assert.equal((await finance.metering.releaseBeforeDispatch(input(absent))).status, "held_for_reconciliation");
    assert.deepEqual((await events(row)).map((event) => event.event_type), ["authorized", "dispatched"]);
    const actual = await readReservationSnapshot({ schemaVersion: "1.0.0", requestId: randomUUID(), scope, reservationId: row.reservation_id }, ownerPorts);
    assert.equal(actual.ok, true); assert.ok(Number(actual.value.heldAmount) > 0); assert.equal(Number(actual.value.effectiveConsumedAmount), 0); assert.equal(Number(actual.value.releasedAmount), 0); assert.equal(actual.value.usageFinality, "unknown");
    const queue = await admin.query("SELECT status FROM cost_intelligence.usage_intake_outbox WHERE billable_attempt_id=$1", [row.attempt.billable_attempt_id]); assert.equal(queue.rows[0].status, "retry");
    const ledger = await admin.query("SELECT count(*) AS count FROM cost_intelligence.financial_ledger_events WHERE tenant_id=$1", [scope.tenantId]); assert.equal(Number(ledger.rows[0].count), 0);
    t.diagnostic("Finance-first unavailable: zero Product admissions/provider writes; real SQL exact persisted dispatch replay ACK only, no duplicate money; concurrent second-request SQLite observations/receipts/unknown evidence survive final owner replay. Missing/uncommitted/divergent commands and stale/partial custody hold. Native recovery intake accepted/retry stays durable with unknown finality, zero consumption/release; no accepted CI05B/publication claim.");
  } catch (error) { failed = true; throw error; } finally {
    if (secondDatabase) secondDatabase.close(); if (database) database.close(); if (runtime) await runtime.end(); if (admin) await admin.end();
    let cleanupFailed = false; try { docker(["rm", "-f", name]); } catch { cleanupFailed = true; }
    unlinkSync(envFile);
    for (const key of Object.keys(process.env)) if (!(key in savedProcessEnvironment)) delete process.env[key]; Object.assign(process.env, savedProcessEnvironment);
    if (cleanupFailed) { t.diagnostic(`Owned PostgreSQL cleanup failed: ${name}; no shared daemon changed.`); if (!failed) assert.fail("Owned PostgreSQL cleanup failed"); }
  }
});
