// GT-06B: the artwork approval, end to end against a running production server, plus the offline fixtures.
//   node scripts/check-approval.mjs <baseUrl>
// Fixture mode only: needs the throwaway database the harness gives the server (TICKETSTUB_DB) for the append-only checks.
// Two accounts (A and B), a guest, and a consumer that holds no cookie and verifies through POST /api/approvals/verify.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { APPROVAL_FAILURES, APPROVAL_PURPOSES, NOT_AUTHORIZED, bindStub, verifyApproval } from "../src/server/approval-token.ts";
import { changesSince, printedLines } from "../src/customer/studio/approval/printed.ts";
import { consumerInputs, runFixture, verifyApproval as refVerify } from "../fixtures/approval/verify.mjs";

const BASE = (process.argv[2] ?? process.env.SMOKE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const DB = process.env.TICKETSTUB_DB ?? "./data/ticketstub.sqlite";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = join(ROOT, "fixtures", "approval");
const run = randomBytes(4).toString("hex");
const responses = [];
const cookies = [];
let failed = 0;
let passed = 0;

function check(name, ok, detail = "") {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` ${detail}`}`);
}

function client(label) {
  const jar = new Map();
  const ip = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
  const api = async (method, path, body, opts = {}) => {
    const headers = { "x-real-ip": ip, ...(opts.origin === null ? {} : { origin: opts.origin ?? BASE }) };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (jar.size && !opts.noCookie) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual", signal: AbortSignal.timeout(20000) });
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split(";");
      const [k, v] = pair.split("=");
      if (/max-age=0/i.test(attrs.join(";")) || v === "") jar.delete(k.trim());
      else {
        jar.set(k.trim(), v);
        cookies.push(v);
      }
    }
    const text = await res.text();
    responses.push(text);
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: res.status, json, text, headers: res.headers };
  };
  const signIn = async (email) => {
    const r = await api("POST", "/api/auth/link", { email, returnTo: "/wall", reason: "save" });
    if (!r.json?.devLink) throw new Error(`${label}: no devLink (${r.status} ${r.text.slice(0, 100)})`);
    return api("POST", "/api/auth/confirm", { token: new URL(r.json.devLink).searchParams.get("token") });
  };
  return { api, signIn, label };
}

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const uniquePng = () => `data:image/png;base64,${Buffer.concat([PNG, randomBytes(8)]).toString("base64")}`;
const sha = (b) => createHash("sha256").update(b).digest("hex");
const now = () => new Date().toISOString();

const stub = (id, title, updatedAt, extra = {}) => ({
  id,
  createdAt: now(),
  event: { type: "concert", title, venue: "Harbour Hall", dateISO: "2026-11-02", facts: [{ id: "f1", label: "Opening song", value: "Lantern", source: "fixture", provenance: "simulated", confidence: 0.9, kept: true }] },
  versions: [
    { id: `${id}-v1`, edition: "classic", art: { kind: "image", src: uniquePng(), seed: 1, provenance: "simulated" }, createdAt: now() },
    { id: `${id}-v2`, parentId: `${id}-v1`, edition: "letterpress", art: { kind: "procedural", seed: 2, provenance: "simulated" }, createdAt: now() },
  ],
  currentVersionId: `${id}-v1`,
  personal: { titleFont: 0, titleColor: "#111111", foilTitle: false, hiddenFields: [], friends: [] },
  material: "print",
  finish: "matte",
  torn: true,
  wallAngle: 0,
  photos: [],
  updatedAt,
  ...extra,
});

const sync = (c, stubs) => c.api("POST", "/api/wall/sync", { stubs, deleted: [] });
const wallStub = (r, id) => r.json.stubs.find((s) => s.id === id);
const sameDenial = (a, b) => a.status === b.status && JSON.stringify(a.json) === JSON.stringify(b.json);
const approve = (c, stubId, extra = {}) => c.api("POST", "/api/approvals", { stubId, purpose: "print.compose", expectedVersionId: `${stubId}-v1`, ...extra });
const list = (c, stubId) => c.api("GET", `/api/approvals?project=stub:${stubId}`);

async function main() {
  // ---------------------------------------------------------------- fixtures, offline
  const keyFile = JSON.parse(readFileSync(join(FIXTURES, "fixture-key.json"), "utf8"));
  const fixtureKeys = { [keyFile.kid]: keyFile.key }; // fixture tokens carry kid "fixture"; a server refuses that kid
  const index = JSON.parse(readFileSync(join(FIXTURES, "index.json"), "utf8"));
  const files = readdirSync(FIXTURES).filter((n) => n.endsWith(".json") && !["fixture-key.json", "index.json", "content.json"].includes(n));
  check("fixtures: the index lists every fixture file", index.fixtures.length === files.length && index.fixtures.every((f) => files.includes(f)));
  check("fixtures: the key is marked fixture only and contains FIXTURE-ONLY", /fixture only|never production/i.test(keyFile.warning) && keyFile.key.includes("FIXTURE-ONLY"));
  const wanted = ["content-empty", "content-missing-design", "content-missing-art", "content-missing-facts", "content-missing-composition", "content-missing-art-download", "content-art-only-download", "content-malformed-hash", "clock-nan", "clock-infinity", "clock-negative", "clock-string", "valid-print-compose", "valid-artifact-download", "unknown-malformed", "unknown-no-record", "forged", "forged-edited-binding", "expired", "revoked", "revoked-bytes-retained", "stale-facts", "stale-composition", "stale-membership", "wrong-scope-tenant", "wrong-scope-project", "wrong-purpose", "not-a-purchase-authorization", "content-mismatch", "unsupported-version", "forged-unknown-kid", "forged-context-key", "unknown-no-kid"];
  check("fixtures: every required case is published", wanted.every((n) => files.includes(`${n}.json`)));
  const fx = {};
  const bad = [];
  for (const f of files) {
    const x = JSON.parse(readFileSync(join(FIXTURES, f), "utf8"));
    fx[x.fixture] = x;
    const inputs = consumerInputs(x); // every hash the consumer computes, and its clock
    const a = verifyApproval(x.token, fixtureKeys, inputs.expect, inputs.now, x.state); // the code the server runs
    const b = runFixture(x, fixtureKeys); // the reference verifier a consumer copies
    const good = (r) => r.ok === x.outcome.ok && (r.ok || r.reason === x.outcome.reason);
    if (!good(a) || !good(b)) bad.push(x.fixture);
  }
  check("fixtures: the server verifier and the reference verifier give each fixture its expected outcome", bad.length === 0, bad.join());
  // Parity on the content and clock rules: the server verifier and the reference helper answer alike for every content shape, both purposes and every clock.
  {
    const v = fx["valid-print-compose"];
    const d = fx["valid-artifact-download"];
    const { expect: pe } = consumerInputs(v);
    const full4 = pe.content;
    const parity = [];
    const shapes = { full: full4, empty: {}, "art only": { artHash: full4.artHash }, "no design": { ...full4, designHash: undefined }, "no art": { ...full4, artHash: undefined }, "no facts": { ...full4, factsHash: undefined }, "no composition": { ...full4, compositionHash: undefined }, "bad hash": { ...full4, factsHash: "nope" }, "upper art": { ...full4, artHash: full4.artHash.toUpperCase() }, "number hash": { ...full4, artHash: 7 }, "wrong hash": { ...full4, designHash: "0".repeat(64) } };
    for (const [label, content] of Object.entries(shapes)) {
      for (const f of [v, d]) {
        const e = { ...f.expect, content };
        const inA = verifyApproval(f.token, fixtureKeys, e, Date.parse(f.verifyAt), f.state);
        const inB = refVerify(f.token, fixtureKeys, e, { now: Date.parse(f.verifyAt), state: f.state });
        if (JSON.stringify([inA.ok, inA.reason]) !== JSON.stringify([inB.ok, inB.reason])) parity.push(`${f.expect.purpose}/${label}: server ${inA.reason ?? "ok"} vs reference ${inB.reason ?? "ok"}`);
      }
    }
    for (const now of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 0, "1791633600000", null, "x"]) {
      const inA = verifyApproval(v.token, fixtureKeys, pe, now, v.state);
      const inB = refVerify(v.token, fixtureKeys, pe, { now, state: v.state });
      if (inA.ok || inB.ok || inA.reason !== "invalid_clock" || inB.reason !== "invalid_clock") parity.push(`clock ${String(now)}: server ${inA.reason ?? "ok"} vs reference ${inB.reason ?? "ok"}`);
    }
    check("fixtures: the server verifier and the reference helper agree on every content shape, both purposes and every bad clock", parity.length === 0, parity.join("; "));
    check("fixtures: print.compose with empty content or any one hash missing never passes, on both verifiers", ["empty", "no design", "no art", "no facts", "no composition", "art only"].every((k) => verifyApproval(v.token, fixtureKeys, { ...v.expect, content: shapes[k] }, Date.parse(v.verifyAt), v.state).reason === "content_missing"));
  }
  const seen = new Set(Object.values(fx).map((x) => (x.outcome.ok ? "ok" : x.outcome.reason)));
  check("fixtures: the outcomes cover ok and every reason", seen.has("ok") && APPROVAL_FAILURES.every((r) => seen.has(r)), APPROVAL_FAILURES.filter((r) => !seen.has(r)).join());
  check("fixtures: the retained-bytes case revokes authority but the bytes still hash to the bound artHash", fx["revoked-bytes-retained"].retained.mayUse === false && sha(Buffer.from(fx["revoked-bytes-retained"].retained.artBase64, "base64")) === fx["revoked-bytes-retained"].retained.mustStillHashTo);
  check("fixtures: approval is not a purchase authorization (wrong_purpose, and the signed record says what it never grants)", fx["not-a-purchase-authorization"].outcome.reason === "wrong_purpose" && !APPROVAL_PURPOSES.some((p) => /purchase|order|pay/.test(p)) && ["purchase", "payment", "order", "asset_rights"].every((x) => NOT_AUTHORIZED.includes(x)));
  const rec = JSON.parse(Buffer.from(fx["valid-print-compose"].token.split(".")[1], "base64url").toString()).approval;
  check("fixtures: a record holds hashes, ids and times only (no art src, note, email or name)", !/data:image|@|note|friends/.test(JSON.stringify(rec)) && rec.mode === "fixture");
  const readme = existsSync(join(FIXTURES, "README.md")) ? readFileSync(join(FIXTURES, "README.md"), "utf8") : "";
  check("fixtures: the README names every reason and says fixture only", APPROVAL_FAILURES.every((r) => readme.includes(r)) && /FIXTURE ONLY/.test(readme));

  const art0 = { hash: "a".repeat(64), source: "ref" };
  const base = stub("fx-p", "Printed", 1);
  const variants = {
    venue: { ...base, event: { ...base.event, venue: "Elsewhere" } },
    seat: { ...base, event: { ...base.event, seat: "Row 4" } },
    keptValue: { ...base, event: { ...base.event, facts: [{ ...base.event.facts[0], value: "Other" }] } },
    keptProvenance: { ...base, event: { ...base.event, facts: [{ ...base.event.facts[0], provenance: "live" }] } },
    unkept: { ...base, event: { ...base.event, facts: [...base.event.facts, { id: "f2", label: "Weather", value: "Rain", source: "x", provenance: "estimated", confidence: 0.5 }] } },
    setlist: { ...base, event: { ...base.event, setlist: [{ title: "Not printed in the facts hash" }] } },
    note: { ...base, personal: { ...base.personal, note: "hi" } },
  };
  const sameLines = (a, b) => JSON.stringify(printedLines(a)) === JSON.stringify(printedLines(b));
  const sameFacts = (a, b) => bindStub(a, "classic", art0).factsHash === bindStub(b, "classic", art0).factsHash;
  check("review: the sheet's printed lines change exactly when the binding's factsHash does (same source)", Object.entries(variants).every(([, v]) => sameLines(base, v) === sameFacts(base, v)) && !sameFacts(base, variants.venue) && !sameFacts(base, variants.keptProvenance) && sameFacts(base, variants.unkept), Object.entries(variants).map(([k, v]) => `${k}:${sameLines(base, v)}/${sameFacts(base, v)}`).join(" "));

  // ---------------------------------------------------------------- the live server
  const A = client("A");
  const B = client("B");
  const consumer = client("consumer");
  const emailA = `approval-a-${run}@example.com`;
  const emailB = `approval-b-${run}@example.com`;
  await A.signIn(emailA);
  await B.signIn(emailB);
  const ctxA = (await A.api("GET", "/api/context")).json.context;
  const S1 = `ap-s1-${run}`;
  const SB = `ap-b1-${run}`;
  const t = Date.now();
  const wallA = await sync(A, [stub(S1, "Approval smoke", t)]);
  const stubA = wallStub(wallA, S1);
  await sync(B, [stub(SB, "B's stub", t)]);
  const artName = /^\/api\/files\/([a-f0-9]{64}\.png)$/.exec(stubA.versions[0].art.src)?.[1];
  check("setup: the synced art became a stored file", !!artName, stubA.versions[0].art.src);
  const bytes = Buffer.from(await (await fetch(`${BASE}/api/files/${artName}`)).arrayBuffer());
  const artHash = sha(bytes);
  check("setup: the consumer can hash the stored bytes itself (the file name is the SHA-256)", artName.startsWith(artHash));

  // --- guards
  const anon = client("anon");
  check("guard: anonymous issue is 404 (a project it can't see)", (await approve(anon, S1)).status === 404);
  check("guard: a guest who owns a stub is 401 (sign in), never an approval", await (async () => {
    const g = client("g2");
    const sh = await g.api("POST", "/api/share", { stub: stub(`ap-g-${run}`, "Guest stub", t) });
    const r = await approve(g, `ap-g-${run}`);
    return sh.status === 200 && r.status === 401 && r.json.error.code === "unauthorized";
  })());
  check("guard: issue without an Origin is 403 bad_origin", (await A.api("POST", "/api/approvals", { stubId: S1, purpose: "print.compose", expectedVersionId: `${S1}-v1` }, { origin: null })).json?.error?.code === "bad_origin");
  check("guard: issue from a foreign Origin is 403 bad_origin", (await A.api("POST", "/api/approvals", { stubId: S1, purpose: "print.compose", expectedVersionId: `${S1}-v1` }, { origin: "https://evil.example" })).json?.error?.code === "bad_origin");
  check("guard: revoke without an Origin is 403", (await A.api("POST", "/api/approvals/revoke", { stubId: S1, approvalId: "x" }, { origin: null })).status === 403);
  check("guard: a body without the purpose, a bad purpose, a missing expected version are 400", (await A.api("POST", "/api/approvals", { stubId: S1, expectedVersionId: `${S1}-v1` })).status === 400 && (await approve(A, S1, { purpose: "order.purchase" })).status === 400 && (await A.api("POST", "/api/approvals", { stubId: S1, purpose: "print.compose" })).status === 400);
  check("guard: a size this material does not print at is 400", (await approve(A, S1, { size: "file" })).status === 400);

  // --- issue
  const r1 = await approve(A, S1);
  const ap1 = r1.json?.approval;
  check("issue: the owner gets a ticketstub.approval/1 record, status active, created, with a token", r1.status === 200 && ap1?.schema === "ticketstub.approval/1" && r1.json.status === "active" && r1.json.created === true && typeof r1.json.token === "string", r1.text.slice(0, 200));
  check("issue: the record binds tenant, project, purpose, the actor and the selected version", ap1.tenant.id === ctxA.tenant.id && ap1.project.kind === "stub" && ap1.project.id === S1 && ap1.purpose === "print.compose" && ap1.actor.id === ctxA.tenant.id && ap1.binding.versionId === `${S1}-v1`);
  check("issue: the art hash is the SHA-256 of the stored bytes", ap1.binding.artSource === "bytes" && ap1.binding.artHash === artHash, ap1.binding.artHash);
  check("issue: four distinct SHA-256 hashes, size and edition in the composition", [ap1.binding.designHash, ap1.binding.artHash, ap1.binding.factsHash, ap1.binding.compositionHash].every((h) => /^[a-f0-9]{64}$/.test(h)) && new Set([ap1.binding.designHash, ap1.binding.factsHash, ap1.binding.compositionHash]).size === 3 && ap1.binding.composition.size === "classic" && ap1.binding.composition.edition === "classic" && ap1.binding.composition.material === "print");
  check("issue: membershipRevision, expiry (seven days) and notAuthorizes are in the record", ap1.membershipRevision === ctxA.membershipRevision && Date.parse(ap1.expiresAt) - Date.parse(ap1.issuedAt) === 7 * 24 * 3600_000 && ["purchase", "payment", "order", "asset_rights"].every((x) => ap1.notAuthorizes.includes(x)));
  check("issue: the mode is sandbox, never fixture or live, in this runtime", ap1.mode === "sandbox", ap1.mode);
  const again = await approve(A, S1);
  check("issue: the same request twice preserves the whole approval and token payload, created false", again.status === 200 && isDeepStrictEqual(again.json.approval, ap1) && again.json.created === false && again.json.token.split(".")[1] === r1.json.token.split(".")[1]);
  const dl = await approve(A, S1, { purpose: "artifact.download" });
  check("issue: another purpose is a separate approval", dl.status === 200 && dl.json.approval.id !== ap1.id && dl.json.approval.purpose === "artifact.download");
  const stale1 = await approve(A, S1, { expectedVersionId: `${S1}-v2` });
  check("issue: approving a version the owner was not looking at is 409 approval_conflict, nothing issued", stale1.status === 409 && stale1.json.error.code === "approval_conflict" && (await list(A, S1)).json.approvals.length === 2);
  const forgedBody = await A.api("POST", "/api/approvals", { stubId: S1, purpose: "print.compose", expectedVersionId: `${S1}-v1`, tenant: "acc_other", binding: { artHash: "0".repeat(64) }, approved: true, expiresAt: "2099-01-01T00:00:00Z" });
  check("issue: tenant, binding, approved and expiry in the body change nothing (the server builds the record)", forgedBody.status === 200 && forgedBody.json.approval.id === ap1.id && forgedBody.json.approval.binding.artHash === artHash);

  // --- list
  const ls = await list(A, S1);
  check("list: the owner sees both approvals, newest first, with status", ls.status === 200 && ls.json.approvals.length === 2 && ls.json.approvals[0].approval.id === dl.json.approval.id && ls.json.approvals.every((a) => a.status === "active"));
  check("list: ?project must name a stub, and anything else is 404", (await list(A, "")).status === 404 && (await A.api("GET", "/api/approvals")).status === 404 && (await A.api("GET", `/api/approvals?project=event:${S1}`)).status === 404);

  // --- A versus B
  const foreignIssue = await approve(B, S1);
  const missingIssue = await approve(B, `ap-nothing-${run}`);
  check("A vs B: B approving A's stub is 404, identical to a stub that does not exist", foreignIssue.status === 404 && sameDenial(foreignIssue, missingIssue), foreignIssue.text);
  const foreignList = await list(B, S1);
  check("A vs B: B listing A's approvals is 404, identical to a missing project", foreignList.status === 404 && sameDenial(foreignList, await list(B, `ap-nothing-${run}`)));
  const foreignRevoke = await B.api("POST", "/api/approvals/revoke", { stubId: S1, approvalId: ap1.id });
  check("A vs B: B revoking A's approval is 404 and changes nothing", foreignRevoke.status === 404 && sameDenial(foreignRevoke, await B.api("POST", "/api/approvals/revoke", { stubId: S1, approvalId: `apr_nope${run}` })) && (await list(A, S1)).json.approvals.every((a) => a.status === "active"));
  const ownStubWithForeignId = await B.api("POST", "/api/approvals/revoke", { stubId: SB, approvalId: ap1.id });
  check("A vs B: B naming its own stub with A's approval id is 404 too", ownStubWithForeignId.status === 404);
  const bOwn = await approve(B, SB);
  check("A vs B: B approves B's own stub, and its approval is B's tenant", bOwn.status === 200 && bOwn.json.approval.tenant.id !== ap1.tenant.id);

  // --- the consumer
  const verify = (token, expect, opts) => consumer.api("POST", "/api/approvals/verify", { token, expect }, { origin: null, noCookie: true, ...opts });
  // What a print consumer computes: all four commitments (print.compose must hold and compare every one).
  const full = (b, over = {}) => ({ designHash: b.designHash, artHash: b.artHash, factsHash: b.factsHash, compositionHash: b.compositionHash, ...over });
  const want = (over = {}) => ({ tenant: ap1.tenant.id, project: `stub:${S1}`, purpose: "print.compose", content: full(ap1.binding), ...over });
  const ok1 = await verify(r1.json.token, want());
  check("verify: the exact scope and the exact bytes verify, with the record back", ok1.status === 200 && ok1.json.ok === true && ok1.json.approval.id === ap1.id && Date.parse(ok1.json.checkedAt) > 0, ok1.text.slice(0, 160));
  const againVerified = await verify(again.json.token, want());
  check("verify: original and re-signed idempotent tokens authenticate the unchanged whole approval", ok1.json.ok === true && againVerified.json.ok === true && isDeepStrictEqual(ok1.json.approval, ap1) && isDeepStrictEqual(againVerified.json.approval, ap1));
  check("verify: it needs no cookie and no Origin (a consumer is not a browser)", ok1.status === 200);
  const reasonOf = (r) => r.json?.reason;
  check("verify: wrong tenant is wrong_scope", reasonOf(await verify(r1.json.token, want({ tenant: bOwn.json.approval.tenant.id }))) === "wrong_scope");
  check("verify: wrong project is wrong_scope", reasonOf(await verify(r1.json.token, want({ project: `stub:${SB}` }))) === "wrong_scope");
  check("verify: B's approval presented for A's stub is wrong_scope", reasonOf(await verify(bOwn.json.token, want())) === "wrong_scope");
  check("verify: wrong purpose is wrong_purpose, and a purchase purpose is never accepted", reasonOf(await verify(r1.json.token, want({ purpose: "artifact.download" }))) === "wrong_purpose" && reasonOf(await verify(r1.json.token, want({ purpose: "order.purchase" }))) === "wrong_purpose" && reasonOf(await verify(r1.json.token, want({ purpose: "payment.authorize" }))) === "wrong_purpose");
  check("verify: bytes that differ from the bound hash are content_mismatch", reasonOf(await verify(r1.json.token, want({ content: full(ap1.binding, { artHash: sha(Buffer.concat([bytes, Buffer.from("x")])) }) }))) === "content_mismatch");
  check("verify: any wrong content hash (design, facts, composition) is content_mismatch", reasonOf(await verify(r1.json.token, want({ content: full(ap1.binding, { factsHash: "0".repeat(64) }) }))) === "content_mismatch" && reasonOf(await verify(r1.json.token, want({ content: full(ap1.binding, { compositionHash: "f".repeat(64) }) }))) === "content_mismatch");
  check("verify: the right facts, design and composition hashes alongside the art verify", (await verify(r1.json.token, want({ content: { artHash, designHash: ap1.binding.designHash, factsHash: ap1.binding.factsHash, compositionHash: ap1.binding.compositionHash } }))).json?.ok === true);
  // --- "all that apply": print.compose holds and compares every commitment, artifact.download the art
  const without = (...ks) => Object.fromEntries(Object.entries(full(ap1.binding)).filter(([k]) => !ks.includes(k)));
  check("verify: print.compose with every missing hash, one at a time, is content_missing (403)", (await Promise.all(["designHash", "artHash", "factsHash", "compositionHash"].map((k) => verify(r1.json.token, want({ content: without(k) }))))).every((r) => r.status === 403 && reasonOf(r) === "content_missing"));
  check("verify: print.compose with only the art hash is content_missing, not ok", reasonOf(await verify(r1.json.token, want({ content: { artHash } }))) === "content_missing");
  check("verify: empty content is refused and never passes", (await verify(r1.json.token, want({ content: {} }))).json?.ok !== true);
  check("verify: a malformed or upper-case hash is refused", (await verify(r1.json.token, want({ content: full(ap1.binding, { factsHash: "xyz" }) }))).json?.ok !== true && (await verify(r1.json.token, want({ content: full(ap1.binding, { artHash: artHash.toUpperCase() }) }))).json?.ok !== true && (await verify(r1.json.token, want({ content: full(ap1.binding, { artHash: 7 }) }))).json?.ok !== true);
  const dlAp = await A.api("POST", "/api/approvals", { stubId: S1, purpose: "artifact.download", expectedVersionId: `${S1}-v1` });
  check("verify: artifact.download with only the art hash is ok, and with no art hash is content_missing", dlAp.status === 200 && (await verify(dlAp.json.token, want({ purpose: "artifact.download", content: { artHash } }))).json?.ok === true && reasonOf(await verify(dlAp.json.token, want({ purpose: "artifact.download", content: without("artHash") }))) === "content_missing" && reasonOf(await verify(dlAp.json.token, want({ purpose: "artifact.download", content: { artHash: sha(Buffer.from("other")) } }))) === "content_mismatch");
  const [h, p, s] = r1.json.token.split(".");
  const changedTime = { ...JSON.parse(Buffer.from(h, "base64url").toString()), signedAt: new Date(Date.parse(ap1.issuedAt) - 1).toISOString() };
  check("verify: changing only signedAt without signing is forged", reasonOf(await verify(`${Buffer.from(JSON.stringify(changedTime)).toString("base64url")}.${p}.${s}`, want())) === "forged");
  const flip = (x) => x.slice(0, -2) + (x.slice(-2) === "AA" ? "BB" : "AA");
  check("verify: a flipped signature is forged", reasonOf(await verify(`${h}.${p}.${flip(s)}`, want())) === "forged");
  const edited = JSON.parse(Buffer.from(p, "base64url").toString());
  edited.approval.binding.artHash = "a".repeat(64);
  edited.approval.tenant.id = "acc_someone_else";
  check("verify: an edited payload (other tenant, other art) is forged", reasonOf(await verify(`${h}.${Buffer.from(JSON.stringify(edited)).toString("base64url")}.${s}`, want())) === "forged");
  check("verify: the published fixture token is forged on this server (the fixture key is never accepted)", reasonOf(await verify(fx["valid-print-compose"].token, { ...want(), tenant: "acc_FIXTURE_owner1", project: "stub:stub_fx_1" })) === "forged");
  const noneAlg = Buffer.from(JSON.stringify({ alg: "none", typ: "ticketstub.approval" })).toString("base64url");
  check("verify: alg none, a context token and garbage are unknown", reasonOf(await verify(`${noneAlg}.${p}.${s}`, want())) === "unknown" && reasonOf(await verify(`${noneAlg}.${p}.`, want())) === "unknown" && reasonOf(await verify("nope", want())) === "unknown" && reasonOf(await verify((await A.api("GET", "/api/context")).json.token, want())) === "unknown");
  check("verify: a context token cannot pass as an approval, and an approval is not a context token", (await consumer.api("POST", "/api/context/verify", { token: r1.json.token }, { origin: null })).json?.ok !== true);
  check("verify: it refuses a request that names no tenant, project or purpose, or holds no content (400)", (await verify(r1.json.token, { project: `stub:${S1}`, purpose: "print.compose", content: { artHash } })).status === 400 && (await verify(r1.json.token, { tenant: ap1.tenant.id, purpose: "print.compose", content: { artHash } })).status === 400 && (await verify(r1.json.token, { tenant: ap1.tenant.id, project: `stub:${S1}`, content: { artHash } })).status === 400 && (await verify(r1.json.token, { tenant: ap1.tenant.id, project: `stub:${S1}`, purpose: "print.compose" })).status === 400 && (await verify(r1.json.token, want({ content: {} }))).status === 400 && (await verify(r1.json.token, want({ content: { artHash: "nothex" } }))).status === 400);
  check("verify: a rejection is 403 with ok false, a reason from the list and the one error envelope", await (async () => {
    const r = await verify(r1.json.token, want({ purpose: "artifact.download" }));
    return r.status === 403 && r.json.ok === false && APPROVAL_FAILURES.includes(r.json.reason) && r.json.error.code === "approval_invalid" && typeof r.json.error.message === "string";
  })());
  check("verify: a body without a token is 400", (await consumer.api("POST", "/api/approvals/verify", {}, { origin: null })).status === 400);

  // --- stale after an edit: the same stub, a different printed fact
  const edit = stub(S1, "Approval smoke", t + 5000, { event: { ...stubA.event, venue: "A different hall" }, versions: stubA.versions });
  await sync(A, [edit]);
  const afterEdit = await list(A, S1);
  check("stale: after the venue changes, the old approval reads stale in the list", afterEdit.json.approvals.every((a) => a.status === "stale"), afterEdit.json.approvals.map((a) => a.status).join());
  const staleVerify = await verify(r1.json.token, want());
  check("stale: and the verifier says stale, even though the bytes and scope are right", reasonOf(staleVerify) === "stale" && staleVerify.status === 403);
  const re = await approve(A, S1);
  check("stale: re-approving makes a new approval with a different factsHash; the old one is kept and still stale", re.status === 200 && re.json.created === true && re.json.approval.id !== ap1.id && re.json.approval.binding.factsHash !== ap1.binding.factsHash && re.json.approval.binding.artHash === artHash);
  const lsRe = await list(A, S1);
  check("stale: the list holds the history (3 records), the newest active and the old ones stale", lsRe.json.approvals.length === 3 && lsRe.json.approvals[0].status === "active" && lsRe.json.approvals.filter((a) => a.status === "stale").length === 2);
  check("stale: the new approval verifies against the new facts", (await verify(re.json.token, want({ content: full(re.json.approval.binding) }))).json?.ok === true && reasonOf(await verify(re.json.token, want())) === "content_mismatch");

  // --- other edits stale it: material/size, selected version, art
  await sync(A, [stub(S1, "Approval smoke", t + 6000, { event: edit.event, versions: stubA.versions, material: "framed" })]);
  check("stale: changing the material stales the approval (composition)", (await list(A, S1)).json.approvals[0].status === "stale");
  await sync(A, [stub(S1, "Approval smoke", t + 7000, { event: edit.event, versions: stubA.versions, material: "print", personal: { ...stubA.personal, titleColor: "#ff0000" } })]);
  check("stale: changing the title colour stales it (personalization is composition)", (await list(A, S1)).json.approvals[0].status === "stale");
  await sync(A, [stub(S1, "Approval smoke", t + 8000, { event: edit.event, versions: stubA.versions, currentVersionId: `${S1}-v2` })]);
  check("stale: selecting another version stales it, and approving v1 now is a conflict", (await list(A, S1)).json.approvals[0].status === "stale" && (await approve(A, S1)).status === 409);
  const v2 = await approve(A, S1, { expectedVersionId: `${S1}-v2` });
  check("stale: v2 (procedural art) is approved by reference, not bytes", v2.status === 200 && v2.json.approval.binding.artSource === "ref" && v2.json.approval.binding.versionId === `${S1}-v2`);
  await sync(A, [stub(S1, "Approval smoke", t + 9000, { event: edit.event, versions: stubA.versions, currentVersionId: `${S1}-v1`, personal: stubA.personal })]);
  check("stale: undoing every edit makes the exact original binding valid again (the binding is content, not time)", (await verify(re.json.token, want({ content: full(re.json.approval.binding) }))).json?.ok === true);
  const friends = await sync(A, [stub(S1, "Approval smoke", t + 10000, { event: edit.event, versions: stubA.versions, personal: { ...stubA.personal, friends: [{ name: "Pat", claimed: false }] }, wallAngle: 3 })]);
  check("stale: friends and wall position are not printed, so editing them does not stale an approval", friends.status === 200 && (await list(A, S1)).json.approvals.some((a) => a.approval.id === re.json.approval.id && a.status === "active"));

  // --- revoke
  const ac = (await list(A, S1)).json.approvals.find((a) => a.approval.id === re.json.approval.id);
  check("revoke: the approval to revoke is active first", ac?.status === "active");
  const rv = await A.api("POST", "/api/approvals/revoke", { stubId: S1, approvalId: re.json.approval.id });
  check("revoke: the owner revokes it", rv.status === 200 && rv.json.revoked === true && rv.json.already === false, rv.text);
  const rvAgain = await A.api("POST", "/api/approvals/revoke", { stubId: S1, approvalId: re.json.approval.id });
  check("revoke: revoking twice is idempotent (already true)", rvAgain.status === 200 && rvAgain.json.already === true);
  const revoked = await verify(re.json.token, want({ content: full(re.json.approval.binding) }));
  check("revoke: the verifier now says revoked, 403", reasonOf(revoked) === "revoked" && revoked.status === 403);
  check("revoke: the list keeps the record, with status revoked and a revokedAt", (await list(A, S1)).json.approvals.some((a) => a.approval.id === re.json.approval.id && a.status === "revoked" && typeof a.revokedAt === "string"));
  const afterRevoke = await fetch(`${BASE}/api/files/${artName}`);
  check("revoke: the stored art bytes are kept and still hash to the bound artHash", afterRevoke.status === 200 && sha(Buffer.from(await afterRevoke.arrayBuffer())) === re.json.approval.binding.artHash);
  const reissue = await approve(A, S1);
  check("revoke: approving the same content again after a revoke is a new approval (the revoked one is not resurrected)", reissue.status === 200 && reissue.json.created === true && reissue.json.approval.id !== re.json.approval.id);
  check("revoke: that new approval verifies and the revoked one still does not", (await verify(reissue.json.token, want({ content: full(reissue.json.approval.binding) }))).json?.ok === true && reasonOf(await verify(re.json.token, want({ content: full(re.json.approval.binding) }))) === "revoked");

  // --- the review sheet's owner-only projection (GT-06B.1): what was printed, and what differs now
  const hist = (await list(A, S1)).json.approvals;
  const hOld = hist.find((a) => a.approval.id === ap1.id);
  const hNew = hist.find((a) => a.approval.id === reissue.json.approval.id);
  const printedOf = (a) => Object.fromEntries((a?.summary?.printed ?? []).map((l) => [l.key, l.value]));
  check("review: the owner's list carries what each approval printed (title, venue, date, the kept fact with its provenance)", printedOf(hOld).venue === "Harbour Hall" && printedOf(hNew).venue === "A different hall" && printedOf(hNew).title === "Approval smoke" && printedOf(hNew).dateISO === "2026-11-02" && printedOf(hNew)["fact:f1"] === "Lantern" && hNew.summary.printed.find((l) => l.key === "fact:f1")?.provenance === "simulated", JSON.stringify(hNew?.summary));
  check("review: the issue response carries the same summary and a drift of all false", reissue.json.summary?.printed?.length === hNew.summary.printed.length && Object.values(reissue.json.drift ?? { x: true }).every((v) => v === false));
  check("review: drift names what differs now (the first approval: facts changed since, art and version did not)", hOld.drift?.facts === true && hOld.drift.art === false && hOld.drift.version === false && Object.values(hNew.drift).every((v) => v === false), JSON.stringify([hOld.drift, hNew.drift]));
  const diffOld = changesSince({ id: hOld.approval.id, status: hOld.status, binding: hOld.approval.binding, summary: hOld.summary, drift: hOld.drift }, { printed: hNew.summary.printed, composition: hNew.approval.binding.composition });
  check("review: the diff says which fact changed in plain words, and detects nothing else", diffOld.items.join("|") === "Facts: Venue changed", diffOld.items.join("|"));
  const diffNone = changesSince({ id: hNew.approval.id, status: "revoked", binding: hNew.approval.binding, summary: hNew.summary, drift: hNew.drift }, { printed: hNew.summary.printed, composition: hNew.approval.binding.composition });
  const finish = { ...hNew.approval.binding.composition, finish: "foil" };
  const diffFinish = changesSince({ id: hNew.approval.id, status: "active", binding: hNew.approval.binding, summary: hNew.summary, drift: { ...hNew.drift, composition: true } }, { printed: hNew.summary.printed, composition: finish });
  check("review: no differences reads as same, a finish change as 'Finish: Matte → Foil', no earlier approval as first", diffNone.same === true && diffFinish.items.join("|") === "Finish: Matte → Foil" && changesSince(undefined, { printed: [], composition: finish }).first === true);
  const oldRow = { id: "apr_old", status: "stale", binding: hNew.approval.binding, summary: null, drift: { version: false, art: false, design: false, facts: true, composition: false } };
  check("review: an approval from before summaries (none stored) can only say 'Facts changed'", changesSince(oldRow, { printed: hNew.summary.printed, composition: hNew.approval.binding.composition }).items.join("|") === "Facts changed");
  const bHist = (await list(B, SB)).json.approvals;
  check("review: B sees only B's summaries, and A's list never holds B's content", bHist.length === 1 && printedOf(bHist[0]).title === "B's stub" && !JSON.stringify(hist).includes("B's stub") && !JSON.stringify(bHist).includes("Approval smoke"));
  check("review: the summary never reaches the token or the verifier (no summary, drift, venue or title in any verify answer or token body)", ![ok1.text, revoked.text, staleVerify.text].some((x) => /"summary"|"drift"|Harbour Hall|Approval smoke|Lantern/.test(x)) && [r1.json.token, re.json.token, reissue.json.token].every((tk) => !/summary|drift|Harbour Hall|Lantern/.test(Buffer.from(tk.split(".")[1], "base64url").toString())));
  const dbS = new DatabaseSync(DB);
  let updSum = "";
  try {
    dbS.prepare("UPDATE approval_summaries SET summary = '{}' WHERE approval_id = ?").run(re.json.approval.id);
  } catch (e) {
    updSum = String(e.message);
  }
  dbS.close();
  check("review: a stored summary can't be rewritten (append-only)", /append-only/.test(updSum), updSum);

  // --- purchase is separate
  const srcOf = (f) => (existsSync(join(ROOT, f)) ? readFileSync(join(ROOT, f), "utf8") : "");
  check("separate: no order, checkout or commerce code reads an approval", !/approval/i.test(srcOf("src/app/api/orders/route.ts") + srcOf("src/customer/pages/commerce.ts") + srcOf("src/customer/pages/capabilities.ts")));
  const order = { stubIds: [S1], lines: [{ title: "Print", material: "print", finish: "matte", size: "classic", totalMinor: 4900 }], totalMinor: 4900, method: "card", email: emailA };
  const plain = await A.api("POST", "/api/orders", { order });
  const withApproval = await A.api("POST", "/api/orders", { order, approvalToken: reissue.json.token, approvalId: reissue.json.approval.id });
  check("separate: an approval attached to an order changes nothing about it (the same answer without it)", plain.status === withApproval.status && plain.json?.error?.code === withApproval.json?.error?.code, `${plain.status} vs ${withApproval.status}`);
  check("separate: the approval projection says it never authorizes purchase, payment, order or asset rights", reissue.json.approval.notAuthorizes.join() === "purchase,payment,order,asset_rights");

  // --- events and secrets
  const ev = await A.api("GET", `/api/events?project=stub:${S1}`);
  const types = (ev.json?.events ?? []).map((e) => e.type);
  check("events: approval_issued and approval_revoked are in the owner's history", ["approval_issued", "approval_revoked"].every((x) => types.includes(x)), types.join());
  const evA = ev.json.events.filter((e) => e.type.startsWith("approval_"));
  check("events: they carry a purpose, a 16-hex ref and flags only", evA.every((e) => Object.entries(e.fields).every(([k, v]) => (k === "purpose" && APPROVAL_PURPOSES.includes(v)) || (k === "approval" && /^[a-f0-9]{16}$/.test(v)) || typeof v === "boolean")));
  check("events: no approval id, token, hash or email in the history", ![re.json.approval.id, re.json.token, artHash, ap1.binding.factsHash, emailA].some((v) => ev.text.includes(v)));
  const joined = responses.join("\n");
  const secrets = ["FIXTURE-ONLY", "CONTEXT_SECRET", "APPROVAL_SIGNING_KEYS", "__ticketstubKeyringFallback", "membership_revision", "__ticketstubContextKey", "RESEND_API_KEY", "OPENAI_API_KEY", ...cookies.filter((c) => c.length > 20)];
  check("secrets: no response carries a key, a session or device cookie, or an internal name", !secrets.some((v) => joined.includes(v)), secrets.filter((v) => joined.includes(v)).join().slice(0, 100));
  const tokens = [...joined.matchAll(/"token":"([^"]+)"/g)].map((m) => m[1]).filter((tk) => tk.split(".").length === 3 && JSON.parse(Buffer.from(tk.split(".")[0], "base64url").toString()).typ === "ticketstub.approval");
  const bodies = tokens.map((tk) => JSON.parse(Buffer.from(tk.split(".")[1], "base64url").toString()));
  check("secrets: an approval token body holds only the record (no session reference, no email, no art url)", tokens.length > 0 && bodies.every((b) => Object.keys(b).join() === "approval" && !/"sid"|@|\/api\/files|data:/.test(JSON.stringify(b))));
  const heads = tokens.map((tk) => JSON.parse(Buffer.from(tk.split(".")[0], "base64url").toString()));
  check("keys: every approval token names its sandbox kid and canonical actual signing time", heads.length > 0 && heads.every((h) => {
    const signedAt = typeof h.signedAt === "string" ? Date.parse(h.signedAt) : NaN;
    return Object.keys(h).sort().join() === "alg,kid,signedAt,typ" && h.alg === "HS256" && h.typ === "ticketstub.approval" && h.kid === "sandbox"
      && Number.isFinite(signedAt) && signedAt > 0 && new Date(signedAt).toISOString() === h.signedAt;
  }), JSON.stringify(heads[0]));
  const emails = [emailA, emailB];
  check("secrets: no approval response carries an account email", !emails.some((e) => [r1.text, ls.text, ok1.text, rv.text].some((x) => x.includes(e))));

  // --- append-only, and deletion
  const db = new DatabaseSync(DB);
  const rows = Number(db.prepare("SELECT COUNT(*) AS n FROM approvals").get().n);
  let upd = "";
  let del = "";
  let updRev = "";
  try {
    db.prepare("UPDATE approvals SET purpose = 'artifact.download' WHERE id = ?").run(re.json.approval.id);
  } catch (e) {
    upd = String(e.message);
  }
  try {
    db.prepare("DELETE FROM approvals WHERE id = ?").run(re.json.approval.id);
  } catch (e) {
    del = String(e.message);
  }
  try {
    db.prepare("UPDATE approval_revocations SET revoked_at = 1 WHERE approval_id = ?").run(re.json.approval.id);
  } catch (e) {
    updRev = String(e.message);
  }
  check("append-only: UPDATE on approvals and revocations is refused by the database, and DELETE while the account exists", /append-only/.test(upd) && /kept while/.test(del) && /append-only/.test(updRev), `${upd} | ${del} | ${updRev}`);
  check("append-only: a revoked approval row is still there (revocation is a new row)", Number(db.prepare("SELECT COUNT(*) AS n FROM approvals").get().n) === rows && Number(db.prepare("SELECT COUNT(*) AS n FROM approval_revocations WHERE approval_id = ?").get(re.json.approval.id).n) === 1);

  const C = client("C");
  const emailC = `approval-c-${run}@example.com`;
  await C.signIn(emailC);
  const SC = `ap-c1-${run}`;
  await sync(C, [stub(SC, "C stub", t)]);
  const cAp = await approve(C, SC);
  const cTenant = cAp.json.approval.tenant.id;
  const del2 = await C.api("DELETE", "/api/account", { confirm: emailC });
  check("delete: deleting the account succeeds", del2.status === 200, del2.text.slice(0, 120));
  check("delete: its approvals and revocations leave with it, and the verifier no longer knows them", Number(db.prepare("SELECT COUNT(*) AS n FROM approvals WHERE tenant = ?").get(cTenant).n) === 0 && reasonOf(await verify(cAp.json.token, { tenant: cTenant, project: `stub:${SC}`, purpose: "print.compose", content: { artHash: cAp.json.approval.binding.artHash } })) === "unknown");
  check("delete: other accounts' approvals are untouched", Number(db.prepare("SELECT COUNT(*) AS n FROM approvals WHERE tenant = ?").get(ap1.tenant.id).n) >= 3);
  db.close();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(`FAIL approval check crashed: ${e instanceof Error ? e.stack : e}`);
  process.exit(1);
});
