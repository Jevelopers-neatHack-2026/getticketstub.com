/** Decode HTML text and attribute references, never JSON-LD script contents. */
export function decodeHtmlEntities(value: string): string {
  return value.replace(/&(?:amp|quot|apos|lt|gt|nbsp);|&#(?:x[0-9a-f]+|[0-9]+);/gi, (entity) => {
    const named: Record<string, string> = { "&amp;": "&", "&quot;": '"', "&apos;": "'", "&lt;": "<", "&gt;": ">", "&nbsp;": " " };
    if (named[entity.toLowerCase()]) return named[entity.toLowerCase()];
    const hex = /^&#x/i.test(entity);
    const codepoint = Number.parseInt(entity.slice(hex ? 3 : 2, -1), hex ? 16 : 10);
    return codepoint > 0 && codepoint <= 0x10ffff && !(codepoint >= 0xd800 && codepoint <= 0xdfff) ? String.fromCodePoint(codepoint) : entity;
  }).trim();
}

type Json = Record<string, unknown>;
const EVENT_TYPES = /(^|:)(Event|MusicEvent|SportsEvent|TheaterEvent|ComedyEvent|DanceEvent|Festival|ExhibitionEvent|SocialEvent|EducationEvent|BusinessEvent)$/;

function collectNodes(value: unknown, out: Json[]): void {
  if (Array.isArray(value)) value.forEach((item) => collectNodes(item, out));
  else if (value && typeof value === "object") {
    const node = value as Json;
    out.push(node);
    if (node["@graph"]) collectNodes(node["@graph"], out);
    if (node.subEvent) collectNodes(node.subEvent, out);
  }
}

/** Entity-encoded MIME attributes occur on TICKETINO and are valid HTML. */
export function findJsonLdEvents(html: string): Json[] {
  const nodes: Json[] = [];
  // Comments cannot contribute live page evidence. Consume each attribute as a
  // whole so a string such as data-note="type=..." cannot masquerade as MIME.
  const activeHtml = html.replace(/<!--[\s\S]*?(?:-->|$)/g, "");
  for (const match of activeHtml.matchAll(/<script\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/script\s*>/gi)) {
    let type: string | undefined;
    for (const attribute of match[1].matchAll(/([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
      if (attribute[1].toLowerCase() === "type") {
        type = attribute[2] ?? attribute[3] ?? attribute[4] ?? "";
        break;
      }
    }
    if (type === undefined || decodeHtmlEntities(type).toLowerCase() !== "application/ld+json") continue;
    try { collectNodes(JSON.parse(match[2].trim()), nodes); } catch { /* skip malformed blocks */ }
  }
  return nodes.filter((node) => {
    const types = Array.isArray(node["@type"]) ? node["@type"] : [node["@type"]];
    return types.some((type) => typeof type === "string" && EVENT_TYPES.test(type.replace(/^https?:\/\/schema\.org\//, "")));
  });
}
