// GT-FIN-001..003 against a running production server: the /2 context, the explicit finance grants, the selected
// project, the verification port, and byte-for-byte reason parity between POST /api/context/verify and the offline
// verifier (fixtures/context/verify.mjs) on every malformed shape.
//   node scripts/check-finance-context.mjs <base-url>
// Env: CONTEXT_SECRET (the server's, so this script can sign the malformed corpus the way the issuer would),
// CHECK_STAFF_EMAIL (an address on the server's ADMIN_EMAILS). scripts/verify-product.mjs sets both.
import { randomBytes } from "node:crypto";
import { signContext } from "../src/server/context-token.ts";
import { FINANCE_CAPS, verifyContext, toFinanceScope, authorizesFinance } from "../fixtures/context/verify.mjs";
import { BOUNDARY, MALFORMED, malformedContexts, v1Base, v2Base, wrongTypeSchemaContexts } from "../fixtures/context/corpus.mjs";

const BASE = process.argv[2];
const SECRET = process.env.CONTEXT_SECRET;
const STAFF = process.env.CHECK_STAFF_EMAIL;
if (!BASE || !SECRET || !STAFF) {
  console.error("usage: CONTEXT_SECRET=... CHECK_STAFF_EMAIL=... node scripts/check-finance-context.mjs <base-url>");
  process.exit(2);
}

let passed = 0;
let failed = 0;
function check(name, ok, detail = "") {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` ${detail}`}`);
}

function client() {
  const jar = new Map();
  const ip = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
  const api = async (method, path, body) => {
    const headers = { "x-real-ip": ip, origin: BASE };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual", signal: AbortSignal.timeout(20000) });
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split(";");
      const [k, v] = pair.split("=");
      if (/max-age=0/i.test(attrs.join(";")) || v === "") jar.delete(k.trim());
      else jar.set(k.trim(), v);
    }
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: res.status, json, text };
  };
  const signIn = async (email) => {
    const r = await api("POST", "/api/auth/link", { email, returnTo: "/wall", reason: "save" });
    if (!r.json?.devLink) throw new Error(`no devLink for ${email} (${r.status})`);
    return api("POST", "/api/auth/confirm", { token: new URL(r.json.devLink).searchParams.get("token") });
  };
  return { api, signIn };
}

const run = randomBytes(4).toString("hex");
const stub = (id, title) => ({
  id,
  createdAt: new Date().toISOString(),
  event: { type: "concert", title, facts: [] },
  versions: [{ id: `${id}-v1`, edition: "classic", art: { kind: "procedural", seed: 1, provenance: "simulated" }, createdAt: new Date().toISOString() }],
  currentVersionId: `${id}-v1`,
  personal: { titleFont: 0, titleColor: "#000", foilTitle: false, hiddenFields: [], friends: [] },
  material: "card",
  finish: "matte",
  torn: true,
  wallAngle: 0,
  photos: [],
  updatedAt: Date.now() - 3_600_000,
});
const ctx2 = (c, project) => c.api("GET", `/api/context?v=2${project ? `&project=${encodeURIComponent(project)}` : ""}`);
const COMMANDS = FINANCE_CAPS.filter((c) => c.startsWith("finance.command."));

async function main() {
  const anon = client();
  const X = client();
  const Y = client();
  const S = client();
  const W = client();
  await X.signIn(`fin-x-${run}@example.com`);
  await Y.signIn(`fin-y-${run}@example.com`);
  await S.signIn(STAFF);
  await W.signIn(`fin-w-${run}@example.com`);
  // The port is rate limited per address (120 a minute), and the corpus is larger than that: rotate the caller.
  let verifier = client();
  let sent = 0;
  const verify = (token, extra = {}) => {
    if (++sent % 90 === 0) verifier = client();
    return verifier.api("POST", "/api/context/verify", { token, audience: "ticketstub.finance", ...extra });
  };

  // --- versions: /1 stays the default, /2 is asked for
  const d = await anon.api("GET", "/api/context");
  check("/api/context still answers ticketstub.context/1 by default", d.status === 200 && d.json.context.schema === "ticketstub.context/1" && d.json.context.mode !== undefined);
  check("?v=3 is a 400", (await anon.api("GET", "/api/context?v=3")).status === 400);
  const a2 = await ctx2(anon);
  check("/2 anonymous: schema /2, actor anonymous:0, no finance grants, no v1 mode field", a2.status === 200 && a2.json.context.schema === "ticketstub.context/2" && a2.json.context.actor.id === "anonymous:0" && a2.json.context.mode === undefined && !a2.json.context.capabilities.some((c) => c.startsWith("finance.")));

  // --- injective ids and separate mode axes, from the server's own configuration
  const x2 = await ctx2(X);
  const c = x2.json.context;
  check("/2 account: actor and tenant are the kind-prefixed account id", c.actor.kind === "account" && c.actor.id.startsWith("account:") && c.tenant.id === c.actor.id && c.actor.id.length > 10);
  check("/2 modes: environment, economicMode and evidenceMode are three separate fields", c.environment === "preview" && c.economicMode === "none" && c.evidenceMode === "synthetic", `${c.environment}/${c.economicMode}/${c.evidenceMode}`);
  check("/2 an ordinary account holds no finance grant (role owner of its own tenant confers none)", c.role === "owner" && !c.capabilities.some((x) => x.startsWith("finance.")));
  check("/2 carries issuer and audience", c.issuer === "getticketstub.com" && c.audience === "ticketstub.finance");

  // --- selected project: the server proves it, the body and query never grant it
  const ev = (await X.api("POST", "/api/organizer/events", { title: "Finance event", stub: stub(`ev-${run}`, "Finance event"), guests: [{ name: "G" }] })).json;
  const stubId = `st-${run}`;
  await X.api("POST", "/api/wall/sync", { stubs: [stub(stubId, "Finance stub")], deleted: [] });
  const evCtx = await ctx2(X, `event:${ev.eventId}`);
  const e = evCtx.json?.context;
  check("selected event: the captain's /2 context is bound to that project with a kind-prefixed ref", evCtx.status === 200 && e.role === "captain" && e.project.id === ev.eventId && e.project.ref === `event:${ev.eventId}`);
  check("selected event: captain holds finance.read and finance.export, and no finance.command.*", FINANCE_CAPS.slice(0, 2).every((g) => e.capabilities.includes(g)) && !COMMANDS.some((g) => e.capabilities.includes(g)));
  const stubCtx = await ctx2(X, `stub:${stubId}`);
  check("selected stub: the owner holds no finance grant", stubCtx.status === 200 && stubCtx.json.context.role === "owner" && !stubCtx.json.context.capabilities.some((g) => g.startsWith("finance.")));
  const foreign = await ctx2(Y, `event:${ev.eventId}`);
  const missing = await ctx2(Y, `event:evt_nothing${run}`);
  check("another account selecting that event is 404, identical to a project that does not exist", foreign.status === 404 && foreign.text === missing.text);
  check("an anonymous caller selecting a project is 404", (await ctx2(anon, `event:${ev.eventId}`)).status === 404);
  check("a tenant, role, audience or grant in the query changes nothing", (await Y.api("GET", `/api/context?v=2&project=event:${ev.eventId}&tenant=${c.tenant.id}&role=captain&capabilities=finance.read&audience=x`)).status === 404);

  // --- staff: platform scope, every command; nothing on a project they do not hold
  const st = await ctx2(S);
  check("staff platform context holds every finance grant and role staff is informational only", st.json.context.role === "staff" && FINANCE_CAPS.every((g) => st.json.context.capabilities.includes(g)) && st.json.context.project === undefined);
  check("staff selecting someone else's event is 404 (no finance reach into a project)", (await ctx2(S, `event:${ev.eventId}`)).status === 404);

  // --- the verification port
  const v = await verify(evCtx.json.token);
  check("verify: a fresh /2 token verifies with the same context", v.status === 200 && v.json.ok === true && v.json.context.project.ref === e.project.ref && v.json.context.economicMode === "none");
  const back = verifyContext(evCtx.json.token, SECRET, { now: Date.now(), audience: "ticketstub.finance" });
  check("verify: the offline verifier accepts the same token with the issuer's key", back.ok === true && back.ctx.actor.id === e.actor.id);
  check("verify: the right audience passes, another host is wrong_audience (401)", (await verify(evCtx.json.token, { audience: "ticketstub.finance" })).status === 200 && (await verify(evCtx.json.token, { audience: "another-host" })).json?.reason === "wrong_audience");
  check("verify: a non-string audience is a 400", (await verify(evCtx.json.token, { audience: 7 })).status === 400);
  check("verify: authorizesFinance accepts the issued token for its project and denies a command", authorizesFinance(back.ctx, { tenant: e.tenant.id, project: { kind: "event", id: ev.eventId }, capability: "finance.read" }) && !authorizesFinance(back.ctx, { tenant: e.tenant.id, project: { kind: "event", id: ev.eventId }, capability: "finance.command.budget_change" }));
  const mapped = toFinanceScope(back.ctx);
  check("verify: the issued context maps to a versioned adapter result (none/preview/synthetic -> simulated/test/sandbox), evidence beside a five-field scope", mapped.ok === true && mapped.schema === "ticketstub.finance-scope-adapter/1" && mapped.scope.billingMode === "simulated" && mapped.scope.environment === "test" && mapped.evidenceMode === "sandbox" && mapped.scope.projectId === `event:${ev.eventId}` && Object.keys(mapped.scope).length === 5 && !("evidenceMode" in mapped.scope));

  // --- current membership and revocation, through the live port
  const wEvent = (await W.api("POST", "/api/organizer/events", { title: "W event", stub: stub(`wev-${run}`, "W event"), guests: [{ name: "G" }] })).json;
  const wStub = `wst-${run}`;
  await W.api("POST", "/api/wall/sync", { stubs: [stub(wStub, "W stub")], deleted: [] });
  const wTokStub = (await ctx2(W, `stub:${wStub}`)).json.token;
  const wTokEvent = (await ctx2(W, `event:${wEvent.eventId}`)).json.token;
  check("membership: both tokens verify while the account holds the projects", (await verify(wTokStub)).status === 200 && (await verify(wTokEvent)).status === 200);
  await W.api("POST", "/api/wall/sync", { stubs: [], deleted: [wStub] });
  const lost = await verify(wTokStub);
  check("membership: a stub the account no longer holds makes its /2 token revoked, though the session lives", lost.status === 401 && lost.json.reason === "revoked");
  check("membership: the account's other project token is unaffected", (await verify(wTokEvent)).status === 200);
  const signedOut = await W.api("POST", "/api/auth/signout", {});
  check("revocation: sign-out makes the /2 token revoked", signedOut.status === 200 && (await verify(wTokEvent)).json?.reason === "revoked");

  // --- parity: identical malformed input, identical reason, from the server and from verify.mjs
  const corpus = malformedContexts();
  const noAud = await verify(evCtx.json.token, { audience: undefined }); // a /2 verifier must name its audience
  const noAudOffline = verifyContext(evCtx.json.token, SECRET, { now: Date.now() });
  check("verify: a /2 token with no expected audience is refused (401 wrong_audience), by the server and by verify.mjs alike", noAud.status === 401 && noAud.json?.reason === "wrong_audience" && noAudOffline.ok === false && noAudOffline.reason === "wrong_audience");
  let bad = [];
  for (const { name, ctx } of corpus) {
    const token = signContext(ctx, SECRET, null);
    const server = await verify(token);
    const offline = verifyContext(token, SECRET, { now: Date.now(), audience: "ticketstub.finance" });
    if (!(server.status === 401 && server.json?.reason === "unknown" && offline.ok === false && offline.reason === server.json.reason)) bad.push(`${name}: server ${server.status} ${server.json?.reason}, offline ${offline.reason}`);
  }
  check(`parity: all ${corpus.length} malformed shapes (the seven GT-FIN-003 shapes, the /2 ones, and the wrong-typed enums) are unknown from the server and from verify.mjs`, bad.length === 0 && corpus.length === MALFORMED.length, bad.join(" | "));
  // GT-V2-FIN-003: wrong-typed enums are in the corpus above; a wrong-typed `schema` is unsupported_version from both.
  const schemaBad = [];
  for (const { name, ctx } of wrongTypeSchemaContexts()) {
    const token = signContext(ctx, SECRET, null);
    const server = await verify(token);
    const offline = verifyContext(token, SECRET, { now: Date.now(), audience: "ticketstub.finance" });
    if (!(server.status === 401 && server.json?.reason === "unsupported_version" && offline.ok === false && offline.reason === "unsupported_version")) schemaBad.push(`${name}: server ${server.status} ${server.json?.reason}, offline ${offline.reason}`);
  }
  check("parity: a wrong-typed schema (array, object, null, number, boolean; /1 and /2) is unsupported_version from the server and from verify.mjs", schemaBad.length === 0, schemaBad.join(" | "));
  // GT-V2-FIN-002: the length boundary through the port. An account token needs a live session, so the same prefixed
  // lengths are carried by a guest (6-character prefix, same total length) under the server's own modes. The server
  // verifies all of them; the adapter then accepts exactly the ones that fit Finance's 128.
  const boundaryBad = [];
  for (const [name, , bctx, tooLong] of BOUNDARY) {
    const gid = bctx.actor.id.length > 40 ? `guest:${"a".repeat(Math.min(bctx.actor.id.length - 6, 128))}` : "guest:fxboundary0000001";
    const g = {
      ...bctx,
      actor: { kind: "guest", id: gid },
      tenant: { id: gid },
      role: "none",
      capabilities: bctx.capabilities.filter((c) => !c.startsWith("finance.")),
      environment: "preview",
      economicMode: "none",
      evidenceMode: "synthetic",
      issuedAt: new Date(Date.now()).toISOString(),
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    };
    const server = await verify(signContext(g, SECRET, null));
    const r = server.json?.ok ? toFinanceScope(server.json.context) : undefined;
    const fits = g.actor.id.length <= 128 && (g.project?.ref.length ?? 0) <= 128;
    if (!(server.status === 200 && r && r.ok === fits && r.ok === !tooLong && (r.ok ? r.scope.actorId.length <= 128 && r.scope.projectId.length <= 128 : r.reason === "identifier_too_long" && !("scope" in r)))) boundaryBad.push(`${name}: ${server.status} ${JSON.stringify(r)}`);
  }
  check(`boundary: ${BOUNDARY.length} prefixed-id lengths (128, 129, 128 raw; actor and project) verify through the port, and the adapter accepts exactly the ones that fit`, boundaryBad.length === 0, boundaryBad.join(" | "));
  const now = Date.now();
  const fresh = (over) => ({ ...v2Base(), issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 300_000).toISOString(), ...over });
  const other = [
    ["forged (other key)", signContext(fresh({}), "another-key-0000000000000000000000000", null), {}, "forged"],
    ["expired", signContext(fresh({ issuedAt: new Date(now - 700_000).toISOString(), expiresAt: new Date(now - 400_000).toISOString() }), SECRET, null), {}, "expired"],
    ["unsupported_version", signContext({ ...fresh({}), schema: "ticketstub.context/3" }, SECRET, null), {}, "unsupported_version"],
    ["revoked flag", signContext(fresh({ revoked: true }), SECRET, null), {}, "revoked"],
    ["wrong_audience (named by the verifier)", signContext(fresh({}), SECRET, null), { audience: "another-host" }, "wrong_audience"],
  ];
  for (const [name, token, extra, reason] of other) {
    const server = await verify(token, extra);
    const offline = verifyContext(token, SECRET, { now: Date.now(), audience: "audience" in extra ? extra.audience : "ticketstub.finance" });
    check(`parity: ${name} is ${reason} from both`, server.status === 401 && server.json?.reason === reason && offline.ok === false && offline.reason === reason, `server ${server.json?.reason}, offline ${offline.reason}`);
  }
  const v1 = { ...v1Base(), issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 300_000).toISOString() };
  check("parity: a /1 token with a missing actor id is unknown from both", (await verify(signContext({ ...v1, actor: { kind: "account" } }, SECRET, null))).json?.reason === "unknown");
  check("a /2 token minted for a different audience than the server's is wrong_audience from the server alone", (await verify(signContext(fresh({ audience: "someone-elses-host" }), SECRET, null))).json?.reason === "wrong_audience");
  check("the published fixture key is not accepted for /2 either", (await verify(signContext(v2Base(), "FIXTURE-ONLY-NEVER-PRODUCTION--ticketstub-context-key-v1", null))).json?.reason === "forged");

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(`FAIL ${err instanceof Error ? err.stack : err}`);
  process.exit(1);
});
