import type { EventData, Fact, Stub } from "../types";

/** Assign once at ingestion, never in a render. Reserve all incoming IDs before allocating suffixes. */
export function uniqueFacts(facts: Fact[], reserved: readonly Fact[] = []): Fact[] {
  const used = new Set(reserved.map((f) => f.id));
  const occupied = new Set([...used, ...facts.map((f) => f.id).filter(Boolean)]);
  return facts.map((f) => {
    const base = typeof f.id === "string" && f.id.trim() ? f.id : "note";
    let id = base;
    if (used.has(id) || !f.id) {
      let suffix = 2;
      while (occupied.has(`${base}-${suffix}`)) suffix++;
      id = `${base}-${suffix}`;
    }
    used.add(id);
    occupied.add(id);
    return id === f.id ? f : { ...f, id };
  });
}

export function normalizeEventFacts(event: EventData): EventData {
  const facts = uniqueFacts(event.facts);
  return facts.every((f, i) => f === event.facts[i]) ? event : { ...event, facts };
}

/** Legacy collisions retain their records, but ambiguous history must not become a correction on one row. */
export function normalizeStubFacts(stub: Stub): Stub {
  if (!Array.isArray(stub.event?.facts)) return stub;
  const counts = new Map<string, number>();
  for (const f of stub.event.facts) counts.set(f.id, (counts.get(f.id) ?? 0) + 1);
  const event = normalizeEventFacts(stub.event);
  if (event === stub.event) return stub;
  const corrections = stub.corrections?.map((c) => (counts.get(c.factId) ?? 0) > 1 ? { ...c, unresolvedIdentity: true as const } : c);
  // A hidden legacy ID meant all matching rows. Preserve that visibility choice for each repaired row.
  const hidden = new Set(stub.personal.hiddenFields);
  const hiddenFields = [...hidden];
  event.facts.forEach((f, i) => {
    if (hidden.has(stub.event.facts[i].id) && !hidden.has(f.id)) hiddenFields.push(f.id);
  });
  return { ...stub, event, corrections, personal: { ...stub.personal, hiddenFields } };
}
