import { requireSourceIdentity, sourceReference, sourceHiddenFields } from "../facts/identity";
// Pure mapping between the studio's types/edits and creative-engine v1.0 contracts. No I/O, no runtime calls.
// Swapping /api/art to creative-engine later means /api/art/route.ts calls toArtEditRequest() and fromDesignVersion().
// Anything the engine needs that we cannot supply yet is a PENDING_ placeholder (see contracts.ts), never a fake value.
import { currentVersion } from "../types";
import type { ArtLayer, DesignVersion as StudioVersion, Edition, Finish, Material, Provenance, Stub } from "../types";
import { studioControls, validateControl } from "./controls";
import { pending } from "./contracts";
import type {
  BillingMode,
  BriefCreatePayload,
  CommonEnvelope,
  CreativeApiRequest,
  CreativeBrief,
  CreativeOperation,
  DesignVersion,
  EditPlan,
  EditStep,
  Environment,
  PayloadOf,
  TrustedCreativeActor,
} from "./contracts";

export interface CreativeScope {
  tenantId: string;
  projectId: string;
  correlationId: string;
  /** The signed-in account. The engine takes the actor from the application, never from the request envelope. */
  actor: { actorId: string; permissions?: string[] };
  environment?: Environment; // default "development"
  billingMode?: BillingMode; // default "simulated"
  producer?: string; // default "ticketstub-studio"
  /** Injectable for deterministic tests. */
  now?: () => string;
  newId?: (kind: string) => string;
}

const nowIso = (s: CreativeScope) => (s.now ? s.now() : new Date().toISOString());
const newId = (s: CreativeScope, kind: string) =>
  s.newId ? s.newId(kind) : `${kind}-${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
/** creative-engine validId: [a-zA-Z0-9_-]{1,100}. */
const safeId = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 100) || "x";
const slug = (s: string) => safeId(s.toLowerCase());

function envelope(scope: CreativeScope, sourceRefs: string[]): Omit<CommonEnvelope, "contract" | "schema_version"> {
  const t = nowIso(scope);
  return {
    event_id: newId(scope, "event"),
    tenant_id: scope.tenantId,
    project_id: scope.projectId,
    correlation_id: scope.correlationId,
    producer: scope.producer ?? "ticketstub-studio",
    occurred_at: t,
    ingested_at: t,
    environment: scope.environment ?? "development",
    billing_mode: scope.billingMode ?? "simulated",
    source_refs: sourceRefs,
  };
}

export const briefIdFor = (stub: Stub) => `brief-${safeId(stub.id)}`;
export const artifactIdFor = (versionId: string) => `artifact-${safeId(versionId)}`;
const EVENT_SOURCE = "event-page";

interface SourceRow {
  source_id: string;
  uri: string;
}

function sourcesOf(stub: Stub): SourceRow[] {
  const rows = new Map<string, SourceRow>();
  rows.set(EVENT_SOURCE, { source_id: EVENT_SOURCE, uri: stub.event.sourceUrl ?? pending("source_uri") });
  for (const f of stub.event.facts) {
    const id = slug(f.source);
    if (!rows.has(id)) rows.set(id, { source_id: id, uri: f.sourceUrl ?? pending("source_uri") });
  }
  return [...rows.values()];
}

const sourceRefsOf = (stub: Stub) => sourcesOf(stub).map((s) => `source:${s.source_id}`);

/** A fact is verified when we are 80%+ sure (the same line the studio uses for the pulsing chip) and it is not marked pending. */
const isVerified = (f: Stub["event"]["facts"][number]) => f.confidence >= 0.8 && f.provenance !== "pending";

export function toCreativeBrief(stub: Stub, scope: CreativeScope): CreativeBrief {
  requireSourceIdentity(stub);
  const verified: CreativeBrief["facts"]["verified"] = [];
  const unresolved: CreativeBrief["facts"]["unresolved"] = [];
  const core: [string, string | undefined][] = [
    ["event_name", stub.event.title],
    ["event_date", stub.event.dateISO],
    ["venue", stub.event.venue],
    ["city", stub.event.city],
  ];
  for (const [key, value] of core) {
    if (value) verified.push({ fact_id: key, key, value, provenance_refs: [EVENT_SOURCE] });
  }
  for (const f of stub.event.facts) {
    const refs = [slug(f.source)];
    if (isVerified(f)) verified.push({ fact_id: f.id, key: f.id, value: f.value, provenance_refs: refs });
    else
      unresolved.push({
        fact_id: f.id,
        key: f.id,
        status: f.alternatives && f.alternatives.length > 1 ? "conflicting" : "unknown",
        ...(f.alternatives ? { candidate_values: f.alternatives } : {}),
        provenance_refs: refs,
      });
  }

  const { customer_preferences, locked_fields } = toBriefCreatePayload(stub);
  const prefs = customer_preferences ?? [];
  const locks = stub.event.facts.filter((f) => f.kept).map((f) => ({
    lock_id: `lock-${safeId(f.id)}`,
    field: f.id,
    value_hash: pending("value_hash"),
    reason: locked_fields?.find((l) => l.field === f.id)?.reason ?? "Kept on the stub by the customer.",
  }));

  return {
    contract: "CreativeBrief",
    schema_version: "1.0",
    ...envelope(scope, sourceRefsOf(stub)),
    brief_id: briefIdFor(stub),
    research_package_ref: {
      contract: "EventIntelligencePackage",
      schema_version: "1.1",
      package_id: pending("research_package_id"),
      content_hash: pending("research_package_hash"),
    },
    source_identity: sourcesOf(stub),
    facts: { verified, unresolved },
    preferences: { presence: prefs.length ? "present" : "absent", items: prefs },
    interpretations: { presence: "absent", items: [] },
    // Customer photos stay on the device, and no research asset is used, so there is nothing to grant yet.
    permissions: { presence: "absent", items: [] },
    locks: { presence: locks.length ? "present" : "absent", items: locks },
  };
}

/** What brief.create accepts. Verified facts and permissions can never be sent; the engine reads them from its trusted research port. */
export function toBriefCreatePayload(stub: Stub): BriefCreatePayload {
  requireSourceIdentity(stub);
  const cur = currentVersion(stub);
  const prefs: NonNullable<BriefCreatePayload["customer_preferences"]> = [{ preference_id: "edition", value: cur.edition }];
  if (cur.art.vibe && cur.art.vibe !== "photo") prefs.push({ preference_id: "art_vibe", value: cur.art.vibe });
  if (stub.personal.titleColor) prefs.push({ preference_id: "title_colour", value: stub.personal.titleColor });
  const locked = stub.event.facts.filter((f) => f.kept).map((f) => ({ field: f.id, reason: "Kept on the stub by the customer." }));
  return {
    customer_preferences: prefs,
    additional_required_fact_keys: ["event_name", "event_date"],
    ...(locked.length ? { locked_fields: locked } : {}),
  };
}

/** Every edit the editor can make (ops.ts), as data. */
export type StudioOp =
  | { type: "setFont"; index: 0 | 1 | 2 | 3 }
  | { type: "setTitleColour"; value: string }
  | { type: "setFoilTitle"; on: boolean }
  | { type: "setEdition"; edition: Edition }
  | { type: "setFinish"; finish: Finish }
  | { type: "setMaterial"; material: Material }
  | { type: "toggleKept"; factId: string }
  | { type: "setHidden"; field: string; hidden: boolean }
  | { type: "setFactValue"; factId: string; value: string }
  | { type: "setNote"; note: string }
  /** first: the engine has made no version for this stub yet, so this is concept.generate rather than image.edit. */
  | { type: "remixArt"; vibe?: string; seed?: number; first?: boolean }
  | { type: "addPhotoArt" };

export interface Unmapped {
  field: string;
  reason: string;
}

export interface MappedEdit {
  /** null when the op has no creative-engine equivalent at all. */
  plan: EditPlan | null;
  /** Parts of the op that did not travel, with why. */
  unmapped: Unmapped[];
}

type StepBody = EditStep extends infer S ? (S extends EditStep ? Omit<S, "step_id" | "source_refs"> : never) : never;

const INVALIDATES = ["approval", "production_bundle"];

function planFor(stub: Stub, scope: CreativeScope, step: StepBody, unmapped: Unmapped[]): MappedEdit {
  const cur = currentVersion(stub);
  const refs = sourceRefsOf(stub);
  const first = step.action === "concept.generate";
  const plan: EditPlan = {
    contract: "EditPlan",
    schema_version: "1.0",
    ...envelope(scope, refs),
    plan_id: newId(scope, "plan"),
    base: {
      brief_hash: pending("brief_hash"),
      design_hash: pending("design_hash"),
      ...(first ? {} : { design_version_id: safeId(cur.id) }),
    },
    operation: step.action,
    steps: [{ ...step, step_id: newId(scope, "step"), source_refs: refs } as EditStep],
    expected_result: {
      contract: "DesignVersion",
      schema_version: "1.0",
      parent_version_id: first ? `root:${briefIdFor(stub)}` : safeId(cur.id),
      artifact_kind: "image",
    },
    invalidates: INVALIDATES,
  };
  return { plan, unmapped };
}

export function toEditPlan(stub: Stub, op: StudioOp, scope: CreativeScope): MappedEdit {
  const cur = currentVersion(stub);
  const controls = studioControls(stub);
  const versionId = safeId(cur.id);
  const unmapped: Unmapped[] = [];

  const compose = (controlId: string, value: unknown): MappedEdit => {
    const control = controls.find((c) => c.id === controlId);
    const check = validateControl(controls, controlId, value);
    if (!control || !check.ok) {
      return { plan: null, unmapped: [{ field: controlId, reason: check.ok ? "unknown control" : `${check.code}: ${check.message}` }] };
    }
    return planFor(stub, scope, {
      action: "composition.update",
      parameters: { design_version_id: versionId, changes: [{ field: control.field, value }] },
    }, unmapped);
  };

  switch (op.type) {
    case "setFont": return compose("title_font", op.index);
    case "setTitleColour": return compose("title_colour", op.value);
    case "setFoilTitle": return compose("foil_title", op.on);
    case "setEdition": return compose("edition", op.edition);
    case "setFinish": {
      unmapped.push({ field: "finish", reason: "Foil and holo are print-production template choices; the engine only records the request, print-production owns the effect." });
      return compose("finish", op.finish);
    }
    case "toggleKept": {
      const target = sourceReference(stub, op.factId);
      const kept = stub.event.facts.filter((f) => f.kept).map((f) => f.id);
      return compose("kept_facts", kept.includes(target) ? kept.filter((k) => k !== target) : [...kept, target]);
    }
    case "setHidden": {
      const field = ["subtitle", "facts", "title", "art"].includes(op.field) ? op.field : sourceReference(stub, op.field);
      const rest = sourceHiddenFields(stub).filter(h => h !== field);
      return compose("hidden_facts", op.hidden ? [...rest, field] : rest);
    }
    case "setNote": return compose("note", op.note);
    case "setMaterial":
      return { plan: null, unmapped: [{ field: "material", reason: "Material is a purchase choice (FulfillmentQuote / OrderAuthorization), not a design change. It does not create a DesignVersion." }] };
    case "addPhotoArt":
      return { plan: null, unmapped: [{ field: "photo", reason: "A customer photo needs an uploaded asset with a granted permission (ResearchPermission) before image.edit can use it; photos are local-only today." }] };
    case "setFactValue":
      unmapped.push({ field: "evidence_refs", reason: "The customer confirming a value is not source evidence; the engine will want a research-owner correction handoff (correction.apply returns unavailable upstream)." });
      return planFor(stub, scope, {
        action: "correction.apply",
        parameters: { design_version_id: versionId, fact_id: sourceReference(stub, op.factId), replacement_value: op.value, evidence_refs: [pending("evidence_ref")] },
      }, unmapped);
    case "remixArt": {
      if (op.seed !== undefined) unmapped.push({ field: "seed", reason: "No seed parameter in generate/edit steps; the engine's output is not reproducible from our seed." });
      const vibeCheck = op.vibe ? validateControl(controls, "art_vibe", op.vibe) : { ok: true as const };
      if (!vibeCheck.ok) unmapped.push({ field: "vibe", reason: `${vibeCheck.code}: ${vibeCheck.message} Sent as free text in the instruction.` });
      if (op.first) {
        if (op.vibe) unmapped.push({ field: "vibe", reason: "Sent as style_ref; upstream has not defined what a style_ref resolves to." });
        return planFor(stub, scope, {
          action: "concept.generate",
          parameters: { brief_id: briefIdFor(stub), variant_count: 1, ...(op.vibe ? { style_ref: op.vibe } : {}) },
        }, unmapped);
      }
      const style = op.vibe ? ` in a ${op.vibe} style` : "";
      return planFor(stub, scope, {
        action: "image.edit",
        parameters: {
          design_version_id: versionId,
          artifact_id: artifactIdFor(cur.id),
          instruction: `Remix the artwork${style}. Keep the event details unchanged and the art free of text.`,
        },
      }, unmapped);
    }
  }
}

export interface FromDesignVersionOptions {
  /** DesignVersion has no edition; the caller knows which edition the stub was in. */
  edition?: Edition;
  /** The artifact is private bytes behind an access owner; the caller resolves a displayable src for it. */
  resolveSrc?: (artifact: DesignVersion["artifact"]) => string | undefined;
  vibe?: string;
  seed?: number;
}

const hashString = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) % 2_147_483_647;
};

/** An engine DesignVersion becomes our DesignVersion + ArtLayer. "live" only when a real provider produced it. */
export function fromDesignVersion(dv: DesignVersion, opts: FromDesignVersionOptions = {}): StudioVersion {
  const realProvider = !!dv.provider && !dv.provider.startsWith("fixture") && !dv.provider.startsWith("PENDING_");
  const provenance: Provenance =
    dv.billing_mode === "live" && realProvider ? "live" : dv.billing_mode === "sandbox" && realProvider ? "sandbox" : "simulated";
  const src = opts.resolveSrc?.(dv.artifact);
  const art: ArtLayer = {
    kind: src ? "image" : "procedural",
    ...(src ? { src } : {}),
    seed: opts.seed ?? hashString(dv.design_version_id),
    ...(opts.vibe ? { vibe: opts.vibe } : {}),
    provenance,
  };
  return {
    id: dv.design_version_id,
    ...(dv.parent_version_id && !dv.parent_version_id.startsWith("root:") ? { parentId: dv.parent_version_id } : {}),
    edition: opts.edition ?? "researched",
    art,
    createdAt: dv.occurred_at,
  };
}

/** Build the CreativeApiRequest envelope. action_id should be stable per user intent (it is the idempotency key); the default is only for one-shot use. */
export function toApiRequest<O extends CreativeOperation>(
  operation: O,
  payload: PayloadOf<O>,
  scope: CreativeScope,
  opts: { actionId?: string; sourceRefs?: string[] } = {},
): Extract<CreativeApiRequest, { operation: O }> {
  const t = nowIso(scope);
  const request = {
    contract: "CreativeApiRequest",
    schema_version: "1.0",
    event_id: newId(scope, "event"),
    request_id: newId(scope, "request"),
    tenant_id: scope.tenantId,
    project_id: scope.projectId,
    correlation_id: scope.correlationId,
    producer: scope.producer ?? "ticketstub-studio",
    occurred_at: t,
    ingested_at: t,
    environment: scope.environment ?? "development",
    billing_mode: scope.billingMode ?? "simulated",
    source_refs: opts.sourceRefs ?? [],
    operation,
    action_id: opts.actionId ?? newId(scope, "action"),
    payload,
  };
  return request as unknown as Extract<CreativeApiRequest, { operation: O }>;
}

/** The trusted actor the server side must hold. Expiry and budget refs come from the application and cost-intelligence, which don't exist yet. */
export function toTrustedActor(scope: CreativeScope): TrustedCreativeActor {
  return {
    tenant_id: scope.tenantId,
    project_id: scope.projectId,
    actor_id: scope.actor.actorId,
    expires_at: pending("actor_expires_at"),
    permissions: scope.actor.permissions ?? ["creative.generate", "creative.edit", "creative.brief.create"],
    budget_scope_id: pending("budget_scope_id"),
    budget_policy_version: pending("budget_policy_version"),
  };
}

/** What /api/art would send for a remix or first generation: the generate/edit request plus anything that did not map. */
export function toArtEditRequest(
  stub: Stub,
  art: { vibe?: string; seed?: number; first?: boolean },
  scope: CreativeScope,
  opts: { actionId?: string } = {},
): { request: Extract<CreativeApiRequest, { operation: "generate" | "edit" }> | null; unmapped: Unmapped[] } {
  const { plan, unmapped } = toEditPlan(stub, { type: "remixArt", ...art }, scope);
  if (!plan) return { request: null, unmapped };
  const brief_id = briefIdFor(stub);
  const sourceRefs = plan.source_refs;
  if (art.first) return { request: toApiRequest("generate", { brief_id, plan }, scope, { ...opts, sourceRefs }), unmapped };
  const design_version_id = plan.base.design_version_id ?? safeId(currentVersion(stub).id);
  return {
    request: toApiRequest("edit", { brief_id, design_version_id, plan, selection_mode: "advance" }, scope, { ...opts, sourceRefs }),
    unmapped,
  };
}
