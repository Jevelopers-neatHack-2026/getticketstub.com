import { requireSourceIdentity, sourceHiddenFields } from "../facts/identity";
// The studio's allowlisted controls, declared in creative-engine's creative-controls/1.1 shape.
// Ids, ranges and enums mirror the real editor (ops.ts, editions.ts, RemixSheet.tsx, Memories.tsx).
// Upstream's producer only knows four fixed selects today (name_size, layout, logo_position, style), so every
// control below needs their producer allowlist extended before MODE=live. CONTROL_UPSTREAM says which kind of gap.
import { EDITIONS, currentVersion } from "../types";
import type { Finish, Stub } from "../types";
import { TITLE_SWATCHES } from "../editor/ops";
import { pending } from "./contracts";
import type {
  Control,
  ControlSchema,
  ControlValue,
  DesignControlSchema,
  HashOrPending,
  RejectionCode,
  Sha256,
} from "./contracts";

const FINISHES: Finish[] = ["matte", "foil", "holo"];
/** Mirrors VIBES in editor/RemixSheet.tsx (a .tsx file, so it can't be imported from a node check). /api/art itself accepts any text up to 120 chars. */
export const ART_VIBES = ["Neon", "Risograph", "70s", "Minimal"] as const;
export const NOTE_MAX_LENGTH = 140; // Memories.tsx maxLength
export const SEED_MAX = 2_147_483_647; // /api/art freshSeed()
export const FONT_SLOTS = [0, 1, 2, 3] as const; // personal.titleFont

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

/** gap kinds: native = upstream already has this kind and field shape; proposed-field = known kind, new field; proposed-kind = new control kind. */
export const CONTROL_UPSTREAM = {
  edition: "proposed-field",
  title_font: "proposed-field",
  title_colour: "proposed-field",
  foil_title: "proposed-kind",
  finish: "proposed-field",
  kept_facts: "proposed-kind",
  hidden_facts: "proposed-kind",
  note: "proposed-kind",
  art_vibe: "proposed-field",
  art_seed: "proposed-kind",
} as const;

/** Control definitions. Fact lists are dynamic, so pass the stub (or omit it for the static shape). */
export function studioControls(stub?: Stub): Control[] {
  if (stub) requireSourceIdentity(stub);
  const cur = stub ? currentVersion(stub) : undefined;
  const factOptions = (stub?.event.facts ?? []).map((f) => ({ value: f.id, label: f.label }));
  const p = stub?.personal;
  return [
    { id: "edition", label: "Edition", kind: "select", value_type: "string", field: "edition", route: "composition.update",
      options: EDITIONS.map((e) => ({ value: e, label: cap(e) })), default_value: cur?.edition ?? "researched", locked: false },
    { id: "title_font", label: "Title font", kind: "select", value_type: "integer", field: "title_font", route: "composition.update",
      options: FONT_SLOTS.map((i) => ({ value: i, label: `Font ${i + 1}` })), default_value: p?.titleFont ?? 0, locked: false },
    { id: "title_colour", label: "Title colour", kind: "select", value_type: "string", field: "title_colour", route: "composition.update",
      options: TITLE_SWATCHES.map((s) => ({ value: s.value, label: s.label })), default_value: p?.titleColor ?? "", locked: false },
    { id: "foil_title", label: "Foil title", kind: "toggle", value_type: "boolean", field: "foil_title", route: "composition.update",
      default_value: p?.foilTitle ?? true, locked: false },
    { id: "finish", label: "Finish", kind: "select", value_type: "string", field: "finish", route: "composition.update",
      options: FINISHES.map((f) => ({ value: f, label: cap(f) })), default_value: stub?.finish ?? "foil", locked: false },
    { id: "kept_facts", label: "Facts kept on the stub", kind: "multi_select", value_type: "string[]", field: "kept_fact_ids",
      route: "composition.update", options: factOptions,
      default_value: (stub?.event.facts ?? []).filter((f) => f.kept).map((f) => f.id), locked: false },
    { id: "hidden_facts", label: "Hidden from the stub", kind: "multi_select", value_type: "string[]", field: "hidden_fields",
      route: "composition.update", options: [{ value: "subtitle", label: "Subtitle" }, ...factOptions],
      default_value: stub ? sourceHiddenFields(stub) : [], locked: false },
    { id: "note", label: "Note on the back", kind: "text", value_type: "string", field: "note", route: "composition.update",
      max_length: NOTE_MAX_LENGTH, default_value: p?.note ?? "", locked: false },
    { id: "art_vibe", label: "Art vibe", kind: "select", value_type: "string", field: "vibe", route: "artwork.edit",
      options: [{ value: "", label: "None" }, ...ART_VIBES.map((v) => ({ value: v, label: v }))], default_value: cur?.art.vibe ?? "", locked: false },
    { id: "art_seed", label: "Art seed", kind: "range", value_type: "integer", field: "seed", route: "artwork.edit",
      min: 0, max: SEED_MAX, default_value: cur?.art.seed ?? 0, locked: false },
  ];
}

export interface ControlScope {
  tenantId: string;
  projectId: string;
}

export function studioControlSchema(
  scope: ControlScope,
  briefId: string,
  versions: { brief: string; design: string; composition: string },
  stub?: Stub,
): ControlSchema {
  return {
    schema_version: "creative-controls/1.1",
    contract_status: "local-consumer-proposal",
    tenant_id: scope.tenantId,
    project_id: scope.projectId,
    brief_id: briefId,
    expected_versions: versions,
    controls: studioControls(stub),
    follow_up_questions: [],
    submit_intent: "apply",
    approval: false,
    purchase: false,
  };
}

/** Same canonical form as creative-engine src/controls/schema.mjs canonical(): sorted keys, JSON scalars. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** control_schema_hash is real: sha256 of the canonical inner schema, via WebCrypto (browser and Node). */
export async function controlSchemaHash(schema: unknown): Promise<Sha256> {
  const bytes = new TextEncoder().encode(canonicalJson(schema));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  return `sha256:${hex}`;
}

/** The outer DesignControlSchema wrapper. Envelope fields come from the caller; the hash is computed or PENDING_. */
export function toDesignControlSchema(
  schema: ControlSchema,
  envelope: Pick<DesignControlSchema, "event_id" | "correlation_id" | "producer" | "occurred_at" | "ingested_at" | "environment" | "billing_mode" | "source_refs">,
  hash?: Sha256,
): DesignControlSchema {
  const h: HashOrPending = hash ?? pending("control_schema_hash");
  return {
    contract: "DesignControlSchema",
    schema_version: "1.0",
    ...envelope,
    tenant_id: schema.tenant_id,
    project_id: schema.project_id,
    control_contract: "creative-controls",
    control_schema_version: "1.1",
    expected_versions: schema.expected_versions,
    control_schema_hash: h,
  };
}

export type ControlCheck = { ok: true } | { ok: false; code: RejectionCode; message: string };

const fail = (code: RejectionCode, message: string): ControlCheck => ({ ok: false, code, message });

/** Check one value against a control. Codes are upstream's RejectionCode names. */
export function validateControl(controls: Control[], controlId: string, value: unknown): ControlCheck {
  const c = controls.find((x) => x.id === controlId);
  if (!c) return fail("unknown_control", `No control "${controlId}".`);
  if (c.locked) return fail("locked", `"${c.label}" is locked.`);
  const optionValues = (c.options ?? []).map((o) => o.value);
  switch (c.value_type) {
    case "boolean":
      return typeof value === "boolean" ? { ok: true } : fail("invalid_value", `"${c.label}" is on or off.`);
    case "integer": {
      if (typeof value !== "number" || !Number.isInteger(value)) return fail("invalid_value", `"${c.label}" is a whole number.`);
      if (c.kind === "select") return optionValues.includes(value) ? { ok: true } : fail("invalid_value", `"${c.label}" has no option ${value}.`);
      if ((c.min !== undefined && value < c.min) || (c.max !== undefined && value > c.max)) return fail("invalid_value", `"${c.label}" is outside ${c.min}..${c.max}.`);
      return { ok: true };
    }
    case "string[]": {
      if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) return fail("invalid_value", `"${c.label}" is a list.`);
      if (new Set(value).size !== value.length) return fail("invalid_value", `"${c.label}" repeats an item.`);
      const bad = value.find((v) => !optionValues.includes(v));
      return bad === undefined ? { ok: true } : fail("invalid_value", `"${c.label}" has no option "${bad}".`);
    }
    case "string": {
      if (typeof value !== "string") return fail("invalid_value", `"${c.label}" is text.`);
      if (c.kind === "select") return optionValues.includes(value) ? { ok: true } : fail("invalid_value", `"${c.label}" has no option "${value}".`);
      if (c.max_length !== undefined && value.length > c.max_length) return fail("invalid_value", `"${c.label}" is over ${c.max_length} characters.`);
      return { ok: true };
    }
  }
}

export function controlDefault(controls: Control[], controlId: string): ControlValue | undefined {
  return controls.find((x) => x.id === controlId)?.default_value;
}
