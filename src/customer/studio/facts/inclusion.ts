import type { Fact, Stub } from "../types";

/** These facts are rendered from event fields, never a duplicate optional fact line. */
export const CORE_FACT_FIELDS = { title: "title", date: "dateISO", venue: "venue" } as const;
export const isCoreFact = (f: Pick<Fact, "id">): boolean => Object.hasOwn(CORE_FACT_FIELDS, f.id);

export function isFactIncluded(stub: Stub, f: Fact): boolean {
  const hidden = stub.personal.hiddenFields;
  if (hidden.includes(f.id)) return false;
  if (isCoreFact(f)) return !!stub.event[CORE_FACT_FIELDS[f.id as keyof typeof CORE_FACT_FIELDS]];
  return !!f.kept && !hidden.includes("facts") && f.provenance !== "pending" && !!f.value.trim();
}

export const includedExtraFacts = (stub: Stub): Fact[] => stub.event.facts.filter((f) => !isCoreFact(f) && isFactIncluded(stub, f));
