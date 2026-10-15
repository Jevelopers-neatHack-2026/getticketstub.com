import "server-only";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { createCreativeApi } from "creative-engine/api/v1";
import { canonicalHash, normalizeResearchPackage } from "creative-engine/contracts";
import { createOpenRouterImagesProvider } from "creative-engine/models";
import { CreativeVersionStore, createCreativeVersionApiPorts } from "creative-engine/versions";
import { createSqliteTelemetryOutbox, USAGE_PROFILE } from "creative-engine/telemetry";
import { validateDecisionRequest, validateDecisionResult, decisionExecutionTargetHash } from "creative-engine/contracts/decision-port/v1";
import { validateMeteredAttempt } from "creative-engine/contracts/metering";
import { createJevDecisionPort } from "../vendor/agent-harness/src/decisions/index.js";
import { getRequestContext, requireCreativeCommissioningContext, assertCreativeCommissioningCurrent } from "../context";
import { HttpError } from "../http";
import { deployedCommit } from "../commit";
import { creativeHostConfig, currentProjectAuthority, providerCredentialPort, financeConnectionOptions, CreativeHostError } from "./config.mjs";
import { createCreativeFinance, initializeCreativeFinanceMapping, requireCreativeFinanceLifecycle } from "./finance.mjs";
import ceManifest from "../vendor/creative-engine/MANIFEST.json" with { type: "json" };
import ciManifest from "../vendor/cost-intelligence/MANIFEST.json" with { type: "json" };
import harnessManifest from "../vendor/agent-harness/MANIFEST.json" with { type: "json" };

const slots = globalThis.__ticketstubCreativeHostSlots ??= new Map();
const ENVIRONMENT = { production: "production", preview: "test", test: "test", development: "development" };
const MUTATIONS = new Set(["generate", "edit", "restore", "cancel", "brief.create"]);
const OPERATIONS = new Set([...MUTATIONS, "list", "compare", "job.status"]);
const opaque = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value);
const fail = (code = "creative_configuration_unavailable") => { throw new CreativeHostError(code); };

function hostSlot(config, env) {
  const identity = canonicalHash({ config, database_connection: env.TICKETSTUB_FINANCE_DATABASE_URL ?? "" });
  let slot = slots.get(identity);
  if (!slot) {
    // Configuration and connection rotation require a process restart. Keep
    // the qualified single-connection CE publication boundary intact.
    if ([...slots.values()].some((existing) => existing.databasePath === config.database_path)) fail();
    const pool = env.TICKETSTUB_FINANCE_DATABASE_URL?.trim() ? new Pool(financeConnectionOptions(env.TICKETSTUB_FINANCE_DATABASE_URL, config.environment)) : null;
    // Pool errors are content-free. Never log the connection URL or a driver's
    // error object, which can include connection parameters.
    pool?.on("error", () => {});
    const store = new CreativeVersionStore({ databasePath: config.database_path, objectRoot: config.object_root });
    initializeCreativeFinanceMapping(store.db);
    // One owner adapter/controller/serialization queue for this physical
    // connection. Request composition must not mint competing controllers.
    const adapter = createCreativeVersionApiPorts({ store, idFactory: () => randomUUID() });
    slot = { pool, store, adapter, identity, databasePath: config.database_path }; slots.set(identity, slot);
  }
  return slot;
}

/** Actual application composition. Commissioning uses a current staff session
 * plus a separately owner-issued service delegation. Customer Finance grants
 * are not inferred from the art.generate capability or a populated API key. */
export async function creativeHostForRequest(req, applicationProjectId, env = process.env) {
  const config = creativeHostConfig(env);
  if (!config) fail();
  const applicationCommit = deployedCommit(env, env.TICKETSTUB_BUILD_COMMIT);
  if (!opaque(applicationProjectId) || ENVIRONMENT[env.TICKETSTUB_OPS_ENVIRONMENT] !== config.environment || !/^[a-f0-9]{40}$/.test(applicationCommit ?? "")) fail();
  const platform = await getRequestContext(req);
  const scoped = await getRequestContext(req, { id: applicationProjectId, kind: "stub" });
  requireCreativeCommissioningContext(platform, scoped);
  if (platform.actor.kind !== "account" || scoped.actor.kind !== "account" || platform.actor.id !== scoped.actor.id || scoped.revoked) fail("creative_authority_unavailable");
  const applicationOwnerId = scoped.tenant.id;
  const actorId = platform.actor.id;
  const authority = () => currentProjectAuthority(config, applicationProjectId, applicationOwnerId, actorId);
  const requestAuthorityHash = canonicalHash(authority());
  const assertAuthorityCurrent = () => {
    // The final send fence is synchronous: no permit await can make a registry
    // snapshot stand in for current grant/delegation/permission/profile state.
    assertCreativeCommissioningCurrent(req, { platform, scoped });
    if (canonicalHash(authority()) !== requestAuthorityHash) {
      fail("creative_authority_unavailable");
    }
  };
  const currentContext = async () => {
    if (req.signal.aborted) throw new CreativeHostError("creative_cancelled", 409);
    const freshPlatform = await getRequestContext(req);
    const fresh = await getRequestContext(req, { id: applicationProjectId, kind: "stub" });
    requireCreativeCommissioningContext(freshPlatform, fresh);
    if (fresh.actor.kind !== "account" || fresh.actor.id !== actorId ||
        fresh.tenant.id !== applicationOwnerId || fresh.membershipRevision !== scoped.membershipRevision || fresh.revoked) fail("creative_authority_unavailable");
    return fresh;
  };
  const slot = hostSlot(config, env);
  const finance = createCreativeFinance({ database: slot.store.db, pool: slot.pool, authority, currentContext, assertCurrentContext: assertAuthorityCurrent,
    environment: config.environment, sourceRevision: applicationCommit });
  const capability = (input) => {
    const record = authority(); const access = record.image_access;
    if (!access.operations.includes(input.operation) || input.scope.tenant_id !== record.tenant_id || input.scope.project_id !== record.project_id ||
        input.attempt.budget_scope_id !== record.budget_scope_id || input.model !== access.model_id) fail("creative_capability_unavailable");
    return { status: "verified", eligible: true, revoked: false, operation_permission: "allowed", quota_status: "available", service: "openrouter",
      account_ref: access.account_ref, project_ref: access.project_ref, tenant_id: record.tenant_id, project_id: record.project_id,
      budget_scope_id: record.budget_scope_id, operation: input.operation, model: access.model_id, target_binding_sha256: input.target_binding_sha256,
      expires_at: access.expires_at, evidence_ref: access.evidence_ref, evidence_sha256: access.evidence_sha256 };
  };
  const provider = createOpenRouterImagesProvider({ ...config.image_profile,
    capabilityPort: { async verify(input) { await currentContext(); return capability(input); }, async revalidate(input) { await currentContext(); return capability(input); } },
    authorizationPort: finance.authorizationPort,
    credentialPort: providerCredentialPort(config, authority, env),
    promptPort: { render(input) {
      const facts = input.brief.facts.verified.map((fact) => `${fact.key}: ${fact.value}`).join("\n");
      const preferences = JSON.stringify(input.brief.preferences);
      const instruction = input.plan.steps?.find((step) => step.action === "image.edit")?.parameters?.instruction ?? "Create one ticket artwork concept.";
      return `${instruction}\nVerified brief facts:\n${facts}\nPreferences:\n${preferences}`.slice(0, 12_000);
    } },
    assetPort: { async readArtifact(input) {
      await currentContext();
      const record = authority();
      const current = await slot.adapter.storage.getCurrentDesignVersion({ scope: input.scope, brief_id: record.brief_id });
      const matches = (design) => design?.artifact.artifact_id === input.artifact_id && design.artifact.content_hash === input.content_hash && design.artifact.media_type === input.media_type;
      const design = matches(current) ? current : (await slot.adapter.storage.listDesignVersions({ scope: input.scope, brief_id: record.brief_id, limit: 100 })).items.find(matches);
      if (!design) fail("creative_asset_unavailable");
      return slot.adapter.storage.getArtifactBytes({ scope: input.scope, brief_id: record.brief_id, design_version_id: design.design_version_id });
    } },
  });
  const planning = {
    getCurrentResearchPackage() {
      const record = authority();
      return normalizeResearchPackage(record.research_package, { tenant_id: record.tenant_id, project_id: record.project_id });
    },
    assetPermissionVerifier: {
      async verifyAssetUse(input) {
        await currentContext(); const record = authority();
        const evidence = record.asset_permissions.find((item) => item.asset_id === input.asset_id && item.content_hash === input.content_hash && item.action === input.action &&
          item.package_id === input.package_id && item.package_hash === input.package_hash);
        if (!evidence || input.tenant_id !== record.tenant_id || input.project_id !== record.project_id) return { status: "denied" };
        return { status: "granted", owner_evidence_status: "verified", ...input, expires_at: evidence.expires_at, evidence_ref: evidence.evidence_ref,
          checked_at: new Date().toISOString() };
      },
    },
  };
  let resolvedDecisionPort;
  let resolvedDecisionAccess;
  const assertDecisionAccess = () => {
    const access = authority().decision_access;
    if (!access || !resolvedDecisionAccess || canonicalHash(access) !== canonicalHash(resolvedDecisionAccess)) fail("creative_decision_authority_unavailable");
  };
  const decisionPort = {
    async resolveRoute(input) {
      await currentContext();
      const access = authority().decision_access;
      if (!access) fail("creative_decision_authority_unavailable");
      resolvedDecisionAccess = access;
      resolvedDecisionPort = createJevDecisionPort({ apiKey: env.TYPESAFE_API_KEY, environment: config.environment,
        eligibility: { provider: access.provider, model: access.model, environment: access.environment, accountRef: access.accountRef,
          projectRef: access.projectRef, evidenceRef: access.evidenceRef, expiresAt: access.expiresAt, eligible: access.eligible },
        contracts: { validateDecisionRequest, validateDecisionResult, validateMeteredAttempt, decisionExecutionTargetHash } });
      return resolvedDecisionPort.resolveRoute(input);
    },
    async execute(input) {
      await currentContext(); assertDecisionAccess();
      return resolvedDecisionPort.execute({ ...input,
        async revalidateDispatch(binding) {
          await currentContext(); assertDecisionAccess();
          await finance.revalidateDecision(binding);
          return input.revalidateDispatch(binding);
        },
        assertDispatchCurrent() { assertDecisionAccess(); return input.assertDispatchCurrent(); },
      });
    },
  };
  const adapted = slot.adapter;
  const authorizeDispatch = adapted.ports.jobs.authorizeDispatch;
  const assertDispatchCurrent = adapted.ports.jobs.assertDispatchCurrent;
  const ports = { ...adapted.ports, provider, decisionPort, metering: finance.metering,
    planning: { ...adapted.ports.planning, ...planning },
    jobs: { ...adapted.ports.jobs,
      async authorizeDispatch(input) { await currentContext(); assertAuthorityCurrent(); const answer = await authorizeDispatch(input); finance.bindDispatchIntent(input, answer); return answer; },
      assertDispatchCurrent(input) { const answer = assertDispatchCurrent(input); assertAuthorityCurrent(); return answer; },
    },
    telemetry: { outbox: createSqliteTelemetryOutbox({ database: slot.store.db, idFactory: () => randomUUID() }),
      modes: { provider_execution_mode: "live", commerce_mode: "unknown" },
      usage_profiles: { image_generation: USAGE_PROFILE.OPENAI_GPT_IMAGE_1, image_edit: USAGE_PROFILE.OPENAI_GPT_IMAGE_1, jev_decision: USAGE_PROFILE.TYPESAFE_DECISION },
      usage_profile_authority: finance.usageProfileAuthority },
  };
  const api = createCreativeApi({ ports, idFactory: () => randomUUID() });
  const source_manifest = Object.freeze({ application: applicationCommit, agent_harness: harnessManifest.commit,
    creative_engine: ceManifest.commit, finance: ciManifest.commit });
  return {
    environment: config.environment, source_manifest,
    async invoke(body) {
      if (!body || typeof body !== "object" || Object.keys(body).some((key) => !["projectId", "operation", "actionId", "payload", "sourceRefs", "environment"].includes(key)) ||
          body.projectId !== applicationProjectId || !OPERATIONS.has(body.operation) || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(body.actionId ?? "") ||
          body.environment !== undefined && body.environment !== config.environment ||
          !body.payload || typeof body.payload !== "object" || Array.isArray(body.payload) ||
          body.sourceRefs !== undefined && (!Array.isArray(body.sourceRefs) || body.sourceRefs.length > 100 || !body.sourceRefs.every(opaque))) {
        throw new HttpError(400, "invalid_request", "Send a creative operation and its existing project references.");
      }
      await currentContext(); const record = authority();
      // Finance-first: no registry, environment, key or offline fixture can
      // approve the unaccepted public lifecycle of the current pinned owner.
      if (["generate", "edit"].includes(body.operation)) requireCreativeFinanceLifecycle();
      if (body.payload.brief_id !== undefined && body.payload.brief_id !== record.brief_id) throw new HttpError(403, "scope_denied", "That brief is outside this project.");
      const occurred_at = new Date().toISOString();
      const principal = { actor_id: `account:${actorId}`, tenant_id: record.tenant_id, project_id: record.project_id,
        expires_at: new Date(Math.min(Date.parse(record.expires_at), Date.parse(scoped.expiresAt))).toISOString(), permissions: record.permissions,
        budget_scope_id: record.budget_scope_id, budget_policy_version: "ci-budget-policy-1.0.0" };
      return api.invoke(principal, { contract: "CreativeApiRequest", schema_version: "1.0", event_id: randomUUID(), request_id: randomUUID(),
        tenant_id: record.tenant_id, project_id: record.project_id, correlation_id: randomUUID(), producer: "ticketstub-creative-host",
        occurred_at, ingested_at: occurred_at, environment: config.environment, billing_mode: "live", source_refs: body.sourceRefs ?? [],
        operation: body.operation, action_id: body.actionId, payload: body.payload });
    },
    // Private lifecycle for offline host tests and controlled process shutdown;
    // neither is part of a browser response.
    store: slot.store,
    async close() { slots.delete(slot.identity); slot.store.close(); await slot.pool?.end(); },
  };
}
