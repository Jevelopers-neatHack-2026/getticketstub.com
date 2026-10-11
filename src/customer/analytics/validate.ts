// Runtime enforcement of the catalog. TypeScript catches most mistakes at the call site; this catches
// the rest (casts, `any`, data read back from storage) before anything leaves the page. A bad event is
// dropped whole rather than trimmed, so a mistake shows up in tests instead of as a half-true report.
import { EVENTS, INTERNAL_EVENTS, MONEY_MAX, RESERVED_PARAMS, type EventSpec, type ParamSpec } from "./catalog";

export type SafeValue = string | number | boolean;
export type SafeParams = Record<string, SafeValue>;

export type Validation = { ok: true; params: SafeParams } | { ok: false; reason: string };

const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** The value if it fits the spec exactly, else undefined. Nothing is coerced or clamped. */
export function checkValue(spec: ParamSpec, v: unknown): SafeValue | undefined {
  switch (spec.kind) {
    case "enum":
      return typeof v === "string" && spec.values.includes(v) ? v : undefined;
    case "int":
      return typeof v === "number" && Number.isInteger(v) && v >= spec.min && v <= spec.max ? v : undefined;
    case "money":
      return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= MONEY_MAX ? Math.round(v * 100) / 100 : undefined;
    case "bool":
      return typeof v === "boolean" ? v : undefined;
    default:
      return undefined;
  }
}

function validateAgainst(spec: EventSpec | undefined, name: string, params: unknown): Validation {
  if (!spec) return { ok: false, reason: "unknown event" };
  if (params !== undefined && params !== null && !isPlainObject(params)) return { ok: false, reason: "params must be a plain object" };
  const out: SafeParams = {};
  const given = (params ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(given)) {
    const value = given[key];
    if (value === undefined) continue;
    if ((RESERVED_PARAMS as readonly string[]).includes(key)) return { ok: false, reason: `${key} is reserved` };
    if (!own(spec.params, key)) return { ok: false, reason: `${key} is not allowed on ${name}` };
    const safe = checkValue(spec.params[key], value);
    if (safe === undefined) return { ok: false, reason: `${key} has a disallowed value` };
    out[key] = safe;
  }
  for (const [key, value] of Object.entries(spec.fixed ?? {})) out[key] = value;
  return { ok: true, params: out };
}

/** Check a public event against the catalog. Reasons name keys, never values. */
export function validateEvent(name: unknown, params?: unknown): Validation {
  if (typeof name !== "string" || !own(EVENTS, name)) return { ok: false, reason: "unknown event" };
  return validateAgainst(EVENTS[name as keyof typeof EVENTS], name, params);
}

/** Check an event the runtime itself builds (page views, vitals, route timing). */
export function validateInternalEvent(name: string, params?: unknown): Validation {
  return validateAgainst(own(INTERNAL_EVENTS, name) ? INTERNAL_EVENTS[name as keyof typeof INTERNAL_EVENTS] : undefined, name, params);
}
