import "server-only";
import { randomUUID } from "node:crypto";
import { canonicalHash } from "creative-engine/contracts";
import { validateUsageObservation } from "creative-engine/contracts/metering";
import { markReservationDispatched, readReservationSnapshot, revalidateReservation, budgetDigest } from "@jevelopers/cost-intelligence/budgets";
import { CreativeHostError } from "./config.mjs";

const same = (left, right) => canonicalHash(left) === canonicalHash(right);
const required = (value) => { if (!value) throw new CreativeHostError("creative_finance_unavailable"); return value; };
const resultValue = (result) => required(result?.ok) && result.value;

/** The pinned Finance public CI05B lifecycle and exact consumer custody ACK are
 * not released. This has no configuration, environment or test override.
 * Replacing it requires the accepted owner release and a reviewed consumer. */
export function requireCreativeFinanceLifecycle() {
  throw new CreativeHostError("creative_finance_lifecycle_unavailable");
}

/** Evidence snapshot for comparing held custody; never an acceptance grant. */
export function creativeFinanceCustodySnapshot(entry, attempt) {
  return structuredClone({ tenant_id: entry.tenant_id, project_id: entry.project_id, budget_scope_id: entry.budget_scope_id,
    finance_service: entry.finance_service, budget_policy_ref: entry.budget_policy_ref,
    maximum: entry.maximums[attempt.operation_kind],
    access: attempt.provider.name === "openrouter" ? entry.image_access : entry.decision_access,
    usage_profile: attempt.provider.name === "openrouter" ? entry.usage_profile ?? null : null,
    decision_pricing: attempt.provider.name === "typesafe" ? entry.decision_pricing ?? null : null });
}

export function initializeCreativeFinanceMapping(database) {
  required(!database.isTransaction);
  database.exec(`CREATE TABLE IF NOT EXISTS ticketstub_creative_attempts (
    billable_attempt_id TEXT PRIMARY KEY, state TEXT NOT NULL
  ); CREATE TABLE IF NOT EXISTS ticketstub_creative_finance_sources (
    request_digest TEXT PRIMARY KEY, billable_attempt_id TEXT NOT NULL,
    source_ref TEXT NOT NULL, maximum TEXT
  )`);
}

/** Disabled admission plus bounded recovery of already persisted commands.
 * PostgreSQL remains the authority; local rows/digests cannot mint acceptance. */
export function createCreativeFinance({ database, pool, authority, currentContext, assertCurrentContext, environment, now = Date.now }) {
  const load = (billable) => {
    required(!database.isTransaction);
    const found = database.prepare("SELECT state FROM ticketstub_creative_attempts WHERE billable_attempt_id=?").get(billable);
    return found ? JSON.parse(found.state) : null;
  };
  const loadByReservation = (input) => {
    const row = required(load(input.billable_attempt_id));
    required(row.reservation_id === input.reservation_id && row.attempt.logical_operation_id === input.logical_operation_id && row.binding.leaseRef === input.lease_id);
    return row;
  };
  const timestamp = () => new Date(now()).toISOString();
  const scope = (entry) => ({ tenantId: entry.tenant_id, projectId: entry.project_id, environment, billingMode: "live", actorId: entry.finance_service.actor_id });
  const fresh = async () => { await currentContext(); required(typeof assertCurrentContext === "function"); assertCurrentContext(); return authority(); };
  const assertCustody = (row, entry) => {
    const access = row.attempt.provider.name === "openrouter" ? entry.image_access : entry.decision_access;
    const image = row.attempt.provider.name === "openrouter";
    const heldAccess = image ? access : { account_ref: access?.accountRef, project_ref: access?.projectRef, grant_ref: access?.grantRef,
      evidence_ref: access?.evidenceRef, evidence_sha256: access?.evidenceSha256, expires_at: access?.expiresAt };
    const operation = row.attempt.operation_kind === "image_generation" ? "generate" : row.attempt.operation_kind === "image_edit" ? "edit" : "decision";
    required(row.custody && same(row.custody, creativeFinanceCustodySnapshot(entry, row.attempt)) && same(row.scope, scope(entry)) &&
      same(row.source_ref, entry.finance_service.source_authority_ref) && same(row.reserve_request?.sourceAuthorityRef, entry.finance_service.source_authority_ref) &&
      same(row.reserve_request?.canonicalRequest.policy_ref, entry.budget_policy_ref) && same(row.maximum, entry.maximums[row.attempt.operation_kind]) &&
      same(row.access, heldAccess) && same(row.binding, row.reserve_request?.authorityBinding) && same(row.attempt_binding, row.reserve_request?.attemptBinding) &&
      row.binding.budgetScopeId === entry.budget_scope_id && row.attempt.budget_scope_id === entry.budget_scope_id &&
      row.binding.provider === row.attempt.provider.name && row.binding.model === row.attempt.provider.model && row.binding.operation === operation &&
      row.binding.provider === (image ? access?.service : access?.provider) && row.binding.model === (image ? access?.model_id : access?.model) &&
      row.binding.accountRef === (image ? access?.account_ref : access?.accountRef) && row.binding.projectRef === (image ? access?.project_ref : access?.projectRef) &&
      row.binding.grantRef === (image ? access?.grant_ref : access?.grantRef) && access?.eligible === true &&
      (!image || access.quota_status === "available" && access.operations.includes(operation)));
    return entry;
  };
  const freshCustody = async (row) => assertCustody(row, await fresh());
  // Re-read the private owner source synchronously after every awaited boundary.
  // This is a comparison against held custody, not a new decision authority.
  const currentCustody = (row) => { required(typeof assertCurrentContext === "function"); assertCurrentContext(); return assertCustody(row, authority()); };
  const identity = (row) => Object.fromEntries(["attempt", "scope", "access", "maximum", "source_ref", "custody", "binding", "attempt_binding", "reserve_request",
    "reservation_id", "held_amount", "transport_id", "dispatch_ref", "dispatch_command", "common"].map((key) => [key, row[key] ?? null]));
  // Reload and merge after async owner checks. The exact-byte CAS also protects
  // distinct request instances/connections sharing this physical SQLite file.
  // No callback may await, and no successful ACK precedes its durable update.
  const mutate = (expected, update, checkCurrent = false) => {
    for (let retries = 0; retries < 8; retries += 1) {
      required(!database.isTransaction);
      const found = required(database.prepare("SELECT state FROM ticketstub_creative_attempts WHERE billable_attempt_id=?").get(expected.attempt.billable_attempt_id));
      const row = JSON.parse(found.state); required(same(identity(row), identity(expected)));
      if (checkCurrent) currentCustody(row);
      const result = update(row);
      const written = database.prepare("UPDATE ticketstub_creative_attempts SET state=? WHERE billable_attempt_id=? AND state=?")
        .run(JSON.stringify(row), row.attempt.billable_attempt_id, found.state);
      if (written.changes === 1) return result;
    }
    throw new CreativeHostError("creative_finance_unavailable");
  };
  const markHeld = (row, reason) => {
    row.state = "held_for_reconciliation";
    row.recovery_reasons ??= row.recovery_reason ? [row.recovery_reason] : [];
    if (!row.recovery_reasons.includes(reason)) row.recovery_reasons.push(reason);
    row.recovery_reason = reason;
    return { status: "held_for_reconciliation", reservation_id: row.reservation_id };
  };
  const hold = (row, reason) => mutate(row, (current) => markHeld(current, reason));
  const ports = {
    database: pool, clock: { now: () => new Date(now()) }, authorityWaitMs: 2000,
    trustedContext: { async resolve(requested) { const entry = await fresh(); return same(requested, scope(entry)) ? requested : null; } },
    financeAuthority: { async authorizeCurrent(input) {
      const entry = await fresh();
      if (!same(input.requestedScope, scope(entry)) || !entry.finance_service.operations.includes(input.operation)) return null;
      return { status: "allowed", decisionId: entry.finance_service.evidence_ref, operation: input.operation, permission: input.permission,
        scope: input.requestedScope, principal: { kind: "service", actorId: entry.finance_service.actor_id, serviceStatus: "active", serviceGrantRevision: entry.finance_service.grant_revision },
        verifiedAt: timestamp(), expiresAt: new Date(Math.min(now() + 60_000, Date.parse(entry.expires_at), Date.parse(entry.finance_service.expires_at))).toISOString() };
    } },
    reservationAuthority: { async verifyCurrent(query) {
      const row = load(query.billableAttemptId); if (!row) return null;
      try {
        await freshCustody(row);
        required(same(query.scope, row.scope) && same(query.binding, row.binding) && same(query.sourceAuthorityRef, row.source_ref) &&
          (!query.reservationId || query.reservationId === row.reservation_id) && (!query.transportAttemptId || query.transportAttemptId === row.transport_id) &&
          (!query.dispatchIntentRef || same(query.dispatchIntentRef, row.dispatch_ref)));
        const queryDigest = await budgetDigest(query); await freshCustody(row); currentCustody(row);
        return { status: "allowed", revoked: false, queryDigest, verifiedAt: timestamp(), expiresAt: row.binding.leaseExpiresAt,
          evidenceRef: row.access.evidence_ref, evidenceSha256: row.access.evidence_sha256 };
      } catch { return null; }
    } },
    budgetEvidence: { async verifyCurrent(query) {
      required(!database.isTransaction);
      const found = database.prepare("SELECT * FROM ticketstub_creative_finance_sources WHERE request_digest=?").get(query.requestDigest);
      if (!found) return null;
      const row = load(found.billable_attempt_id); if (!row) return null;
      try {
        await freshCustody(row);
        required(same(query.scope, row.scope) && same(query.sourceAuthorityRef, row.source_ref) && same(JSON.parse(found.source_ref), row.source_ref));
        const queryDigest = await budgetDigest(query); await freshCustody(row); currentCustody(row);
        return { status: "verified", queryDigest, verifiedAt: timestamp(), expiresAt: new Date(Math.min(Date.parse(row.maximum.expires_at), Date.parse(row.custody.finance_service.expires_at))).toISOString(),
          ...(found.maximum ? { maximum: JSON.parse(found.maximum) } : {}) };
      } catch { return null; }
    } },
  };
  const snapshot = async (row) => {
    await freshCustody(row);
    const value = resultValue(await readReservationSnapshot({ schemaVersion: "1.0.0", requestId: randomUUID(), scope: row.scope, reservationId: row.reservation_id }, ports));
    await freshCustody(row); currentCustody(row);
    required(value.reservation.billable_attempt_id === row.attempt.billable_attempt_id && same(value.attemptBinding, row.attempt_binding) &&
      same(value.reservation.authority_ref, row.source_ref) && value.reservation.budget_scope_id === row.attempt.budget_scope_id);
    return value;
  };
  const metering = {
    async reserveAttempt() { requireCreativeFinanceLifecycle(); },
    async markAttemptInFlight(input) { return hold(loadByReservation(input), "finance_lifecycle_unavailable"); },
    async recordTransportAttempt(input) {
      const row = loadByReservation(input); const command = row.dispatch_command;
      if (!command || input.transport_attempt_id !== row.transport_id) return hold(row, "dispatch_recovery_evidence_unavailable");
      const before = await snapshot(row);
      // An old expected revision cannot append a new event. Only the owner's
      // exact persisted-command replay outcome can acknowledge this recovery.
      if (before.state !== "dispatched" || !Number.isSafeInteger(command.expectedRevision) || command.expectedRevision >= before.expectedRevision ||
          command.reservationId !== row.reservation_id || !same(command.attemptBinding, row.attempt_binding) || !same(command.sourceAuthorityRef, row.source_ref) ||
          !same(command.dispatchIntentRef, row.dispatch_ref)) return hold(row, "dispatch_recovery_evidence_unavailable");
      const bytes = JSON.stringify(command);
      const result = await markReservationDispatched(command, ports);
      await freshCustody(row); currentCustody(row);
      required(JSON.stringify(row.dispatch_command) === bytes);
      if (!result.ok || result.value.status !== "replay" || result.value.reservationId !== row.reservation_id || result.value.state !== "dispatched" ||
          result.value.revision !== before.expectedRevision || Number(result.value.outstandingHold) <= 0) return hold(row, "dispatch_recovery_not_replayed");
      return mutate(row, (current) => {
        required(JSON.stringify(current.dispatch_command) === bytes);
        current.dispatch_ack = { status: "replay", owner_revision: result.value.revision };
        // A replay ACK does not resolve concurrent unknown usage or custody.
        if (current.state !== "held_for_reconciliation") current.state = "dispatched";
        return { status: "recorded" };
      }, true);
    },
    async recordUsageObservation(input) {
      const row = loadByReservation(input); const observation = validateUsageObservation(input.observation, row.attempt);
      await freshCustody(row); currentCustody(row);
      return mutate(row, (current) => {
        current.observations ??= current.observation ? [current.observation] : [];
        const previous = current.observations.find((item) => item.source_observation_id === observation.source_observation_id);
        if (previous) required(same(previous, observation)); else current.observations.push(observation);
        current.observation ??= observation;
        // Preserve original observations, persisted requests and real old intake
        // receipts. None supplies the unreleased native custody/adoption ACK.
        // No UUID/model/quote projection, expense post or outbox drain occurs.
        return markHeld(current, ["pending", "retry"].includes(current.intake_receipt?.outboxStatus) ? "usage_outbox_pending" : "public_intake_custody_unavailable");
      }, true);
    },
    async settleReservation(input) { return hold(loadByReservation(input), "public_settlement_unavailable"); },
    async releaseBeforeDispatch(input) { return hold(loadByReservation(input), "public_release_unavailable"); },
    async markOutcomeUnknown(input) { return hold(loadByReservation(input), String(input.reason).slice(0, 80)); },
  };
  const revalidate = async (input) => {
    const row = required(load(input.billable_attempt_id)); await freshCustody(row);
    required(row.reservation_id === input.reservation_ref && row.binding.targetBindingSha256 === input.target_binding_sha256);
    const value = resultValue(await revalidateReservation({ schemaVersion: "1.0.0", requestId: randomUUID(), scope: row.scope, reservationId: row.reservation_id,
      attemptBinding: row.attempt_binding, authorityBinding: row.binding, phase: row.state === "dispatched" ? "post_transport_ack" : "preparation",
      ...(row.state === "dispatched" ? { dispatchIntentRef: row.dispatch_ref, transportAttemptId: row.transport_id } : {}) }, ports));
    await freshCustody(row); currentCustody(row); required(value.status === "authorized" && value.finance); return { row, value };
  };
  return {
    metering,
    bindDispatchIntent() { requireCreativeFinanceLifecycle(); },
    authorizationPort: { async revalidate() { requireCreativeFinanceLifecycle(); } },
    async revalidateDecision() { requireCreativeFinanceLifecycle(); },
    async readRecoveryState(input) { const row = loadByReservation(input); return snapshot(row); },
    async verifyRecoveryAuthorization(input) { return (await revalidate(input)).value.snapshot; },
    usageProfileAuthority: { async mapProviderUsage() { return { status: "unknown" }; } },
  };
}
