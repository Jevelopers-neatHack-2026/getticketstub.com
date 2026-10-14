import "server-only";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { canonicalHash } from "creative-engine/contracts";

export class CreativeHostError extends Error {
  constructor(code = "creative_configuration_unavailable", status = 503) {
    super(code === "creative_finance_lifecycle_unavailable"
      ? "Creative execution is unavailable until the Finance lifecycle and consumer custody interface are accepted."
      : "Creative execution is unavailable until its trusted host configuration is complete.");
    this.name = "CreativeHostError";
    this.code = code;
    this.status = status;
  }
}
const fail = () => { throw new CreativeHostError(); };
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const opaque = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value);
const uuid = (value) => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
const hash = (value) => typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
const current = (value, now) => typeof value === "string" && Number.isFinite(Date.parse(value)) && Date.parse(value) > now;
const exact = (value, required, optional = []) => record(value) && required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
const array = (value, check, max = 100) => Array.isArray(value) && value.length <= max && value.every(check);
const ref = (value) => exact(value, ["contract", "schema_version", "id", "revision", "content_hash"]) && opaque(value.contract) && value.schema_version === "1.0.0" && uuid(value.id) && Number.isSafeInteger(value.revision) && value.revision >= 0 && hash(value.content_hash);
const amount = (value) => typeof value === "string" && /^(?:0|[1-9]\d*)(?:\.\d{1,9})?$/.test(value) && value.length <= 32 && Number(value) > 0;
const PATHS = ["database_path", "object_root", "registry_path"];

/** Parse once, then pass explicit options to pg. Its connectionString parser
 * otherwise overrides TLS/timeouts and can read certificate paths from URLs. */
export function financeConnectionOptions(raw, environment) {
  let parsed;
  try {
    parsed = new URL(raw?.trim());
    if (!["postgres:", "postgresql:"].includes(parsed.protocol) || parsed.search || parsed.hash || !parsed.hostname ||
        !parsed.username || !parsed.password || parsed.pathname.length < 2 || !["development", "test", "production"].includes(environment)) fail();
    return { host: parsed.hostname.replace(/^\[|\]$/g, ""), port: parsed.port ? Number(parsed.port) : 5432,
      user: decodeURIComponent(parsed.username), password: decodeURIComponent(parsed.password), database: decodeURIComponent(parsed.pathname.slice(1)),
      max: 4, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 2_000, statement_timeout: 5_000,
      ssl: environment === "production" ? { rejectUnauthorized: true } : false };
  } catch { fail(); }
}

/** Operational settings are grouped; credential values are separate server secrets. */
export function creativeHostConfig(env = process.env) {
  const raw = env.TICKETSTUB_CREATIVE_CONFIG?.trim();
  if (!raw) return null;
  if (raw.length > 64 * 1024) fail();
  let value;
  try { value = JSON.parse(raw); } catch { fail(); }
  if (!exact(value, ["schema_version", "environment", ...PATHS, "image_profile"]) || value.schema_version !== "ticketstub.creative-host/1" ||
      !["development", "test", "production"].includes(value.environment) || PATHS.some((key) => typeof value[key] !== "string" || !isAbsolute(value[key])) ||
      !record(value.image_profile) || !exact(value.image_profile, ["model_id", "provider_tag", "capabilities", "supported_parameters", "configuration"])) fail();
  return Object.freeze(value);
}

/** Private-volume registry: current owner-issued delegation, eligibility and Research evidence.
 * Request bodies never install these records. Symlinks and group/world-writable files fail closed. */
export function readAuthorityRegistry(config) {
  let value; let descriptor;
  try {
    const parent = lstatSync(dirname(config.registry_path));
    if (!parent.isDirectory() || parent.isSymbolicLink() || parent.mode & 0o022 ||
        typeof process.getuid === "function" && parent.uid !== process.getuid() && parent.uid !== 0) fail();
    descriptor = openSync(config.registry_path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024 || stat.mode & 0o022 ||
        typeof process.getuid === "function" && stat.uid !== process.getuid() && stat.uid !== 0) fail();
    const bytes = readFileSync(descriptor);
    if (bytes.length > 4 * 1024 * 1024) fail();
    value = JSON.parse(bytes.toString("utf8"));
  } catch { fail(); } finally { if (descriptor !== undefined) closeSync(descriptor); }
  if (!exact(value, ["schema_version", "projects"]) || value.schema_version !== "ticketstub.creative-authority/1" || !array(value.projects, record, 1000)) fail();
  return value;
}

export function currentProjectAuthority(config, applicationProjectId, applicationOwnerId, actorId, now = Date.now()) {
  if (!Number.isFinite(now)) fail();
  const matches = readAuthorityRegistry(config).projects.filter((entry) => entry.application_project_id === applicationProjectId);
  if (matches.length !== 1) throw new CreativeHostError("creative_authority_unavailable");
  const value = matches[0];
  if (!exact(value, ["application_project_id", "application_owner_id", "brief_id", "tenant_id", "project_id", "budget_scope_id", "allowed_actor_ids", "expires_at", "permissions", "finance_service", "image_access", "maximums", "budget_policy_ref", "research_package", "asset_permissions"], ["decision_access", "decision_pricing", "usage_profile"]) ||
      value.application_owner_id !== applicationOwnerId || !array(value.allowed_actor_ids, opaque) || !value.allowed_actor_ids.includes(actorId) ||
      !opaque(value.brief_id) || ![value.tenant_id, value.project_id, value.budget_scope_id].every(uuid) || !current(value.expires_at, now) ||
      !array(value.permissions, (item) => ["creative.generate", "creative.edit", "creative.read", "creative.cancel", "creative.restore", "creative.brief.create"].includes(item)) || !ref(value.budget_policy_ref) || !record(value.research_package)) {
    throw new CreativeHostError("creative_authority_unavailable");
  }
  const service = value.finance_service;
  if (!exact(service, ["actor_id", "grant_revision", "operations", "evidence_ref", "evidence_sha256", "source_authority_ref", "expires_at"]) ||
      ![service.actor_id, service.grant_revision, service.evidence_ref].every(opaque) || !hash(service.evidence_sha256) || !ref(service.source_authority_ref) ||
      !array(service.operations, (item) => ["budgets.authorize", "budgets.markDispatched", "budgets.readReservation", "budgets.release", "budgets.settle", "metering.ingestUsage", "pricing.estimateV2"].includes(item)) || !current(service.expires_at, now)) fail();
  const access = value.image_access;
  if (!exact(access, ["service", "model_id", "provider_tag", "account_ref", "project_ref", "grant_ref", "eligible", "quota_status", "operations", "evidence_ref", "evidence_sha256", "expires_at", "profile_sha256"]) ||
      access.service !== "openrouter" || access.model_id !== config.image_profile.model_id || access.provider_tag !== config.image_profile.provider_tag ||
      access.profile_sha256 !== canonicalHash(config.image_profile) || access.eligible !== true || access.quota_status !== "available" ||
      ![access.account_ref, access.project_ref, access.grant_ref, access.evidence_ref].every(opaque) || !hash(access.evidence_sha256) ||
      !array(access.operations, (item) => ["generate", "edit"].includes(item), 2) || !current(access.expires_at, now)) fail();
  if (!record(value.maximums) || Object.keys(value.maximums).some((key) => !["image_generation", "image_edit", "jev_decision"].includes(key))) fail();
  for (const maximum of Object.values(value.maximums)) {
    if (!exact(maximum, ["amount", "policy_ref", "evidence_ref", "evidence_sha256", "expires_at"]) || !amount(maximum.amount) || !ref(maximum.policy_ref) ||
        !opaque(maximum.evidence_ref) || !hash(maximum.evidence_sha256) || !current(maximum.expires_at, now)) fail();
  }
  if (!array(value.asset_permissions, (entry) => exact(entry, ["asset_id", "content_hash", "action", "package_id", "package_hash", "evidence_ref", "expires_at"]) &&
      [entry.asset_id, entry.package_id, entry.evidence_ref].every(opaque) && hash(entry.content_hash) && hash(entry.package_hash) &&
      ["modify", "reproduce"].includes(entry.action) && current(entry.expires_at, now))) fail();
  if (value.decision_access !== undefined) {
    const access = value.decision_access;
    if (!exact(access, ["provider", "model", "environment", "accountRef", "projectRef", "grantRef", "evidenceRef", "evidenceSha256", "expiresAt", "eligible"]) ||
        access.provider !== "typesafe" || access.model !== "jev-1.13.0" || access.environment !== config.environment || access.eligible !== true ||
        ![access.accountRef, access.projectRef, access.grantRef, access.evidenceRef].every(opaque) || !hash(access.evidenceSha256) || !current(access.expiresAt, now)) fail();
  }
  if (value.decision_pricing !== undefined) {
    const pricing = value.decision_pricing;
    if (!exact(pricing, ["product", "rate_card_ref", "allow_estimate_receipt_ref", "source_authority_ref", "expires_at"]) || !opaque(pricing.product) ||
        pricing.allow_estimate_receipt_ref !== true || !ref(pricing.source_authority_ref) || !current(pricing.expires_at, now) ||
        !exact(pricing.rate_card_ref, ["contract", "schema_version", "id", "revision", "content_hash"]) || pricing.rate_card_ref.contract !== "RateCard" ||
        pricing.rate_card_ref.schema_version !== "2.0.0" || !uuid(pricing.rate_card_ref.id) || !Number.isSafeInteger(pricing.rate_card_ref.revision) || pricing.rate_card_ref.revision < 1 || !hash(pricing.rate_card_ref.content_hash)) fail();
  }
  if (value.usage_profile !== undefined) {
    const profile = value.usage_profile;
    if (!exact(profile, ["ref", "sha256", "mapping", "source_authority_ref", "expires_at"]) || !opaque(profile.ref) || !hash(profile.sha256) || !ref(profile.source_authority_ref) || !current(profile.expires_at, now) ||
        !exact(profile.mapping, ["schema_version", "model_id", "finance_model_compatibility_id", "provider_tag", "budget_consumption_basis", "essential_fields"]) ||
        profile.mapping.schema_version !== "ticketstub.openrouter-image-usage/1" || profile.mapping.model_id !== access.model_id || profile.mapping.provider_tag !== access.provider_tag ||
        typeof profile.mapping.finance_model_compatibility_id !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(profile.mapping.finance_model_compatibility_id) ||
        profile.mapping.budget_consumption_basis !== "provider_reported_unsettled" ||
        JSON.stringify(profile.mapping.essential_fields) !== JSON.stringify(["input_tokens", "output_tokens", "total_tokens", "cost"]) || canonicalHash(profile.mapping) !== profile.sha256) fail();
  }
  return Object.freeze(value);
}

export function providerCredentialPort(config, authority, env = process.env, now = Date.now) {
  return {
    resolveCredential(input) {
      const record = authority();
      const access = record.image_access;
      const token = env.CREATIVE_ENGINE_OPENROUTER_API_KEY?.trim();
      if (!token || input.service !== "openrouter" || input.scope?.tenant_id !== record.tenant_id || input.scope?.project_id !== record.project_id ||
          input.account_ref !== access.account_ref || input.project_ref !== access.project_ref || input.grant_ref !== access.grant_ref ||
          !hash(input.target_binding_sha256) || !current(input.deadline_at, now())) throw new CreativeHostError("creative_credential_unavailable");
      return { status: "resolved", token, binding: { service: "openrouter", account_ref: access.account_ref, project_ref: access.project_ref,
        grant_ref: access.grant_ref, target_binding_sha256: input.target_binding_sha256 },
        provider_scope: { organization_id: access.account_ref, project_id: access.project_ref },
        expires_at: new Date(Math.min(Date.parse(input.deadline_at), Date.parse(access.expires_at))).toISOString(),
        evidence: { ref: access.evidence_ref, sha256: access.evidence_sha256 } };
    },
  };
}
