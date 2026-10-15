import type { EventData, Fact, Stub } from "../types";

/** Only generated at ingestion, never from row order, text or source identity. */
export const newEntityKey = (): string => `ce_${crypto.randomUUID()}`;
export const factKey = (f: Fact): string => f.clientEntityKey ?? f.id;

/** Source IDs are evidence. Allocate a separate persisted client identity, including for collisions. */
export function uniqueFacts(facts: Fact[], reserved: readonly Fact[] = []): Fact[] {
  const all = [...reserved, ...facts];
  const validKey = (key: unknown): key is string => typeof key === "string" && /^ce_[a-zA-Z0-9-]{1,80}$/.test(key);
  const counts = new Map<string, number>();
  for (const f of all) if (f.clientEntityKey) counts.set(f.clientEntityKey, (counts.get(f.clientEntityKey) ?? 0) + 1);
  const used = new Set(all.map(f => f.clientEntityKey).filter(Boolean));
  return facts.map(f => {
    if (validKey(f.clientEntityKey) && counts.get(f.clientEntityKey) === 1) return f;
    let key: string;
    do { key = newEntityKey(); } while (used.has(key));
    used.add(key);
    return { ...f, clientEntityKey: key };
  });
}

/** Legacy source references bind only when unambiguous. Stale local references never fall back. */
export function resolveFact(facts: readonly Fact[], ref: string): Fact | undefined {
  const local = facts.filter(f => f.clientEntityKey === ref);
  if (local.length) return local.length === 1 ? local[0] : undefined;
  if (ref.startsWith("ce_")) return undefined;
  const source = facts.filter(f => f.id === ref);
  return source.length === 1 ? source[0] : undefined;
}

export function normalizeEventFacts(event: EventData): EventData {
  const facts = uniqueFacts(event.facts);
  return facts.every((f, i) => f === event.facts[i]) ? event : { ...event, facts };
}

export function normalizeStubFacts(stub: Stub): Stub {
  if (!Array.isArray(stub.event?.facts)) return stub;
  const event = normalizeEventFacts(stub.event);
  // A legacy hidden source ID hid every matching row. Presentation state may migrate;
  // immutable correction/history records must remain exactly as received.
  const hiddenFields = [...new Set(stub.personal.hiddenFields.flatMap(ref => {
    if (["title", "subtitle", "facts", "art"].includes(ref)) return [ref];
    const matches = event.facts.filter(f => f.id === ref && !ref.startsWith("ce_"));
    return matches.length ? matches.map(factKey) : [ref];
  }))];
  if (event === stub.event && hiddenFields.length === stub.personal.hiddenFields.length && hiddenFields.every((ref,i) => ref === stub.personal.hiddenFields[i])) return stub;
  return { ...stub, event, personal: { ...stub.personal, hiddenFields } };
}

/** Provider request projection: explicitly omit all client entity metadata. */
export function sourceEvent(event: EventData): EventData {
  return { ...event, facts: event.facts.map(f => {
    const { clientEntityKey: _local, ...source } = f;
    void _local;
    return source;
  }) };
}

/** No elected canonical mapping exists for ambiguous producer IDs. Fail before emitting a foreign DTO. */
export class FactIdentityMappingError extends Error {
  readonly code = "fact_identity_mapping_required";
  constructor() { super("An explicit producer fact identity mapping is required before creating this request."); }
}
export function requireSourceIdentity(stub: Stub): void {
  const ids = stub.event.facts.map(f => f.id);
  if (ids.some(id => !id || id.startsWith("ce_")) || new Set(ids).size !== ids.length) throw new FactIdentityMappingError();
}
export function sourceReference(stub: Stub, ref: string): string {
  const f = resolveFact(stub.event.facts, ref);
  if (!f) throw new FactIdentityMappingError();
  return f.id;
}
export function sourceHiddenFields(stub: Stub): string[] {
  return stub.personal.hiddenFields.map(ref => ["title", "subtitle", "facts", "art"].includes(ref) ? ref : sourceReference(stub, ref));
}
