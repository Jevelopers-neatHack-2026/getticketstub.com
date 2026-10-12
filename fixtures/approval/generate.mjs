// Regenerates the JSON fixtures in this folder. Deterministic: same inputs, same bytes.
//   node fixtures/approval/generate.mjs
// Signs with the FIXTURE key below. That key is public on purpose. It is fixture only, never production:
// a record signed with it carries mode "fixture", and the server refuses to use any secret that contains FIXTURE-ONLY.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { APPROVAL_PURPOSES, APPROVAL_SCHEMA, APPROVAL_TTL_MS, NOT_AUTHORIZED, bindStub, hashesOf, sha256Hex, signApproval } from "../../src/server/approval-token.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_KEY = "FIXTURE-ONLY-NEVER-PRODUCTION--ticketstub-approval-key-v1";
/** The fixture key under its kid. Every fixture token carries kid "fixture" in its header; a server refuses any kid starting "fixture". */
const FIXTURE_SIGNER = { kid: "fixture", key: FIXTURE_KEY };
// The published context fixture key (fixtures/context/fixture-key.json), to show a CONTEXT_SECRET-style key never verifies an approval.
const CONTEXT_FIXTURE_KEY = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../context/fixture-key.json"), "utf8")).key;
const NOW = Date.parse("2026-10-10T12:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();
const HOUR = 3600_000;

// A synthetic stub and synthetic art bytes. Nothing here is a real event, person or image.
const ART_BYTES = Buffer.from("FIXTURE-ART-BYTES-v1: not a real image, stands in for the stored PNG");
const OTHER_BYTES = Buffer.from("FIXTURE-ART-BYTES-v2: the bytes a consumer holds after somebody swapped the file");
const stub = {
  event: {
    type: "concert",
    title: "The Pale Hours",
    subtitle: "Night 2 of 3",
    venue: "Fixture Hall",
    city: "Nowhere",
    dateISO: "2026-11-02",
    seat: "Row C 14",
    facts: [
      { id: "f1", label: "Opening song", value: "Lantern", source: "fixture", provenance: "simulated", kept: true },
      { id: "f2", label: "Weather", value: "Rain", source: "fixture", provenance: "simulated", kept: false },
    ],
  },
  versions: [{ id: "v_fx_2", edition: "letterpress", art: { kind: "image", src: `/api/files/${sha256Hex(ART_BYTES)}.png`, seed: 7, provenance: "simulated" }, createdAt: "2026-10-10T11:00:00.000Z" }],
  currentVersionId: "v_fx_2",
  personal: { titleFont: 1, titleColor: "#1b1b1b", foilTitle: false, hiddenFields: [], friends: [] },
  material: "print",
  finish: "matte",
};
const SIZE = "classic";
const binding = bindStub(stub, SIZE, { hash: sha256Hex(ART_BYTES), source: "bytes" });
const TENANT = "acc_FIXTURE_owner1";
const PROJECT = { kind: "stub", id: "stub_fx_1" };

const record = (over = {}) => ({
  schema: APPROVAL_SCHEMA,
  id: "apr_FIXTURE_0001",
  issuer: "ticketstub",
  tenant: { id: TENANT },
  project: PROJECT,
  purpose: "print.compose",
  actor: { kind: "account", id: TENANT },
  binding,
  membershipRevision: 3,
  notAuthorizes: NOT_AUTHORIZED,
  environment: "development",
  mode: "fixture",
  issuedAt: iso(NOW),
  expiresAt: iso(NOW + APPROVAL_TTL_MS),
  ...over,
});

const out = {};
/**
 * held: what the consumer has in hand (art bytes, base64). expect: the scope it names. state: the issuer's current answer, when the case needs it.
 * outcome: what a correct verifier must answer. The consumer computes every hash itself (artHash from `held`, the rest from content.json); it never takes one from the token.
 * consumer: optional, changes what the consumer supplies: { omit, override, empty, clock } (see runFixture in verify.mjs). Default: all four hashes and the verifyAt clock.
 */
function add(name, description, token, { purpose = "print.compose", tenant = TENANT, project = PROJECT, held = ART_BYTES, state, verifyAt = NOW + HOUR, outcome, consumer, extra = {} }) {
  out[name] = { fixture: name, description, verifyAt: iso(verifyAt), token, held: { artBase64: held.toString("base64") }, expect: { tenant, project, purpose }, ...(state ? { state } : {}), ...(consumer ? { consumer } : {}), outcome, ...extra };
}
const live = { known: true, revoked: false, membershipRevision: 3, current: hashesOf(binding) };
const ok = { ok: true };
const no = (reason) => ({ ok: false, reason });

add("valid-print-compose", "A good approval to compose the print preview. The consumer holds the exact bytes. Control case: it must pass.", signApproval(record(), FIXTURE_SIGNER), { state: live, outcome: ok });
add("valid-artifact-download", "A good approval for artifact.download, a different purpose with its own record id.", signApproval(record({ id: "apr_FIXTURE_0002", purpose: "artifact.download" }), FIXTURE_SIGNER), { purpose: "artifact.download", state: live, outcome: ok });

add("unknown-malformed", "Not a token at all.", "not-a-token", { outcome: no("unknown") });
add("unknown-no-record", "Signed correctly, but the issuer has no record of this id (a different deployment, or a wiped database). The issuer answers known: false.", signApproval(record({ id: "apr_FIXTURE_0404" }), FIXTURE_SIGNER), { state: { ...live, known: false }, outcome: no("unknown") });
add("forged", "The same record signed with a different key.", signApproval(record(), { kid: "fixture", key: "some-other-key-the-issuer-never-saw-0000" }), { state: live, outcome: no("forged") });

add("forged-unknown-kid", "Signed with the fixture key bytes, but under a kid the verifier holds no key for (a rotated-out or invented kid). Nothing verifies it.", signApproval(record(), { kid: "fixture-g0-purged", key: FIXTURE_KEY }), { state: live, outcome: no("forged") });
add("forged-context-key", "Key confusion: the record signed under the approval kid with the context-token key (the published context fixture key, standing in for CONTEXT_SECRET). Approvals have their own key set, so it is forged.", signApproval(record(), { kid: "fixture", key: CONTEXT_FIXTURE_KEY }), { state: live, outcome: no("forged") });
const noKid = signApproval(record(), FIXTURE_SIGNER).split(".");
noKid[0] = Buffer.from(JSON.stringify({ alg: "HS256", typ: "ticketstub.approval" })).toString("base64url");
add("unknown-no-kid", "A header without a kid (the pre-K4 format). A verifier can't pick a key, so it is not a token it reads.", noKid.join("."), { state: live, outcome: no("unknown") });

const edited = signApproval(record(), FIXTURE_SIGNER).split(".");
const swapped = JSON.parse(Buffer.from(edited[1], "base64url").toString());
swapped.approval.binding.artHash = sha256Hex(OTHER_BYTES);
edited[1] = Buffer.from(JSON.stringify(swapped)).toString("base64url");
add("forged-edited-binding", "A valid token whose payload was edited to bind different art bytes. The signature no longer matches.", edited.join("."), { held: OTHER_BYTES, state: live, outcome: no("forged") });

add("expired", "Verified eight days after issue; the lifetime is seven.", signApproval(record(), FIXTURE_SIGNER), { verifyAt: NOW + 8 * 24 * HOUR, state: live, outcome: no("expired") });
add("revoked", "The owner revoked it. The issuer says revoked: true.", signApproval(record(), FIXTURE_SIGNER), { state: { ...live, revoked: true }, outcome: no("revoked") });
add(
  "revoked-bytes-retained",
  "Revoked, and the consumer still holds the stored art. Revocation ends authority, not storage: the verifier says revoked, the consumer keeps the bytes it already stored (they still hash to the bound artHash) and must not compose, export or download with them.",
  signApproval(record(), FIXTURE_SIGNER),
  { state: { ...live, revoked: true }, outcome: no("revoked"), extra: { retained: { artBase64: ART_BYTES.toString("base64"), mustStillHashTo: binding.artHash, mayUse: false } } },
);
const changedFacts = bindStub({ ...stub, event: { ...stub.event, venue: "A different hall" } }, SIZE, { hash: sha256Hex(ART_BYTES), source: "bytes" });
add("stale-facts", "Signed and unexpired, but the owner has since changed a printed fact (the venue). The issuer's current factsHash differs from the bound one: re-approval is needed.", signApproval(record(), FIXTURE_SIGNER), { state: { ...live, current: hashesOf(changedFacts) }, outcome: no("stale") });
const changedMaterial = bindStub({ ...stub, material: "framed" }, "framed", { hash: sha256Hex(ART_BYTES), source: "bytes" });
add("stale-composition", "The owner has since changed the material and size. The issuer's current compositionHash differs.", signApproval(record(), FIXTURE_SIGNER), { state: { ...live, current: hashesOf(changedMaterial) }, outcome: no("stale") });
add("stale-membership", "The account's membershipRevision moved on (signed out everywhere, email change): the approval is stale.", signApproval(record(), FIXTURE_SIGNER), { state: { ...live, membershipRevision: 4 }, outcome: no("stale") });
add("wrong-scope-tenant", "A valid approval for tenant acc_FIXTURE_owner1, presented by a consumer acting for another tenant.", signApproval(record(), FIXTURE_SIGNER), { tenant: "acc_FIXTURE_owner2", state: live, outcome: no("wrong_scope") });
add("wrong-scope-project", "The same tenant's approval for stub_fx_1, presented for stub_fx_2.", signApproval(record(), FIXTURE_SIGNER), { project: { kind: "stub", id: "stub_fx_2" }, state: live, outcome: no("wrong_scope") });
add("wrong-purpose", "An approval to compose the print preview, presented as permission to download the artifact.", signApproval(record(), FIXTURE_SIGNER), { purpose: "artifact.download", state: live, outcome: no("wrong_purpose") });
add(
  "not-a-purchase-authorization",
  "A perfectly valid print.compose approval presented as authority to buy. There is no purchase purpose: approval never authorizes purchase, payment, an order or asset rights, and the signed record says so in notAuthorizes. Purchase authorization is a separate, later record (GT-07).",
  signApproval(record(), FIXTURE_SIGNER),
  { purpose: "order.purchase", state: live, outcome: no("wrong_purpose"), extra: { notAuthorizes: [...NOT_AUTHORIZED] } },
);
add("content-mismatch", "A valid approval, but the consumer holds different art bytes than the ones bound (the file changed after approval).", signApproval(record(), FIXTURE_SIGNER), { held: OTHER_BYTES, state: live, outcome: no("content_mismatch") });
add("unsupported-version", "A correctly signed record with a schema this verifier does not know.", signApproval(record({ schema: "ticketstub.approval/2" }), FIXTURE_SIGNER), { state: live, outcome: no("unsupported_version") });

// "All that apply": print.compose must hold and compare every commitment, artifact.download the art. Each case below is otherwise a valid, live approval.
const PRINT_ALL = ["designHash", "artHash", "factsHash", "compositionHash"];
const download = () => signApproval(record({ id: "apr_FIXTURE_0002", purpose: "artifact.download" }), FIXTURE_SIGNER);
add("content-empty", "A valid print.compose approval, but the consumer supplies no content at all (expect.content = {}). Nothing was compared, so nothing passes.", signApproval(record(), FIXTURE_SIGNER), { state: live, consumer: { empty: true }, outcome: no("content_missing") });
for (const k of PRINT_ALL) add(`content-missing-${k.replace("Hash", "")}`, `A valid print.compose approval, but the consumer leaves out ${k}. print.compose must hold and compare all four commitments.`, signApproval(record(), FIXTURE_SIGNER), { state: live, consumer: { omit: [k] }, outcome: no("content_missing") });
add("content-missing-art-download", "A valid artifact.download approval, but the consumer supplies no artHash (the one commitment this purpose requires), only the other three.", download(), { purpose: "artifact.download", state: live, consumer: { omit: ["artHash"] }, outcome: no("content_missing") });
add("content-art-only-download", "An artifact.download approval where the consumer supplies only artHash. That is all this purpose requires, so it passes.", download(), { purpose: "artifact.download", state: live, consumer: { omit: ["designHash", "factsHash", "compositionHash"] }, outcome: ok });
add("content-malformed-hash", "A valid print.compose approval, but one supplied hash is not 64 lower-case hex characters.", signApproval(record(), FIXTURE_SIGNER), { state: live, consumer: { override: { factsHash: "NOT-A-HASH" } }, outcome: no("content_mismatch") });
add("content-uppercase-hash", "A valid approval, but the consumer supplies the right art hash in upper case. Hashes are lower-case hex; anything else is refused.", signApproval(record(), FIXTURE_SIGNER), { state: live, consumer: { override: { artHash: binding.artHash.toUpperCase() } }, outcome: no("content_mismatch") });
for (const [tag, label] of [["nan", "NaN"], ["infinity", "Infinity"], ["negative", "-1"], ["string", "a string"]]) add(`clock-${tag}`, `The valid-print-compose case, but the consumer's trusted clock is ${label}. A clock that is not a finite number above zero cannot judge expiry, so the answer is invalid_clock.`, signApproval(record(), FIXTURE_SIGNER), { state: live, consumer: { clock: tag }, outcome: no("invalid_clock") });

mkdirSync(here, { recursive: true });
for (const [name, f] of Object.entries(out)) writeFileSync(join(here, `${name}.json`), `${JSON.stringify(f, null, 2)}\n`);
writeFileSync(
  join(here, "fixture-key.json"),
  `${JSON.stringify({ warning: "FIXTURE ONLY. NEVER PRODUCTION. Public on purpose: it signs test approvals that carry mode fixture. Never put it in APPROVAL_SIGNING_KEYS or CONTEXT_SECRET; the server refuses any key containing FIXTURE-ONLY and any kid starting with fixture.", kid: "fixture", alg: "HS256", key: FIXTURE_KEY }, null, 2)}\n`,
);
writeFileSync(
  join(here, "content.json"),
  `${JSON.stringify({ description: "The synthetic stub, size and art bytes every fixture binds, so a consumer can recompute the four hashes itself (see contentHashes in verify.mjs).", size: SIZE, artBase64: ART_BYTES.toString("base64"), stub, bound: { artHash: binding.artHash, designHash: binding.designHash, factsHash: binding.factsHash, compositionHash: binding.compositionHash } }, null, 2)}\n`,
);
const index = { schema: APPROVAL_SCHEMA, purposes: APPROVAL_PURPOSES, key: "fixture-key.json", content: "content.json", verifier: "verify.mjs", fixtures: Object.keys(out).map((n) => `${n}.json`) };
writeFileSync(join(here, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
console.log(`wrote ${Object.keys(out).length} fixtures to ${here}`);
