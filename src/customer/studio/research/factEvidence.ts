type EnrichedClaim = { id?: string; label: string; value: string; evidence?: string };

const normalize = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");
const uncertain = /\b(?:not|no|never|without|unconfirmed|unavailable|unverified|pending|tba|tbc|tbd|may|might|possibly|tentative|provisional|alleged|rumou?r(?:ed)?|cancelled|canceled|postponed|replaced|withdrawn|former|formerly|previously)\b|\b\w+n['’]t\b|\bto be (?:announced|confirmed)\b|\bsubject to (?:change|confirmation)\b|\?/i;
const fields = new Map<string, readonly string[]>([
  ["opener", ["opener", "support act", "opening act"]],
  ["tour", ["tour", "tour name"]],
  ["run", ["run", "performance run"]],
]);

/**
 * Accept only a literal, affirmative "field: value" statement, including its context.
 * Matching a quote proves retrieval, not that the model's interpretation is correct.
 * Paraphrases, prose and ambiguous contexts remain estimates for customer review.
 * Any explicit uncertainty in the bounded page text demotes model claims, even
 * when it might concern another fact; this deliberately favors false negatives.
 */
export function supportsEnrichedFact(text: string, claim: EnrichedClaim): boolean {
  const evidence = claim.evidence?.trim();
  if (!evidence || evidence.length > 2000 || !claim.label.trim() || !claim.value.trim() || uncertain.test(text)) return false;
  const statement = evidence.replace(/[.!]$/, "").trim();
  const match = statement.match(/^([\p{L}][\p{L} ]{0,39}):\s*(\S[\s\S]*)$/u);
  if (!match || uncertain.test(statement)) return false;
  const key = normalize(match[1]);
  const value = normalize(match[2]);
  if (value !== normalize(claim.value)) return false;
  const allowedFields = fields.get(claim.id ?? "");
  if (allowedFields && !allowedFields.includes(key)) return false;
  // Multiple statements for this role may describe different performances or
  // a correction. Do not select one silently, even if one quote is accurate.
  const fieldPattern = (allowedFields ?? [key]).join("|"); // field names contain letters and spaces only
  if ([...text.matchAll(new RegExp(`(?:^|[.!?\\n])\\s*(?:${fieldPattern})\\s*:`, "gi"))].length !== 1) return false;
  const label = normalize(claim.label);
  if (![value, key, normalize(`${key}: ${value}`)].includes(label)) return false;

  const lowerText = text.toLowerCase();
  const quote = evidence.toLowerCase();
  let offset = lowerText.indexOf(quote);
  while (offset >= 0) {
    // A substring snipped out of "Not opener: X" or "Opener: X is cancelled"
    // is not an affirmative statement. Require the complete surrounding sentence.
    const before = text.slice(0, offset);
    const after = text.slice(offset + evidence.length);
    const prefix = before.slice(Math.max(before.lastIndexOf("."), before.lastIndexOf("!"), before.lastIndexOf("?"), before.lastIndexOf("\n")) + 1);
    // A period inside a decimal or a name is not a sentence boundary. This also
    // rejects "Capacity: 12." quoted out of the actual value "Capacity: 12.50.".
    const completeEnd = /[.!?]$/.test(evidence)
      ? !after || /^\s/.test(after)
      : /^(?:\s*$|\s*[.!?](?=\s|$)|\s*\n)/.test(after);
    if (!prefix.trim() && completeEnd) return true;
    offset = lowerText.indexOf(quote, offset + 1);
  }
  return false;
}
