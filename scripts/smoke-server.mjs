// Repeatable smoke test for the account API. Run the dev server (or `npm start`) first, then:
//   node scripts/smoke-server.mjs [baseUrl]
// Uses fresh random emails and a random client IP each run, so it can be repeated. It writes to the
// database the server uses. The expired-link check edits that file directly (TICKETSTUB_DB or the default).
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

const BASE = (process.argv[2] ?? process.env.SMOKE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const DB = process.env.TICKETSTUB_DB ?? "./data/ticketstub.sqlite";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const run = randomBytes(4).toString("hex");
/** Every client made and every response body seen, for the no-secrets scan at the end. */
const clients = [];
const responses = [];
let failed = 0;
let passed = 0;

function check(name, ok, detail = "") {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` ${detail}`}`);
}

/** A client with its own cookie jar and IP, like one browser. */
function client(label) {
  const jar = new Map();
  const ip = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
  const api = async (method, path, body, opts = {}) => {
    const headers = { "x-real-ip": ip, ...(opts.origin === null ? {} : { origin: opts.origin ?? BASE }), ...(opts.headers ?? {}) };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body), redirect: "manual" });
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split(";");
      const [k, v] = pair.split("=");
      if (/max-age=0/i.test(attrs.join(";")) || v === "") jar.delete(k.trim());
      else jar.set(k.trim(), v);
    }
    const text = await res.text();
    responses.push(text);
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: res.status, json, text, headers: res.headers, jar };
  };
  /** Asks for a link and opens it, so the jar holds a session. */
  const signIn = async (email, returnTo = "/wall", reason = "save") => {
    const r = await api("POST", "/api/auth/link", { email, returnTo, reason });
    if (!r.json?.devLink) throw new Error(`${label}: no devLink (${r.status} ${JSON.stringify(r.json)})`);
    const token = new URL(r.json.devLink).searchParams.get("token");
    return { link: r, cb: await api("POST", "/api/auth/confirm", { token }) };
  };
  const me = { api, signIn, jar, label, ip };
  clients.push(me);
  return me;
}

const tokenOf = (devLink) => new URL(devLink).searchParams.get("token");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const uniquePng = () => `data:image/png;base64,${Buffer.concat([PNG, randomBytes(8)]).toString("base64")}`;

const stub = (id, title, updatedAt, extra = {}) => ({
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
  photos: ["data:image/png;base64,AAAA"],
  updatedAt,
  ...extra,
});

const sync = (c, stubs, deleted = []) => c.api("POST", "/api/wall/sync", { stubs, deleted });
const titles = (r) => (r.json?.stubs ?? []).map((s) => `${s.id}:${s.event.title}`).sort();

async function main() {
  const t0 = Date.now();
  if (process.env.SMOKE_EXPECT === "live-nosecret") {
    // Run against a server started with TICKETSTUB_RUNTIME_MODE=live and no CONTEXT_SECRET.
    const r = await client("live").api("GET", "/api/context");
    check("live mode without CONTEXT_SECRET refuses to issue a context token (503)", r.status === 503 && r.json?.error?.code === "context_unavailable" && !r.text.includes("eyJ"), `${r.status} ${r.text.slice(0, 80)}`);
    // A guest order with an email needs no sign-in, so the order gate can be tried in live mode too.
    const line = { title: "Foil card", material: "card", finish: "foil", size: "classic", totalMinor: 3500, variantStatus: "orderable" };
    const base = { stubIds: ["s1"], totalMinor: 3500, method: "card", email: `smoke-live-${run}@example.com` };
    const pv = await client("live-order").api("POST", "/api/orders", { order: { ...base, lines: [line] } });
    check("live mode: a preview line, even one claiming orderable, is 422 variant_not_orderable", pv.status === 422 && pv.json?.error?.code === "variant_not_orderable", `${pv.status} ${pv.text.slice(0, 100)}`);
    const dg = await client("live-order2").api("POST", "/api/orders", { order: { ...base, lines: [{ ...line, material: "digital", finish: "matte", size: "file", totalMinor: 900 }] } });
    check("live mode: an orderable digital line is accepted", dg.status === 200 && dg.json.order.lines[0].variantStatus === "orderable", `${dg.status} ${dg.text.slice(0, 100)}`);
    console.log(`
${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
  const a = client("A");
  const emailA = `smoke-a-${run}@example.com`;

  // Auth: link -> devLink -> callback -> cookie -> me
  const me0 = await a.api("GET", "/api/auth/me");
  check("me is null before sign-in", me0.status === 200 && me0.json?.account === null);
  check("sync without a session is 401", (await sync(a, [])).status === 401);
  check("link without Origin is 403", (await a.api("POST", "/api/auth/link", { email: emailA, reason: "save" }, { origin: null })).status === 403);
  check("link from a foreign Origin is 403", (await a.api("POST", "/api/auth/link", { email: emailA, reason: "save" }, { origin: "https://evil.example" })).status === 403);
  check("link with a bad email is 400", (await a.api("POST", "/api/auth/link", { email: "nope", reason: "save" })).status === 400);
  check("link with a bad reason is 400", (await a.api("POST", "/api/auth/link", { email: emailA, reason: "other" })).status === 400);
  const { link, cb } = await a.signIn(emailA, "/wall?x=1#top");
  check("link returns sandbox devLink", link.status === 200 && link.json.ok === true && link.json.sandbox === true && typeof link.json.devLink === "string");
  check("callback is 303 to returnTo with signedIn=1", cb.status === 303 && cb.headers.get("location") === "/wall?x=1&signedIn=1#top", cb.headers.get("location"));
  check("callback sets an httpOnly SameSite=Lax cookie", /ts_session=/.test(cb.headers.get("set-cookie") ?? "") && /HttpOnly/i.test(cb.headers.get("set-cookie") ?? "") && /SameSite=Lax/i.test(cb.headers.get("set-cookie") ?? ""));
  const me1 = await a.api("GET", "/api/auth/me");
  check("me returns the account", me1.json?.account?.email === emailA && typeof me1.json.account.id === "string");

  // Used link
  const again = await client("anon").api("POST", "/api/auth/confirm", { token: tokenOf(link.json.devLink) });
  check("a used link redirects to /wall?signin=expired", again.status === 303 && again.headers.get("location") === "/wall?signin=expired");

  // GET alone never burns a link
  const scan = client("scanner");
  const scanLink = await scan.api("POST", "/api/auth/link", { email: `smoke-scan-${run}@example.com`, returnTo: "/wall", reason: "checkout" });
  const scanToken = tokenOf(scanLink.json.devLink);
  check("the devLink points at the confirm page", new URL(scanLink.json.devLink).pathname === "/signin/confirm");
  const pageGet = await fetch(`${BASE}/signin/confirm?token=${scanToken}`);
  const pageHtml = await pageGet.text();
  check("the confirm page renders with the sign-in stamp and a masked address", pageGet.status === 200 && pageHtml.includes("Sign in to TicketStub") && pageHtml.includes("s***@example.com"), String(pageGet.status));
  check("confirmation preserves the form Origin without disclosing the token URL", /<meta[^>]+name="referrer"[^>]+content="strict-origin"/.test(pageHtml));
  const oldGetLink = await scan.api("GET", `/api/auth/callback?token=${scanToken}`);
  check("the old callback GET only redirects to the confirm page", oldGetLink.status === 303 && oldGetLink.headers.get("location") === `/signin/confirm?token=${scanToken}` && !oldGetLink.jar.has("ts_session"));
  for (let i = 0; i < 3; i++) await fetch(`${BASE}/signin/confirm?token=${scanToken}`);
  await scan.api("GET", `/api/auth/confirm?token=${scanToken}`);
  const peek = await scan.api("GET", `/api/auth/confirm?token=${scanToken}`);
  check("repeated GETs leave the link valid", peek.json.valid === true && peek.json.kind === "signin" && peek.json.maskedEmail === "s***@example.com" && !("email" in peek.json));
  check("a POST without Origin is 403 and burns nothing", (await scan.api("POST", "/api/auth/confirm", { token: scanToken }, { origin: null })).status === 403 && (await scan.api("GET", `/api/auth/confirm?token=${scanToken}`)).json.valid === true);
  check("a null Origin is rejected without consuming the link", (await scan.api("POST", "/api/auth/confirm", { token: scanToken }, { origin: "null" })).status === 403 && (await scan.api("GET", `/api/auth/confirm?token=${scanToken}`)).json.valid === true);
  const formRes = await fetch(`${BASE}/api/auth/confirm`, { method: "POST", redirect: "manual", headers: { origin: BASE, "content-type": "application/x-www-form-urlencoded" }, body: `token=${scanToken}` });
  check("the tap (a form post) signs in with a 303 and a cookie", formRes.status === 303 && formRes.headers.get("location") === "/wall?signedIn=1" && /ts_session=/.test(formRes.headers.get("set-cookie") ?? ""));
  check("the page then reads as expired", (await (await fetch(`${BASE}/signin/confirm?token=${scanToken}`)).text()).includes("This link has expired"));
  check("peek on a used link is invalid", (await scan.api("GET", `/api/auth/confirm?token=${scanToken}`)).json.valid === false);

  // Expired link (edit the row, as waiting 15 minutes is not a smoke test)
  const exp = client("exp");
  const expLink = await exp.api("POST", "/api/auth/link", { email: `smoke-exp-${run}@example.com`, reason: "save" });
  try {
    const token = new URL(expLink.json.devLink).searchParams.get("token");
    const db = new DatabaseSync(DB);
    db.prepare("UPDATE login_links SET expires_at = 1 WHERE token_hash = ?").run(createHash("sha256").update(token).digest("hex"));
    db.close();
    const r = await exp.api("POST", "/api/auth/confirm", { token });
    check("an expired link redirects to /wall?signin=expired", r.status === 303 && r.headers.get("location") === "/wall?signin=expired" && !r.jar.has("ts_session"));
  } catch (e) {
    check("an expired link redirects to /wall?signin=expired", false, `(could not edit ${DB}: ${e.message})`);
  }
  check("a garbage token redirects to expired", (await client("g").api("POST", "/api/auth/confirm", { token: "nope" })).headers.get("location") === "/wall?signin=expired");

  // returnTo must be relative
  for (const [bad, label] of [["https://evil.example/x", "absolute url"], ["//evil.example", "protocol-relative"], ["/\\evil.example", "backslash"], ["javascript:alert(1)", "javascript:"]]) {
    const c = client("rt");
    const { cb: r } = await c.signIn(`smoke-rt-${randomBytes(3).toString("hex")}-${run}@example.com`, bad);
    check(`returnTo ${label} falls back to /wall`, r.headers.get("location") === "/wall?signedIn=1", r.headers.get("location"));
  }

  // Sync merge
  const t = Date.now() - 3_600_000; // updatedAt past now+1 day is clamped, so stay in the past
  let r = await sync(a, [stub("s1", "One", t), stub("s2", "Two", t)]);
  check("sync stores stubs and returns the wall", r.status === 200 && titles(r).join() === "s1:One,s2:Two" && typeof r.json.now === "number" && r.json.deleted.length === 0);
  check("photos are not stored", r.json.stubs.every((s) => s.photos.length === 0));
  r = await sync(a, [stub("s1", "One newer", t + 10)]);
  check("newer updatedAt wins", titles(r).includes("s1:One newer"));
  r = await sync(a, [stub("s1", "One older", t - 10)]);
  check("older updatedAt loses", titles(r).includes("s1:One newer") && !titles(r).includes("s1:One older"));
  r = await sync(a, [stub("s1", "One tied", t + 10)]);
  check("equal updatedAt keeps the server copy", titles(r).includes("s1:One newer"));
  r = await sync(a, [], ["s2"]);
  check("tombstone removes the stub and is reported", !titles(r).some((x) => x.startsWith("s2:")) && r.json.deleted.includes("s2"));
  r = await sync(a, [stub("s2", "Two stale", t + 5)]);
  check("tombstone wins over an older stub", !titles(r).some((x) => x.startsWith("s2:")) && r.json.deleted.includes("s2"));
  r = await sync(a, [stub("s2", "Two revived", Date.now() + 60_000)]);
  check("a stub edited after the delete comes back", titles(r).includes("s2:Two revived") && !r.json.deleted.includes("s2"));
  r = await sync(a, [stub("s3", "Three", t)], ["s3"]);
  check("delete in the same request wins", !titles(r).some((x) => x.startsWith("s3:")));

  // Two devices, one account
  const b = client("B");
  await b.signIn(emailA);
  r = await sync(b, [stub("d1", "Phone only", t), stub("s1", "One from phone, old", t - 100)]);
  check("device B receives the account's stubs and keeps its own", titles(r).includes("s1:One newer") && titles(r).includes("d1:Phone only") && titles(r).includes("s2:Two revived"), titles(r).join());
  r = await sync(a, []);
  check("device A pulls down what B pushed", titles(r).includes("d1:Phone only"));
  await sync(b, [], ["d1"]);
  r = await sync(a, [stub("d1", "Phone only", t)]);
  check("a stale device can't resurrect a deleted stub", !titles(r).some((x) => x.startsWith("d1:")) && r.json.deleted.includes("d1"));

  // Validation and bounds
  check("a stub without an id is 400", (await sync(a, [{ event: { title: "x" } }])).status === 400);
  check("a stub without an event is 400", (await sync(a, [{ id: "x", event: "nope", versions: [], personal: {} }])).status === 400);
  check("a stub with a bad id is 400", (await sync(a, [{ ...stub("x", "x", t), id: "../../etc" }])).status === 400);
  check("sync with a foreign Origin is 403", (await a.api("POST", "/api/wall/sync", { stubs: [], deleted: [] }, { origin: "https://evil.example" })).status === 403);
  const big = await a.api("POST", "/api/wall/sync", JSON.stringify({ stubs: [], deleted: [], pad: "x".repeat(33 * 1024 * 1024) }));
  check("a body over the limit is 413", big.status === 413, String(big.status));
  check("malformed JSON is 400", (await a.api("POST", "/api/wall/sync", "{nope")).status === 400);

  // Public wall
  const pub0 = await a.api("PUT", "/api/wall/public", { isPublic: true });
  const token = pub0.json?.token;
  check("making the wall public returns a token", pub0.status === 200 && typeof token === "string" && token.length >= 10);
  const anon = client("viewer");
  const view = await anon.api("GET", `/api/u/${token}`);
  check("public wall is readable without a session", view.status === 200 && view.json.stubs.length >= 2 && view.json.stubs.every((s) => s.torn));
  check("the token is stable", (await a.api("PUT", "/api/wall/public", { isPublic: true })).json.token === token);
  const off = await a.api("PUT", "/api/wall/public", { isPublic: false });
  check("turning it off returns null", off.json.token === null);
  check("a private wall is 404", (await anon.api("GET", `/api/u/${token}`)).status === 404);
  check("the token comes back the same when re-enabled", (await a.api("PUT", "/api/wall/public", { isPublic: true })).json.token === token);
  check("an unknown wall token is 404", (await anon.api("GET", "/api/u/doesnotexist1")).status === 404);
  const cur = await a.api("GET", "/api/wall/public");
  check("GET /api/wall/public reports the state", cur.status === 200 && cur.json.isPublic === true && cur.json.token === token, JSON.stringify(cur.json));
  check("GET /api/wall/public needs a session", (await anon.api("GET", "/api/wall/public")).status === 401);
  check("public wall needs a session to change", (await anon.api("PUT", "/api/wall/public", { isPublic: true })).status === 401);

  // Share
  const sh1 = await anon.api("POST", "/api/share", { stub: stub("shared1", "Shared v1", t) });
  const sh2 = await anon.api("POST", "/api/share", { stub: stub("shared1", "Shared v2", t) });
  check("share returns a short URL-safe token", sh1.status === 200 && /^[A-Za-z0-9_-]{8,16}$/.test(sh1.json.token), JSON.stringify(sh1.json));
  check("the same stub gets the same token", sh1.json.token === sh2.json.token);
  const got = await anon.api("GET", `/api/share/${sh1.json.token}`);
  check("the snapshot is the latest", got.status === 200 && got.json.stub.event.title === "Shared v2" && got.json.stub.photos.length === 0);
  const shA = await a.api("POST", "/api/share", { stub: stub("shared1", "Mine", t) });
  check("a signed-in owner's share is separate from an anonymous one", shA.json.token !== sh1.json.token && (await anon.api("GET", `/api/share/${sh1.json.token}`)).json.stub.event.title === "Shared v2");
  check("an unknown share is 404", (await anon.api("GET", "/api/share/nope-nope-nope")).status === 404);
  check("a share with no stub is 400", (await anon.api("POST", "/api/share", { stub: { id: "x" } })).status === 400);

  // Orders
  const order = {
    stubIds: ["s1"],
    lines: [{ title: "One newer", material: "card", finish: "foil", size: "classic", totalMinor: 3500 }],
    totalMinor: 3500,
    method: "card",
  };
  const guest = client("guest");
  check("a guest order without an email is 401", (await guest.api("POST", "/api/orders", { order })).status === 401);
  const guestEmail = `smoke-guest-${run}@example.com`;
  const go = await guest.api("POST", "/api/orders", { order: { ...order, email: guestEmail } });
  check("a guest order with an email is created", go.status === 200 && go.json.order.mode === "sandbox" && /^ord_/.test(go.json.order.id) && go.json.order.email === guestEmail);
  const so = await a.api("POST", "/api/orders", { order });
  check("a signed-in order uses the account email", so.status === 200 && so.json.order.email === emailA);
  const cap = await import(pathToFileURL(join(ROOT, "src", "customer", "pages", "capabilities.ts")).href);
  const previewLine = { title: "Foil card", material: "card", finish: "foil", size: "classic", totalMinor: 3500, variantStatus: "orderable" };
  const forgedPreview = await a.api("POST", "/api/orders", { order: { ...order, lines: [previewLine], capabilityVersion: "forged" } });
  check("a forged variantStatus orderable on a preview variant is ignored: the server re-derives preview", forgedPreview.status === 200 && forgedPreview.json.order.lines[0].variantStatus === "preview" && forgedPreview.json.order.capabilityVersion === cap.CAPABILITY_VERSION, forgedPreview.text.slice(0, 120));
  const digitalLine = await a.api("POST", "/api/orders", { order: { ...order, lines: [{ title: "File", material: "digital", finish: "matte", size: "file", totalMinor: 900, variantStatus: "preview" }] } });
  check("a digital matte line is stored orderable whatever the browser said", digitalLine.status === 200 && digitalLine.json.order.lines[0].variantStatus === "orderable");
  const holo = await a.api("POST", "/api/orders", { order: { ...order, lines: [{ ...previewLine, finish: "holo" }] } });
  check("a printed holo line is 422 variant_not_orderable in any mode", holo.status === 422 && holo.json?.error?.code === "variant_not_orderable");
  const odd = await a.api("POST", "/api/orders", { order: { ...order, lines: [{ ...previewLine, material: "framed", size: "classic" }] } });
  check("a combination that isn't on the map is 422", odd.status === 422);
  check("the order gate: live mode rejects every preview and unavailable variant, demo accepts previews", cap.VARIANTS.every((v) => {
    const live = cap.orderGate(v, "live");
    const demo = cap.orderGate(v, "demo");
    return live.ok === (v.status === "orderable") && demo.ok === (v.status !== "unavailable");
  }) && cap.orderGate(undefined, "demo").ok === false);
  check("the order gate reads TICKETSTUB_RUNTIME_MODE only, never the browser mirror", cap.runtimeMode({ TICKETSTUB_RUNTIME_MODE: "live" }) === "live" && cap.runtimeMode({ TICKETSTUB_RUNTIME_MODE: "demo" }) === "demo");
  check("an order with a bad method is 400", (await a.api("POST", "/api/orders", { order: { ...order, method: "bitcoin" } })).status === 400);
  check("an order with a negative total is 400", (await a.api("POST", "/api/orders", { order: { ...order, totalMinor: -1 } })).status === 400);
  const list = await a.api("GET", "/api/orders");
  check("orders are listed for the session", list.status === 200 && list.json.orders.some((o) => o.id === so.json.order.id) && !list.json.orders.some((o) => o.id === go.json.order.id));
  check("orders need a session to list", (await guest.api("GET", "/api/orders")).status === 401);
  const g2 = client("guest-signin");
  await g2.signIn(guestEmail);
  check("a guest's order shows once they sign in with that email", (await g2.api("GET", "/api/orders")).json.orders.some((o) => o.id === go.json.order.id));

  // Organizer and claims
  const org = await a.api("POST", "/api/organizer/events", { title: "Smoke party", stub: stub("evt-stub", "Smoke party", t), guests: [{ name: "Ada", seat: "A1" }, { name: "Grace" }], expiresInDays: 7 });
  check("organizer event returns claims", org.status === 200 && /^evt_/.test(org.json.eventId) && org.json.claims.length === 2 && org.json.claims[0].seat === "A1" && !("seat" in org.json.claims[1]));
  check("organizer event needs a session", (await anon.api("POST", "/api/organizer/events", { title: "x", stub: stub("e", "x", t), guests: [{ name: "x" }] })).status === 401);
  check("organizer event with no guests is 400", (await a.api("POST", "/api/organizer/events", { title: "x", stub: stub("e", "x", t), guests: [] })).status === 400);
  const ct = org.json.claims[0].token;
  const cv = await anon.api("GET", `/api/claim/${ct}`);
  check("claim preview carries the guest name", cv.status === 200 && cv.json.guestName === "Ada" && cv.json.seat === "A1" && cv.json.claimed === false && cv.json.expired === false && cv.json.stub.personal.guestName === "Ada");
  check("claim needs a session", (await anon.api("POST", `/api/claim/${ct}`)).status === 401);
  const c2 = client("second");
  await c2.signIn(`smoke-second-${run}@example.com`);
  const claimA = await a.api("POST", `/api/claim/${ct}`);
  check("first claim adds the stub to the wall", claimA.status === 200 && claimA.json.stub.personal.guestName === "Ada" && claimA.json.stub.torn === true);
  check("claiming again with the same account is idempotent", (await a.api("POST", `/api/claim/${ct}`)).json.stub.id === claimA.json.stub.id);
  const wallA = await sync(a, []);
  check("the claimed stub is on the claimer's wall exactly once", wallA.json.stubs.filter((s) => s.id === claimA.json.stub.id).length === 1);
  const claimB = await c2.api("POST", `/api/claim/${ct}`);
  check("a different account gets 409", claimB.status === 409 && claimB.json.error.code === "already_claimed", String(claimB.status));
  check("claim preview now says claimed", (await anon.api("GET", `/api/claim/${ct}`)).json.claimed === true);
  check("an unknown claim token is 404", (await anon.api("GET", "/api/claim/doesnotexist1")).status === 404);
  const exEvt = await a.api("POST", "/api/organizer/events", { title: "Old", stub: stub("evt-old", "Old", t), guests: [{ name: "Late" }], expiresInDays: 1 });
  try {
    const db = new DatabaseSync(DB);
    db.prepare("UPDATE organizer_events SET expires_at = 1 WHERE id = ?").run(exEvt.json.eventId);
    db.close();
    const lt = exEvt.json.claims[0].token;
    check("an expired claim previews as expired", (await anon.api("GET", `/api/claim/${lt}`)).json.expired === true);
    check("an expired claim can't be claimed (410)", (await c2.api("POST", `/api/claim/${lt}`)).status === 410);
  } catch (e) {
    check("expired claim", false, `(could not edit ${DB}: ${e.message})`);
  }

  // Rate limit: 5 per email
  const rl = client("rl");
  const rlEmail = `smoke-rl-${run}@example.com`;
  const codes = [];
  for (let i = 0; i < 6; i++) codes.push((await rl.api("POST", "/api/auth/link", { email: rlEmail, reason: "save" })).status);
  check("the 6th link for one email is 429", codes.slice(0, 5).every((c) => c === 200) && codes[5] === 429, codes.join());
  const ipc = client("ip");
  const ipCodes = [];
  for (let i = 0; i < 21; i++) ipCodes.push((await ipc.api("POST", "/api/auth/link", { email: `smoke-ip-${i}-${run}@example.com`, reason: "save" })).status);
  check("the 21st link from one IP is 429", ipCodes.slice(0, 20).every((c) => c === 200) && ipCodes[20] === 429, ipCodes.join());

  // Emails and the stub picture
  const prev = await anon.api("GET", "/api/dev/email-preview?kind=receipt");
  // The preview is dev only: HTML from a dev server, 404 from a production build. The context says which one this is.
  const isDev = (await anon.api("GET", "/api/context")).json?.context?.environment === "development";
  check(isDev ? "email preview returns HTML in dev" : "email preview is 404 in production", isDev ? prev.status === 200 && /TICKETSTUB/.test(prev.text ?? "") === true : prev.status === 404, String(prev.status));
  const imgRes = await fetch(`${BASE}/api/stub-image/${sh1.json.token}`);
  check("stub image renders a PNG for a share token", imgRes.status === 200 && imgRes.headers.get("content-type") === "image/png");
  check("stub image for an unknown token is 404", (await fetch(`${BASE}/api/stub-image/nope-nope-nope`)).status === 404);

  // Account: change email
  const acc = client("acc");
  const emailOld = `smoke-old-${run}@example.com`;
  const emailNew = `smoke-new-${run}@example.com`;
  await acc.signIn(emailOld);
  const accOrder = await acc.api("POST", "/api/orders", { order });
  check("email change needs a session", (await anon.api("POST", "/api/account/email", { email: emailNew })).status === 401);
  check("email change to the same address is 400", (await acc.api("POST", "/api/account/email", { email: emailOld })).status === 400);
  check("email change with a foreign Origin is 403", (await acc.api("POST", "/api/account/email", { email: emailNew }, { origin: "https://evil.example" })).status === 403);
  const ch = await acc.api("POST", "/api/account/email", { email: emailNew });
  check("email change returns a sandbox devLink", ch.status === 200 && ch.json.sandbox === true && /\/signin\/confirm\?token=/.test(ch.json.devLink ?? ""));
  const chToken = tokenOf(ch.json.devLink);
  const peekEmail = await anon.api("GET", `/api/auth/confirm?token=${chToken}`);
  check("an email-change link peeks as kind=email, masked", peekEmail.json.valid === true && peekEmail.json.kind === "email" && peekEmail.json.maskedEmail.includes("***"));
  const oldGet = await anon.api("GET", `/api/account/email/confirm?token=${chToken}`);
  check("the old email-change GET only redirects to the confirm page", oldGet.status === 303 && oldGet.headers.get("location").startsWith("/signin/confirm?token=") && (await anon.api("GET", `/api/auth/confirm?token=${chToken}`)).json.valid === true);
  const conf = await anon.api("POST", "/api/auth/confirm", { token: chToken });
  check("confirming an email change never creates a session", !conf.jar.has("ts_session"));
  check("confirming redirects to /account?email=changed", conf.status === 303 && conf.headers.get("location") === "/account?email=changed", conf.headers.get("location"));
  check("me shows the new email", (await acc.api("GET", "/api/auth/me")).json.account.email === emailNew);
  check("the email link is single use", (await acc.api("POST", "/api/auth/confirm", { token: chToken })).headers.get("location") === "/account?email=expired");
  const takenReq = await acc.api("POST", "/api/account/email", { email: emailA });
  const taken = await anon.api("POST", "/api/auth/confirm", { token: tokenOf(takenReq.json.devLink) });
  check("an address owned by another account redirects to ?email=taken", taken.headers.get("location") === "/account?email=taken");
  check("the email stayed as it was", (await acc.api("GET", "/api/auth/me")).json.account.email === emailNew);
  const sw = await acc.api("POST", "/api/share", { stub: stub("acc-share", "Acc share", t) });
  await sync(acc, [stub("acc-1", "Acc one", t)]);
  const accPub = (await acc.api("PUT", "/api/wall/public", { isPublic: true })).json.token;

  // Account: delete
  check("delete needs a session", (await anon.api("DELETE", "/api/account", { confirm: emailNew })).status === 401);
  check("delete with the wrong confirmation is 400", (await acc.api("DELETE", "/api/account", { confirm: "wrong@example.com" })).status === 400);
  check("delete with a foreign Origin is 403", (await acc.api("DELETE", "/api/account", { confirm: emailNew }, { origin: "https://evil.example" })).status === 403);
  const del = await acc.api("DELETE", "/api/account", { confirm: emailNew.toUpperCase() });
  check("delete removes the account and clears the cookie", del.status === 200 && del.json.ok === true && !del.jar.has("ts_session") && (await acc.api("GET", "/api/auth/me")).json.account === null);
  check("its public wall is gone", (await anon.api("GET", `/api/u/${accPub}`)).status === 404);
  check("its shares are gone", (await anon.api("GET", `/api/share/${sw.json.token}`)).status === 404);
  try {
    const db = new DatabaseSync(DB);
    const o = db.prepare("SELECT account_id, email, data FROM orders WHERE id = ?").get(accOrder.json.order.id);
    db.close();
    check("its order is kept, anonymised", o && o.account_id === null && o.email === null && !("email" in JSON.parse(o.data)));
  } catch (e) {
    check("its order is kept, anonymised", false, `(could not read ${DB}: ${e.message})`);
  }
  const back = client("back");
  await back.signIn(emailNew);
  check("the same email starts a fresh, empty account", (await sync(back, [])).json.stubs.length === 0);

  // Art as files
  const art = client("art");
  await art.signIn(`smoke-art-${run}@example.com`);
  const png = uniquePng();
  const withArt = (id, src) => stub(id, id, t, { versions: [{ id: `${id}-v`, edition: "classic", art: { kind: "image", src, seed: 1, provenance: "live" }, createdAt: "x" }] });
  const artRes = await sync(art, [withArt("art-1", png)]);
  const got1 = artRes.json.stubs[0];
  const artUrl = got1?.versions[0].art.src;
  check("embedded art becomes an /api/files URL", /^\/api\/files\/[a-f0-9]{64}\.png$/.test(artUrl ?? ""), String(artUrl).slice(0, 60));
  check("rewriting the art does not touch updatedAt", got1.updatedAt === t);
  const fileRes = await fetch(BASE + artUrl);
  const fileBytes = Buffer.from(await fileRes.arrayBuffer());
  check("the file is served with type, nosniff and immutable caching", fileRes.status === 200 && fileRes.headers.get("content-type") === "image/png" && fileRes.headers.get("x-content-type-options") === "nosniff" && /immutable/.test(fileRes.headers.get("cache-control") ?? "") && fileBytes.equals(Buffer.from(png.split(",")[1], "base64")));
  check("a stub that already carries the URL is accepted as is", (await sync(art, [withArt("art-1", artUrl)])).status === 200);
  check("path traversal and bad names are 404", (await fetch(`${BASE}/api/files/..%2F..%2Fpackage.json`)).status === 404 && (await fetch(`${BASE}/api/files/${"a".repeat(64)}.png`)).status === 404 && (await fetch(`${BASE}/api/files/${"A".repeat(64)}.png`)).status === 404 && (await fetch(`${BASE}/api/files/${"a".repeat(64)}.svg`)).status === 404);
  const fake = await sync(art, [withArt("art-2", `data:image/png;base64,${Buffer.from("not an image at all").toString("base64")}`)]);
  check("a data URL that isn't really a PNG is 400", fake.status === 400 && fake.json.error.code === "bad_image", String(fake.status));
  check("an svg data URL is 400", (await sync(art, [withArt("art-3", `data:image/svg+xml;base64,${Buffer.from("<svg/>").toString("base64")}`)])).status === 400);
  check("a declared type that doesn't match the bytes is 400", (await sync(art, [withArt("art-4", `data:image/jpeg;base64,${PNG.toString("base64")}`)])).status === 400);
  const bigPng = Buffer.concat([PNG, Buffer.alloc(6 * 1024 * 1024)]);
  const huge = await sync(art, [withArt("art-5", `data:image/png;base64,${bigPng.toString("base64")}`)]);
  check("an image over 6 MB is 413", huge.status === 413, String(huge.status));
  const artShare = await art.api("POST", "/api/share", { stub: withArt("art-1", uniquePng()) });
  const shared = await art.api("GET", `/api/share/${artShare.json.token}`);
  check("share also moves art to a file", /^\/api\/files\//.test(shared.json.stub.versions[0].art.src));
  const img = await fetch(`${BASE}/api/stub-image/${artShare.json.token}`);
  check("the stub picture renders with stored art", img.status === 200 && img.headers.get("content-type") === "image/png");
  const orgArt = await art.api("POST", "/api/organizer/events", { title: "Art party", stub: withArt("art-evt", uniquePng()), guests: [{ name: "G" }] });
  const orgClaim = await anon.api("GET", `/api/claim/${orgArt.json.claims[0].token}`);
  check("organizer events move art to a file too", /^\/api\/files\//.test(orgClaim.json.stub.versions[0].art.src));
  // A file no one else references goes with the account; one shared by hash stays
  const soloRes = await sync(art, [withArt("art-solo", uniquePng())]);
  const soloUrl = soloRes.json.stubs.find((x) => x.id === "art-solo").versions[0].art.src;
  const keeper = client("keeper");
  await keeper.signIn(`smoke-keeper-${run}@example.com`);
  await sync(keeper, [withArt("keep-1", artUrl)]);
  const artMe = (await art.api("GET", "/api/auth/me")).json.account.email;
  await art.api("DELETE", "/api/account", { confirm: artMe });
  check("deleting the account removes art nothing else uses", (await fetch(BASE + soloUrl)).status === 404);
  check("art still referenced by another account stays", (await fetch(BASE + artUrl)).status === 200);

  // Disposable email domains
  const dis = client("disposable");
  const disBad = await dis.api("POST", "/api/auth/link", { email: `smoke-${run}@mailinator.com`, reason: "save" });
  check("a disposable domain is refused at sign-in with 400 disposable_email", disBad.status === 400 && disBad.json?.error?.code === "disposable_email", `${disBad.status} ${disBad.text}`);
  const disSub = await dis.api("POST", "/api/auth/link", { email: `smoke-${run}@a.b.YOPMAIL.com`, reason: "save" });
  check("a subdomain and upper case of a disposable domain are refused too", disSub.status === 400 && disSub.json?.error?.code === "disposable_email", String(disSub.status));
  check("a normal domain still signs in", (await dis.api("POST", "/api/auth/link", { email: `smoke-ok-${run}@example.org`, reason: "save" })).status === 200);
  const disAcc = client("disposable-acct");
  await disAcc.signIn(`smoke-dis-${run}@example.com`);
  const disChange = await disAcc.api("POST", "/api/account/email", { email: `smoke-${run}@guerrillamail.com` });
  check("an email change to a disposable domain is 400 disposable_email", disChange.status === 400 && disChange.json?.error?.code === "disposable_email", String(disChange.status));

  // Art caps: 10 per account and per device per day, 30 per IP. The caps are read on every call, so rows seeded
  // into art_usage prove the 429 without spending a generation. (A server with an OpenAI key would spend one on the first call.)
  const today = new Date().toISOString().slice(0, 10);
  const sha = (v) => createHash("sha256").update(v).digest("hex");
  const seedUsage = (key, count) => {
    const db = new DatabaseSync(DB);
    try {
      db.prepare("INSERT INTO art_usage (key, day, count) VALUES (?, ?, ?) ON CONFLICT (key, day) DO UPDATE SET count = excluded.count").run(key, today, count);
    } finally {
      db.close();
    }
  };
  const artBody = { event: { type: "concert", title: "Smoke night", facts: [] }, vibe: "Neon", seed: 7 };
  const dev = client("art-device");
  const art1 = await dev.api("POST", "/api/art", artBody);
  check("art works under the cap", art1.status === 200 && typeof art1.json?.kind === "string", String(art1.status));
  const devCookie = art1.headers.getSetCookie().find((c) => c.startsWith("ts_device="));
  check("the first art call sets an httpOnly device cookie", !!devCookie && /httponly/i.test(devCookie) && dev.jar.has("ts_device"));
  const art2 = await dev.api("POST", "/api/art", artBody);
  check("the device cookie is not reissued", art2.status === 200 && !art2.headers.getSetCookie().some((c) => c.startsWith("ts_device=")));
  seedUsage(`dev:${sha(dev.jar.get("ts_device"))}`, 10);
  const art3 = await dev.api("POST", "/api/art", artBody);
  check("a device at its cap gets 429 art_limit with retryAt", art3.status === 429 && art3.json?.error?.code === "art_limit" && art3.json.retryAt > Date.now(), `${art3.status} ${art3.text}`);
  check("the 429 carries procedural art as the fallback", art3.json?.art?.kind === "procedural");
  const fresh = client("art-fresh-device");
  seedUsage(`ip:${sha(fresh.ip)}`, 30);
  check("an IP at its cap gets 429 whatever the device", (await fresh.api("POST", "/api/art", artBody)).status === 429);
  const accArt = client("art-account");
  await accArt.signIn(`smoke-artcap-${run}@example.com`);
  const accId = (await accArt.api("GET", "/api/auth/me")).json.account.id;
  seedUsage(`acc:${accId}`, 10);
  const accCapped = await accArt.api("POST", "/api/art", artBody);
  check("an account at its cap gets 429 on any device", accCapped.status === 429 && accCapped.json?.error?.code === "art_limit", String(accCapped.status));
  const accOther = await accArt.api("DELETE", "/api/account", { confirm: `smoke-artcap-${run}@example.com` });
  check("the capped account can still be deleted", accOther.status === 200);

  // Sign out
  const so2 = await b.api("POST", "/api/auth/signout");
  check("signout clears the session", so2.status === 200 && (await b.api("GET", "/api/auth/me")).json.account === null);
  check("the old session is dead server-side", (await sync(b, [])).status === 401);
  check("errors have the contract shape", (await sync(b, [])).json?.error?.code === "unauthorized");

  await gt08(anon);
  await gt09();

  console.log(`\n${passed} passed, ${failed} failed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  process.exit(failed ? 1 : 0);
}


// ---------------------------------------------------------------------------------------------
// GT-08: identity, ACL, sharing and the signed context. Two accounts (X, Y) each own two stubs and an event.
// ---------------------------------------------------------------------------------------------
const FIXTURES = join(ROOT, "fixtures", "context");
const ADMIN_EMAIL = process.env.SMOKE_ADMIN_EMAIL; // must match ADMIN_EMAILS on the server under test
const encodeLegacy = (st) => Buffer.from(JSON.stringify(st)).toString("base64url");

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** Client components must never reach src/server/**. Builds the import graph and walks it from every "use client" file. */
function importGraphCheck() {
  const src = join(ROOT, "src");
  const files = walk(src).filter((f) => /\.(ts|tsx)$/.test(f));
  const exts = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];
  const resolveImport = (from, spec) => {
    const base = spec.startsWith("@/") ? join(src, spec.slice(2)) : spec.startsWith(".") ? join(dirname(from), spec) : null;
    if (!base) return null;
    return exts.map((e) => base + e).find((p) => existsSync(p) && statSync(p).isFile()) ?? null;
  };
  const importRe = /(?:^|\n)\s*(?:import|export)\s+(?!type\b)(?:[^'";]*?\s+from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
  const graph = new Map();
  const roots = [];
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    if (/^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*["']use client["']/.test(text)) roots.push(f);
    const deps = [];
    for (const m of text.matchAll(importRe)) {
      const r = resolveImport(f, m[1] ?? m[2]);
      if (r) deps.push(r);
    }
    graph.set(f, deps);
  }
  const serverDir = join(src, "server") + sep;
  const bad = [];
  for (const root of roots) {
    const seen = new Set([root]);
    const queue = [[root, [root]]];
    while (queue.length) {
      const [f, chain] = queue.shift();
      for (const d of graph.get(f) ?? []) {
        if (d.startsWith(serverDir)) bad.push([...chain, d].map((p) => relative(ROOT, p)).join(" -> "));
        else if (!seen.has(d)) {
          seen.add(d);
          queue.push([d, [...chain, d]]);
        }
      }
    }
  }
  return { roots: roots.length, files: files.length, bad };
}

/** Built client chunks must hold no server markers. Scans .next/static (a build) and .next/dev/static (the dev server). */
function clientChunkScan() {
  const dirs = [join(ROOT, ".next", "static"), join(ROOT, ".next", "dev", "static")].filter((d) => existsSync(d));
  const markers = ["CONTEXT_SECRET", "ADMIN_EMAILS", "__ticketstubContextKey", "ticketstub.context", "FIXTURE-ONLY", "membership_revision", "RESEND_API_KEY", "OPENAI_API_KEY"];
  const hits = [];
  let scanned = 0;
  for (const dir of dirs) {
    for (const f of walk(dir).filter((p) => /\.(js|css|map)$/.test(p) && !p.endsWith(".map"))) {
      scanned++;
      const text = readFileSync(f, "utf8");
      for (const m of markers) if (text.includes(m)) hits.push(`${relative(ROOT, f)}: ${m}`);
    }
  }
  return { dirs: dirs.length, scanned, hits };
}

async function gt08(anon) {
  const { verifyWithKey, capabilitiesFor, CAPABILITY_MATRIX, CONTEXT_SCHEMA } = await import(pathToFileURL(join(ROOT, "src", "server", "context-token.ts")).href);
  const { verifyContext, authorizes } = await import(pathToFileURL(join(FIXTURES, "verify.mjs")).href);
  const t = Date.now() - 3_600_000;
  const verifier = client("verifier");
  const verify = (token) => verifier.api("POST", "/api/context/verify", { token });
  const ctxOf = (c, project) => c.api("GET", `/api/context${project ? `?project=${encodeURIComponent(project)}` : ""}`);
  const sameDenial = (a, b) => a.status === b.status && a.text === b.text;

  // --- Two accounts, two stubs and an event each.
  const X = client("X");
  const Y = client("Y");
  const emailX = `smoke-x-${run}@example.com`;
  const emailY = `smoke-y-${run}@example.com`;
  await X.signIn(emailX);
  await Y.signIn(emailY);
  const personal = { titleFont: 0, titleColor: "#000", foilTitle: false, hiddenFields: [], friends: [{ name: "SecretFriend", seat: "Z9", claimed: false }], note: "SECRET NOTE ABOUT BOB" };
  const ids = { x1: `x1-${run}`, x2: `x2-${run}`, y1: `y1-${run}`, y2: `y2-${run}` };
  await sync(X, [stub(ids.x1, "X one", t, { personal }), stub(ids.x2, "X two", t)]);
  await sync(Y, [stub(ids.y1, "Y one", t, { personal }), stub(ids.y2, "Y two", t)]);
  const shX1 = (await X.api("POST", "/api/share", { stub: stub(ids.x1, "X one", t, { personal }) })).json.token;
  const shX2 = (await X.api("POST", "/api/share", { stub: stub(ids.x2, "X two", t) })).json.token;
  const shY1 = (await Y.api("POST", "/api/share", { stub: stub(ids.y1, "Y one", t, { personal }) })).json.token;
  const shY2 = (await Y.api("POST", "/api/share", { stub: stub(ids.y2, "Y two", t) })).json.token;
  const evX = (await X.api("POST", "/api/organizer/events", { title: "X event", stub: stub(`ex-${run}`, "X event", t), guests: [{ name: "Gx" }] })).json;
  const evY = (await Y.api("POST", "/api/organizer/events", { title: "Y event", stub: stub(`ey-${run}`, "Y event", t), guests: [{ name: "Gy" }] })).json;
  const pubX = (await X.api("PUT", "/api/wall/public", { isPublic: true })).json.token;
  const pubY = (await Y.api("PUT", "/api/wall/public", { isPublic: true })).json.token;
  check("setup: two accounts each hold two shares, an event and a public wall", [shX1, shX2, shY1, shY2, evX.eventId, evY.eventId, pubX, pubY].every((v) => typeof v === "string" && v.length > 5));

  // --- /api/context: derived from the cookie, never from the caller's words.
  const bare = client("bare");
  const cAnon = await ctxOf(bare);
  check("context: anonymous gets role none, no admin and no private capabilities", cAnon.status === 200 && cAnon.json.context.actor.kind === "anonymous" && cAnon.json.context.role === "none" && !cAnon.json.context.capabilities.some((c) => /^(admin\.|wall\.sync|stub\.write|event\.)/.test(c)));
  check("context: the schema, a 5-minute lifetime and a mode are present", cAnon.json.context.schema === CONTEXT_SCHEMA && Date.parse(cAnon.json.context.expiresAt) - Date.parse(cAnon.json.context.issuedAt) === 300_000 && ["sandbox", "live"].includes(cAnon.json.context.mode));
  const cX = await ctxOf(X);
  check("context: an account is its own tenant with the owner role and account capabilities", cX.json.context.actor.kind === "account" && cX.json.context.tenant.id === cX.json.context.actor.id && cX.json.context.role === "owner" && cX.json.context.capabilities.includes("wall.sync") && !cX.json.context.capabilities.includes("admin.view"));
  const cX1 = await ctxOf(X, `stub:${ids.x1}`);
  const cX2 = await ctxOf(X, `stub:${ids.x2}`);
  check("context: own stub is role owner with stub.read, stub.write, share.revoke", cX1.status === 200 && cX1.json.context.role === "owner" && ["stub.read", "stub.write", "share.revoke"].every((c) => cX1.json.context.capabilities.includes(c)) && cX1.json.context.project.id === ids.x1);
  check("context: project A and project B of one user are different contexts and tokens", cX2.json.context.project.id === ids.x2 && cX1.json.token !== cX2.json.token && cX1.json.context.tenant.id === cX2.json.context.tenant.id);
  const foreign = await ctxOf(X, `stub:${ids.y1}`);
  const nothing = await ctxOf(X, `stub:nothing-${run}`);
  check("context: another account's stub is 404", foreign.status === 404 && foreign.json.error.code === "not_found");
  check("context: a foreign stub and a stub that does not exist answer identically", sameDenial(foreign, nothing), `${foreign.text} / ${nothing.text}`);
  check("context: another account's event is 404 and identical to a missing one", (await ctxOf(X, `event:${evY.eventId}`)).status === 404 && sameDenial(await ctxOf(X, `event:${evY.eventId}`), await ctxOf(X, `event:evt_nothing${run}`)));
  const capX = await ctxOf(X, `event:${evX.eventId}`);
  check("context: the creator is captain of their event with event.publish", capX.status === 200 && capX.json.context.role === "captain" && capX.json.context.capabilities.includes("event.publish") && !capX.json.context.capabilities.includes("stub.write"));
  check("context: a guest or anonymous caller gets 404 for any project", (await ctxOf(anon, `stub:${ids.x1}`)).status === 404 && (await ctxOf(anon, `event:${evX.eventId}`)).status === 404);
  check("context: a malformed project is 404", (await ctxOf(X, "stub:")).status === 404 && (await ctxOf(X, "wall:x")).status === 404 && (await ctxOf(X, `stub:${"a".repeat(200)}`)).status === 404);
  check("context: Y sees exactly Y's side", (await ctxOf(Y, `stub:${ids.y1}`)).status === 200 && (await ctxOf(Y, `stub:${ids.x1}`)).status === 404 && (await ctxOf(Y, `event:${evX.eventId}`)).status === 404);
  const foreignHeader = await X.api("GET", `/api/context?project=stub:${ids.y1}&tenant=${cX.json.context.tenant.id}`, undefined);
  check("context: tenant or role in the query changes nothing", foreignHeader.status === 404);

  // --- The signed token: live verification through the port.
  const v1 = await verify(cX1.json.token);
  check("token: a fresh token verifies through the port with the same context", v1.status === 200 && v1.json.ok === true && v1.json.context.project.id === ids.x1 && v1.json.context.role === "owner");
  const [h, p, sg] = cX1.json.token.split(".");
  const flip = (s) => s.slice(0, -2) + (s.slice(-2) === "AA" ? "BB" : "AA");
  check("token: a flipped signature is forged", (await verify(`${h}.${p}.${flip(sg)}`)).json?.reason === "forged");
  const tamper = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, "base64url").toString()), ctx: { ...JSON.parse(Buffer.from(p, "base64url").toString()).ctx, role: "staff", capabilities: ["admin.view"] } })).toString("base64url");
  check("token: an edited payload (role staff, admin.view) is forged", (await verify(`${h}.${tamper}.${sg}`)).json?.reason === "forged");
  const noneAlg = Buffer.from(JSON.stringify({ alg: "none", typ: "ticketstub.context" })).toString("base64url");
  check("token: alg none is rejected", (await verify(`${noneAlg}.${p}.`)).json?.reason === "unknown" && (await verify(`${noneAlg}.${p}.${sg}`)).json?.reason === "unknown");
  check("token: garbage and an oversize token are unknown", (await verify("nope")).json?.reason === "unknown" && (await verify(`${"a".repeat(3000)}.${"b".repeat(3000)}.${"c".repeat(3000)}`)).json?.reason === "unknown");
  check("token: the port needs a token", (await verifier.api("POST", "/api/context/verify", {})).status === 400);

  // --- Fixtures: the same code the server runs, and the standalone reference verifier, agree on every outcome.
  const keyFile = JSON.parse(readFileSync(join(FIXTURES, "fixture-key.json"), "utf8"));
  const fxFiles = readdirSync(FIXTURES).filter((n) => n.endsWith(".json") && !["fixture-key.json", "index.json", "finance-trusted-scope.schema.json"].includes(n));
  const wanted = ["owner", "captain", "staff", "guest", "unknown", "malformed", "forged", "stale", "revoked", "expired", "unsupported-version", "cross-project-a", "cross-project-b", "tenant-a-owner", "tenant-b-owner"];
  check("fixtures: every required case is published", wanted.every((n) => fxFiles.includes(`${n}.json`)) && /fixture only|never production/i.test(keyFile.warning));
  let fxBad = [];
  const fx = {};
  for (const f of fxFiles) {
    const x = JSON.parse(readFileSync(join(FIXTURES, f), "utf8"));
    fx[x.fixture] = x;
    const opts = { now: Date.parse(x.verifyAt), state: x.state, audience: "ticketstub.finance" };
    const a = verifyWithKey(x.token, keyFile.key, opts.now, opts.state, { audience: opts.audience });
    const b = verifyContext(x.token, keyFile.key, opts);
    const want = x.expect;
    const good = (r) => r.ok === want.ok && (r.ok ? r.ctx.role === want.role && r.ctx.tenant.id === want.tenant : r.reason === want.reason);
    if (!good(a) || !good(b)) fxBad.push(x.fixture);
  }
  check("fixtures: the server verifier and the reference verifier give each fixture its expected outcome", fxBad.length === 0 && fxFiles.length >= wanted.length, fxBad.join());
  check("fixtures: the outcomes cover valid, forged, stale, revoked, expired, unsupported_version and unknown", new Set(Object.values(fx).map((x) => (x.expect.ok ? "ok" : x.expect.reason))).size === 7);
  check("fixtures: capabilities in every valid fixture match the matrix in code", Object.values(fx).filter((x) => x.expect.ok).every((x) => {
    const c = JSON.parse(Buffer.from(x.token.split(".")[1], "base64url").toString()).ctx;
    return JSON.stringify(c.capabilities) === JSON.stringify(capabilitiesFor(c.actor.kind, c.role, c.project, c.role === "staff"));
  }));
  const a = verifyContext(fx["cross-project-a"].token, keyFile.key, { now: Date.parse(fx["cross-project-a"].verifyAt), audience: "ticketstub.finance" }).ctx;
  const b = verifyContext(fx["cross-project-b"].token, keyFile.key, { now: Date.parse(fx["cross-project-b"].verifyAt), audience: "ticketstub.finance" }).ctx;
  check("fixtures: a token for project A does not authorize project B (same user)", authorizes(a, { tenant: a.tenant.id, project: { kind: "stub", id: "stub_fx_1" }, capability: "stub.read" }) && !authorizes(a, { tenant: a.tenant.id, project: { kind: "stub", id: "stub_fx_2" }, capability: "stub.read" }) && !authorizes(b, { tenant: b.tenant.id, project: { kind: "stub", id: "stub_fx_1" }, capability: "stub.read" }));
  const ta = verifyContext(fx["tenant-a-owner"].token, keyFile.key, { now: Date.parse(fx["tenant-a-owner"].verifyAt), audience: "ticketstub.finance" }).ctx;
  check("fixtures: tenant A's token does not authorize tenant B's stub with the same id", !authorizes(ta, { tenant: "acc_FIXTURE_tenant2", project: { kind: "stub", id: "stub_fx_shared" }, capability: "stub.read" }));
  check("fixtures: the fixture key is not accepted by this server", (await verify(fx.owner.token)).json?.reason === "forged");
  const docs = [join(ROOT, "fixtures", "context", "README.md"), join(ROOT, "docs", "architecture", "identity.md")].map((f) => (existsSync(f) ? readFileSync(f, "utf8") : ""));
  const allCaps = [...CAPABILITY_MATRIX.public, ...CAPABILITY_MATRIX.account, ...Object.values(CAPABILITY_MATRIX.project).flatMap((m) => Object.values(m).flat()), ...CAPABILITY_MATRIX.staff];
  check("docs: the fixtures README and the identity ADR both list every capability in the matrix", docs.every((d) => d && allCaps.every((c) => d.includes(c))), allCaps.filter((c) => !docs.every((d) => d.includes(c))).join());

  // --- Forged body IDs and cross-account access: A versus B.
  const yBefore = titles(await sync(Y, []));
  const forgedSync = await X.api("POST", "/api/wall/sync", { stubs: [stub(ids.y1, "HIJACKED", Date.now() + 1000)], deleted: [ids.y2], accountId: cX.json.context.tenant.id, tenant: (await ctxOf(Y)).json.context.tenant.id, owner: "Y" });
  const yAfter = titles(await sync(Y, []));
  check("acl: X's sync with Y's stub ids and a forged owner touches nothing of Y's", forgedSync.status === 200 && JSON.stringify(yBefore) === JSON.stringify(yAfter) && !yAfter.some((s) => s.includes("HIJACKED")), yAfter.join());
  check("acl: X's own wall holds that body as X's copy, not as Y's", titles(await sync(X, [])).some((s) => s.startsWith(`${ids.y1}:HIJACKED`)) );
  const xShareOverwrite = await X.api("POST", "/api/share", { stub: stub(ids.y1, "Overwrite", t) });
  check("acl: X sharing a stub with Y's id gets its own token and leaves Y's share alone", xShareOverwrite.json.token !== shY1 && (await anon.api("GET", `/api/share/${shY1}`)).json.stub.event.title === "Y one");
  check("acl: X can't stop Y's sharing, and the answer matches a stub that doesn't exist", (await X.api("POST", "/api/share/revoke", { stubId: ids.y2 })).status === 404 && sameDenial(await X.api("POST", "/api/share/revoke", { stubId: ids.y2 }), await X.api("POST", "/api/share/revoke", { stubId: `ghost-${run}` })) && (await anon.api("GET", `/api/share/${shY2}`)).status === 200);
  check("acl: stop-sharing needs a body with a stubId, a session or a guest device", (await X.api("POST", "/api/share/revoke", {})).status === 400 && (await client("stranger").api("POST", "/api/share/revoke", { stubId: ids.x1 })).status === 404);
  const xOrder = await X.api("POST", "/api/orders", { order: { stubIds: [ids.y1], lines: [{ title: "t", material: "card", finish: "matte", size: "classic", totalMinor: 100 }], totalMinor: 100, method: "card", email: emailY, accountId: "Y" } });
  check("acl: an order naming Y's email, account and stub still belongs to X", xOrder.status === 200 && xOrder.json.order.email === emailX);
  check("acl: Y does not see X's order, and X sees it", !(await Y.api("GET", "/api/orders")).json.orders.some((o) => o.id === xOrder.json.order.id) && (await X.api("GET", "/api/orders")).json.orders.some((o) => o.id === xOrder.json.order.id));
  const forgedEvent = await X.api("POST", "/api/organizer/events", { title: "Not Y's", stub: stub(`ez-${run}`, "Z", t), guests: [{ name: "G" }], accountId: (await ctxOf(Y)).json.context.tenant.id, captain: "Y" });
  check("acl: an event created by X with Y's account id in the body is X's, not Y's", forgedEvent.status === 200 && (await ctxOf(X, `event:${forgedEvent.json.eventId}`)).json.context.role === "captain" && (await ctxOf(Y, `event:${forgedEvent.json.eventId}`)).status === 404);
  check("acl: a claim link needs a signed-in account and lands on that account", (await anon.api("POST", `/api/claim/${evX.claims[0].token}`)).status === 401);
  const claimed = await Y.api("POST", `/api/claim/${evX.claims[0].token}`, { accountId: "X", owner: "X" });
  check("acl: Y claiming X's link gets the stub on Y's wall only", claimed.status === 200 && titles(await sync(Y, [])).some((s) => s.startsWith(claimed.json.stub.id)) && !titles(await sync(X, [])).some((s) => s.startsWith(claimed.json.stub.id)));
  check("acl: a claim body naming another owner can't take a second claim", (await X.api("POST", `/api/claim/${evX.claims[0].token}`, { accountId: "X" })).status === 409);
  check("acl: delete and email-change ignore an account id in the body and use the session", (await X.api("DELETE", "/api/account", { confirm: emailY, accountId: "Y" })).status === 400 && (await Y.api("GET", "/api/auth/me")).json.account.email === emailY);
  const wallPub = await X.api("GET", "/api/wall/public");
  check("acl: the public-wall settings are the caller's own", wallPub.json.token === pubX && pubX !== pubY && (await Y.api("GET", "/api/wall/public")).json.token === pubY);
  check("acl: reading another account's private wall by token or id is 404", (await anon.api("GET", `/api/u/${shX1}`)).status === 404 && (await anon.api("GET", `/api/u/${ids.x1}`)).status === 404 && (await anon.api("GET", `/api/share/${pubX}`)).status === 404);
  check("acl: stub images need a live share token", (await fetch(`${BASE}/api/stub-image/${shX2}`)).status === 200 && (await fetch(`${BASE}/api/stub-image/${ids.x2}`)).status === 404);

  // --- Public projections: whitelisted fields only.
  const sharedView = await anon.api("GET", `/api/share/${shX1}`);
  const wallView = await anon.api("GET", `/api/u/${pubX}`);
  const leaks = (text) => ["SecretFriend", "SECRET NOTE", "Z9", emailX, emailY, "data:image", cX.json.context.tenant.id].filter((s) => text.includes(s));
  check("projection: a share holds no guest list, note, photos, account email or id", sharedView.status === 200 && leaks(sharedView.text).length === 0 && sharedView.json.stub.personal.friends.length === 0 && sharedView.json.stub.photos.length === 0 && !("note" in sharedView.json.stub.personal), leaks(sharedView.text).join());
  check("projection: the public wall holds none of them either", wallView.status === 200 && wallView.json.stubs.length >= 1 && leaks(wallView.text).length === 0 && wallView.json.stubs.every((s) => s.personal.friends.length === 0 && s.photos.length === 0 && !s.setId), leaks(wallView.text).join());
  const unknownField = await X.api("POST", "/api/share", { stub: stub(`uf-${run}`, "UF", t, { secretField: "PRIVATE-X", personal: { ...personal, ssn: "SSN-777" }, event: { type: "concert", title: "UF", facts: [], notes: "PRIVATE-N", ticketBarcode: "BARCODE-123" } }) });
  const ufView = await anon.api("GET", `/api/share/${unknownField.json.token}`);
  check("projection: fields nobody whitelisted (a barcode, a stray key) never come back", ufView.status === 200 && !/PRIVATE-X|PRIVATE-N|BARCODE-123|SSN-777/.test(ufView.text));
  const claimPreview = await anon.api("GET", `/api/claim/${evY.claims[0].token}`);
  check("projection: a claim preview shows the guest's name and no guest list", claimPreview.status === 200 && claimPreview.json.stub.personal.friends.length === 0 && !claimPreview.text.includes("SecretFriend"));
  const legacyToken = `legacy${run}`;
  try {
    const db = new DatabaseSync(DB);
    db.prepare("INSERT INTO shares (token, owner_key, stub_id, data, updated_at) VALUES (?, ?, ?, ?, ?)").run(legacyToken, "anon", `legacy-stub-${run}`, JSON.stringify(stub(`legacy-stub-${run}`, "Legacy row", t, { personal, setId: "SET-LEAK" })), Date.now());
    db.close();
    const lv = await anon.api("GET", `/api/share/${legacyToken}`);
    check("projection: an older row stored whole is projected on the way out", lv.status === 200 && lv.json.stub.event.title === "Legacy row" && !/SecretFriend|SECRET NOTE|SET-LEAK/.test(lv.text));
    check("projection: nobody owns an old anonymous row, so nobody can revoke it", (await X.api("POST", "/api/share/revoke", { stubId: `legacy-stub-${run}` })).status === 404);
  } catch (e) {
    check("projection: an older row stored whole is projected on the way out", false, `(could not edit ${DB}: ${e.message})`);
  }

  // --- Revocation and rotation.
  const rev1 = await X.api("POST", "/api/share/revoke", { stubId: ids.x1 });
  check("share: the owner stops sharing a stub", rev1.status === 200 && rev1.json.revoked === true);
  check("share: the old link is 404 afterwards, the other stub's link is untouched", (await anon.api("GET", `/api/share/${shX1}`)).status === 404 && (await fetch(`${BASE}/api/stub-image/${shX1}`)).status === 404 && (await anon.api("GET", `/api/share/${shX2}`)).status === 200);
  const rev2 = await X.api("POST", "/api/share/revoke", { stubId: ids.x1 });
  check("share: stopping twice is harmless", rev2.status === 200 && rev2.json.revoked === false);
  const reshare = await X.api("POST", "/api/share", { stub: stub(ids.x1, "X one again", t) });
  check("share: sharing again mints a new link and the old one stays dead", reshare.json.token !== shX1 && (await anon.api("GET", `/api/share/${reshare.json.token}`)).status === 200 && (await anon.api("GET", `/api/share/${shX1}`)).status === 404);
  const guestC = client("guest-share");
  const gs = await guestC.api("POST", "/api/share", { stub: stub(`g-${run}`, "Guest stub", t) });
  check("share: a guest's share is bound to a server-issued device cookie", gs.status === 200 && guestC.jar.has("ts_device") && /httponly/i.test(gs.headers.getSetCookie().find((c) => c.startsWith("ts_device=")) ?? ""));
  const guestCtx = await ctxOf(guestC, `stub:g-${run}`);
  check("share: that guest is the owner of that draft and of nothing else", guestCtx.status === 200 && guestCtx.json.context.actor.kind === "guest" && guestCtx.json.context.tenant.id.startsWith("guest:") && guestCtx.json.context.role === "owner" && !guestCtx.json.context.capabilities.includes("wall.sync") && (await ctxOf(guestC, `stub:${ids.x2}`)).status === 404);
  check("share: another device can't stop that guest's sharing", (await client("other-dev").api("POST", "/api/share/revoke", { stubId: `g-${run}` })).status === 404);
  const guestRev = await guestC.api("POST", "/api/share/revoke", { stubId: `g-${run}` });
  check("share: the guest stops their own share and the link dies", guestRev.status === 200 && (await anon.api("GET", `/api/share/${gs.json.token}`)).status === 404);
  const guestAdopt = client("guest-adopt");
  const ga = await guestAdopt.api("POST", "/api/share", { stub: stub(`ga-${run}`, "Adopt me", t) });
  const adopter = `smoke-adopt-${run}@example.com`;
  await guestAdopt.signIn(adopter);
  const adopted = await ctxOf(guestAdopt, `stub:ga-${run}`);
  check("claim: a guest's drafts move to the account only after it proves an email, and the link keeps working", adopted.status === 200 && adopted.json.context.actor.kind === "account" && adopted.json.context.role === "owner" && (await anon.api("GET", `/api/share/${ga.json.token}`)).status === 200);

  const rot = await X.api("PUT", "/api/wall/public", { isPublic: true, rotate: true });
  check("wall: rotating issues a new public token and the old one is 404", rot.status === 200 && rot.json.token && rot.json.token !== pubX && (await anon.api("GET", `/api/u/${pubX}`)).status === 404 && (await anon.api("GET", `/api/u/${rot.json.token}`)).status === 200);
  check("wall: rotating X's wall leaves Y's alone", (await anon.api("GET", `/api/u/${pubY}`)).status === 200);
  const stop = await X.api("PUT", "/api/wall/public", { isPublic: false, rotate: true });
  check("wall: stop sharing makes it private and both tokens are 404", stop.status === 200 && stop.json.token === null && (await anon.api("GET", `/api/u/${rot.json.token}`)).status === 404 && (await anon.api("GET", `/api/u/${pubX}`)).status === 404);
  const back2 = await X.api("PUT", "/api/wall/public", { isPublic: true });
  check("wall: sharing again gives a third, new token", back2.json.token && ![pubX, rot.json.token].includes(back2.json.token));
  check("wall: rotate must be a boolean", (await X.api("PUT", "/api/wall/public", { isPublic: true, rotate: "yes" })).status === 400);

  // --- Legacy encoded links: readable, untrusted, never an owner.
  const legacyStub = stub(ids.x2, "Legacy payload", t, { personal });
  const payload = encodeLegacy(legacyStub);
  const legacyPage = await fetch(`${BASE}/s/${payload}`);
  const legacyHtml = await legacyPage.text();
  check("legacy: an encoded /s/<payload> link still opens", legacyPage.status === 200);
  check("legacy: /s and /u pages are noindex", /noindex/i.test(legacyHtml) && /noindex/i.test(await (await fetch(`${BASE}/u/${pubY}`)).text()));
  check("legacy: the API has no payload route: the decoded id grants nothing", (await X.api("GET", `/api/share/${payload}`)).status === 404 && (await X.api("POST", `/api/claim/${payload}`)).status === 404 && (await anon.api("GET", `/api/u/${payload}`)).status === 404);
  check("legacy: a payload naming X's stub id doesn't make a stranger its owner", (await ctxOf(Y, `stub:${ids.x2}`)).status === 404 && (await Y.api("POST", "/api/share/revoke", { stubId: ids.x2 })).status === 404);
  const memSrc = readFileSync(join(ROOT, "src", "app", "s", "[token]", "MemoryPage.tsx"), "utf8");
  check("legacy: the memory page never treats a payload link as owned, and says it is old", /const isOwner = !!owned && !legacy/.test(memSrc) && /Old share link/.test(memSrc));

  // --- Gift messages: only the gift's own token shows them, never a share, page, wall or image.
  const GIFT_NOTE = `GIFT-NOTE-${run}-for-Sam`;
  const giftStubId = `${ids.x2}-g${run}`;
  const shGift = (await X.api("POST", "/api/share", { stub: stub(giftStubId, "Gift stub", t, { personal: { ...personal, note: GIFT_NOTE } }) })).json.token;
  check("gift: a stub's share carries no note even when the gift copy had one", !JSON.stringify((await anon.api("GET", `/api/share/${shGift}`)).json).includes(GIFT_NOTE));
  const gMade = await X.api("POST", "/api/gift", { stub: giftStubId, to: "Sam", message: GIFT_NOTE });
  const gTok = gMade.json?.giftToken;
  check("gift: the owner makes one and gets { giftToken, sharePath }", gMade.status === 200 && /^[\w-]{20,}$/.test(gTok ?? "") && gMade.json.sharePath === `/s/${shGift}?gift=${gTok}` && gTok !== shGift, gMade.text);
  const gGet = await anon.api("GET", `/api/gift/${gTok}`);
  check("gift: anyone holding the gift token reads the message, the recipient and the projected stub", gGet.status === 200 && gGet.json.message === GIFT_NOTE && gGet.json.to === "Sam" && gGet.json.stub.event.title === "Gift stub" && gGet.json.stub.personal.friends.length === 0 && !("note" in gGet.json.stub.personal), gGet.text);
  check("gift: the first open is recorded for the recipient, and the sender's own preview doesn't change it", gGet.json.openedAt > 0 && (await X.api("GET", `/api/gift/${gTok}`)).json.openedAt === gGet.json.openedAt);
  check("gift: the response is not cached or indexed", gGet.headers.get("cache-control") === "no-store" && /noindex/.test(gGet.headers.get("x-robots-tag") ?? ""));
  const gWhere = [
    ["GET /api/share/<token>", (await anon.api("GET", `/api/share/${shGift}`)).text],
    ["GET /api/stub-image/<token>", await (await fetch(`${BASE}/api/stub-image/${shGift}`)).text()],
    ["GET /s/<token>", await (await fetch(`${BASE}/s/${shGift}`)).text()],
    ["GET /s/<token>?gift=<token>", await (await fetch(`${BASE}/s/${shGift}?gift=${gTok}`)).text()],
    ["GET /u/<wall>", await (await fetch(`${BASE}/u/${pubX}`)).text()],
    ["GET /api/u/<wall>", (await anon.api("GET", `/api/u/${pubX}`)).text],
    ["GET /api/context", (await X.api("GET", `/api/context?project=stub:${giftStubId}`)).text],
    ["POST /api/wall/sync", (await sync(X, [])).text],
  ].filter(([, body]) => body.includes(GIFT_NOTE)).map(([name]) => name);
  check("gift: the message appears in no share, page, stub image, wall or context response", gWhere.length === 0, gWhere.join(", "));
  const gRow = (() => {
    try {
      const db = new DatabaseSync(DB);
      const row = db.prepare("SELECT token_hash FROM gifts WHERE recipient = 'Sam' AND message = ?").get(GIFT_NOTE);
      db.close();
      return row ?? null;
    } catch {
      return null;
    }
  })();
  if (gRow) check("gift: the database holds only the SHA-256 of the gift token", gRow.token_hash === createHash("sha256").update(gTok).digest("hex"));
  else console.log(`skip gift hashed-token check: could not read ${DB}`);
  check("gift: a wrong or malformed gift token is 404", (await anon.api("GET", "/api/gift/nope-nope-nope-nope")).status === 404 && (await anon.api("GET", `/api/gift/${shGift}`)).status === 404 && (await anon.api("GET", "/api/gift/%20x")).status === 404);
  check("gift: a gift token is not a share token", (await anon.api("GET", `/api/share/${gTok}`)).status === 404);
  check("gift: a non-owner can't make a gift for someone else's stub, and it looks like a missing stub", (await Y.api("POST", "/api/gift", { stub: giftStubId, to: "Sam", message: "hijack" })).status === 404 && sameDenial(await Y.api("POST", "/api/gift", { stub: giftStubId, to: "Sam", message: "x" }), await Y.api("POST", "/api/gift", { stub: `ghost-${run}`, to: "Sam", message: "x" })));
  check("gift: an anonymous caller or a fresh guest device can't make one", (await anon.api("POST", "/api/gift", { stub: giftStubId, to: "Sam", message: "x" })).status === 404 && (await client("gift-stranger").api("POST", "/api/gift", { stub: giftStubId, to: "Sam", message: "x" })).status === 404);
  check("gift: an owned stub that was never shared has nothing to unwrap (404)", (await X.api("POST", "/api/gift", { stub: ids.x1, to: "Sam", message: "x" })).status === 404 || (await anon.api("GET", `/api/share/${shX1}`)).status === 404);
  check("gift: a bad body is 400 (no recipient, long message, non-text message, no stub)", (await X.api("POST", "/api/gift", { stub: giftStubId, to: "", message: "x" })).status === 400 && (await X.api("POST", "/api/gift", { stub: giftStubId, to: "Sam", message: "x".repeat(281) })).status === 400 && (await X.api("POST", "/api/gift", { stub: giftStubId, to: "Sam", message: { a: 1 } })).status === 400 && (await X.api("POST", "/api/gift", { to: "Sam" })).status === 400);
  const gMax = await X.api("POST", "/api/gift", { stub: giftStubId, to: "Sam", message: `${"y".repeat(278)}\u0000\u0007ok` });
  check("gift: a 280 character message is kept, with control characters stripped", gMax.status === 200 && (await anon.api("GET", `/api/gift/${gMax.json.giftToken}`)).json.message === `${"y".repeat(278)}ok`);
  check("gift: a non-owner can't revoke it, and gets the same 404 as an unknown gift", (await Y.api("DELETE", `/api/gift/${gTok}`)).status === 404 && sameDenial(await Y.api("DELETE", `/api/gift/${gTok}`), await Y.api("DELETE", "/api/gift/nope-nope-nope-nope")) && (await anon.api("DELETE", `/api/gift/${gTok}`)).status === 404 && (await anon.api("GET", `/api/gift/${gTok}`)).status === 200);
  const gRev = await X.api("DELETE", `/api/gift/${gTok}`);
  check("gift: the sender revokes it, the link is 404 from then on and the share still works", gRev.status === 200 && (await anon.api("GET", `/api/gift/${gTok}`)).status === 404 && (await anon.api("GET", `/api/share/${shGift}`)).status === 200 && (await X.api("DELETE", `/api/gift/${gTok}`)).status === 404);
  if (gRow) {
    const db = new DatabaseSync(DB);
    check("gift: revoking deletes the message from the database", db.prepare("SELECT COUNT(*) AS n FROM gifts WHERE token_hash = ?").get(gRow.token_hash).n === 0);
    db.close();
  }
  const gStop = await X.api("POST", "/api/gift", { stub: giftStubId, to: "Sam", message: "stop-with-share" });
  await X.api("POST", "/api/share/revoke", { stubId: giftStubId });
  check("gift: stopping the stub's share kills its gifts too", gStop.status === 200 && (await anon.api("GET", `/api/gift/${gStop.json.giftToken}`)).status === 404 && (await anon.api("GET", `/api/gift/${gMax.json.giftToken}`)).status === 404);
  const gGuest = client("gift-guest");
  const ggId = `gg-${run}`;
  const ggShare = await gGuest.api("POST", "/api/share", { stub: stub(ggId, "Guest gift", t) });
  const ggMade = await gGuest.api("POST", "/api/gift", { stub: ggId, to: "Kim", message: "from a guest" });
  check("gift: a guest device makes one for the draft it shared", ggMade.status === 200 && ggMade.json.sharePath === `/s/${ggShare.json.token}?gift=${ggMade.json.giftToken}` && (await anon.api("GET", `/api/gift/${ggMade.json.giftToken}`)).json.message === "from a guest");
  check("gift: another guest device can't revoke it, the owner device can", (await client("gift-other").api("DELETE", `/api/gift/${ggMade.json.giftToken}`)).status === 404 && (await gGuest.api("DELETE", `/api/gift/${ggMade.json.giftToken}`)).status === 200);
  check("gift: an old ?gift=1&to= link still opens", (await fetch(`${BASE}/s/${ggShare.json.token}?gift=1&to=Sam`)).status === 200);
  const gLive = await X.api("POST", "/api/share", { stub: stub(giftStubId, "Gift stub again", t) });
  const gCsrf = await X.api("POST", "/api/gift", { stub: giftStubId, to: "Sam", message: "csrf" });
  const gCsrfTok = gCsrf.json?.giftToken ?? "nope-nope-nope-nope";
  const gBad = [];
  for (const origin of [null, "https://evil.example", "http://localhost.evil.example"]) {
    for (const [m, path, body] of [["POST", "/api/gift", { stub: giftStubId, to: "Sam", message: "x" }], ["DELETE", `/api/gift/${gCsrfTok}`, undefined]]) {
      const r = await X.api(m, path, body, { origin });
      if (r.status !== 403) gBad.push(`${m} ${path} origin=${origin} -> ${r.status}`);
    }
  }
  check("gift: create and revoke refuse a missing or foreign Origin with 403 and change nothing", gLive.status === 200 && gCsrf.status === 200 && gBad.length === 0 && (await anon.api("GET", `/api/gift/${gCsrfTok}`)).status === 200, gBad.join("; "));

  // --- CSRF and Origin on every mutating route.
  const csrfRoutes = [
    ["POST", "/api/wall/sync", { stubs: [], deleted: [] }],
    ["PUT", "/api/wall/public", { isPublic: true }],
    ["POST", "/api/orders", { order: {} }],
    ["POST", "/api/organizer/events", {}],
    ["POST", `/api/claim/${evY.claims[0].token}`, {}],
    ["DELETE", "/api/account", { confirm: emailX }],
    ["POST", "/api/account/email", { email: `smoke-csrf-${run}@example.com` }],
    ["POST", "/api/share", { stub: stub("c", "c", t) }],
    ["POST", "/api/share/revoke", { stubId: ids.x2 }],
    ["POST", "/api/auth/signout", {}],
    ["POST", "/api/auth/link", { email: emailX, reason: "save" }],
    ["POST", "/api/auth/confirm", { token: "x" }],
  ];
  const csrfBad = [];
  for (const [m, path, body] of csrfRoutes) {
    for (const origin of [null, "https://evil.example", "http://localhost.evil.example"]) {
      const r = await X.api(m, path, body, { origin });
      if (r.status !== 403) csrfBad.push(`${m} ${path} origin=${origin} -> ${r.status}`);
    }
  }
  check("csrf: every mutating route refuses a missing or foreign Origin with 403", csrfBad.length === 0, csrfBad.join("; "));
  check("csrf: X's session and data survived all of that", (await X.api("GET", "/api/auth/me")).json.account.email === emailX && titles(await sync(X, [])).length > 0);
  check("csrf: art refuses a foreign Origin; a guest with no Origin still gets art", (await anon.api("POST", "/api/art", { event: { type: "concert", title: "x", facts: [] } }, { origin: "https://evil.example" })).status === 403 && (await client("art-noorigin").api("POST", "/api/art", { event: { type: "concert", title: "x", facts: [] } }, { origin: null })).status === 200);

  // --- Membership revision, revocation, deletion.
  const Z = client("Z");
  const emailZ = `smoke-z-${run}@example.com`;
  await Z.signIn(emailZ);
  const z0 = (await ctxOf(Z)).json;
  check("lifecycle: a new account starts at a membership revision and its token verifies", Number.isInteger(z0.context.membershipRevision) && (await verify(z0.token)).status === 200);
  const zNew = `smoke-z2-${run}@example.com`;
  const zLink = await Z.api("POST", "/api/account/email", { email: zNew, accountId: "someone-else" });
  await anon.api("POST", "/api/auth/confirm", { token: tokenOf(zLink.json.devLink) });
  const zAfterEmail = await verify(z0.token);
  check("lifecycle: an email change makes earlier tokens stale", zAfterEmail.status === 401 && zAfterEmail.json.reason === "stale", JSON.stringify(zAfterEmail.json));
  const z1 = (await ctxOf(Z)).json;
  check("lifecycle: the revision went up and a fresh token is good", z1.context.membershipRevision > z0.context.membershipRevision && (await verify(z1.token)).status === 200);
  const Z2 = client("Z-second-device");
  await Z2.signIn(zNew);
  const z2 = (await ctxOf(Z2)).json;
  check("lifecycle: two devices, one account, one revision", z2.context.tenant.id === z1.context.tenant.id && z2.context.membershipRevision === z1.context.membershipRevision);
  const everywhere = await Z.api("POST", "/api/auth/signout", { everywhere: true });
  check("lifecycle: sign out everywhere ends both sessions", everywhere.status === 200 && (await Z.api("GET", "/api/auth/me")).json.account === null && (await Z2.api("GET", "/api/auth/me")).json.account === null);
  const zv1 = await verify(z1.token);
  const zv2 = await verify(z2.token);
  check("lifecycle: tokens from both devices read as revoked", zv1.json.reason === "revoked" && zv2.json.reason === "revoked", `${zv1.text} ${zv2.text}`);
  const staleCookie = await Z2.api("GET", "/api/context");
  check("lifecycle: a revoked session's cookie is an anonymous context flagged revoked, with no token", staleCookie.json.context.revoked === true && staleCookie.json.context.actor.kind === "anonymous" && staleCookie.json.token === null);
  check("lifecycle: sign out everywhere needs a session", (await client("nobody").api("POST", "/api/auth/signout", { everywhere: true })).status === 401);
  const W = client("W");
  const emailW = `smoke-w-${run}@example.com`;
  await W.signIn(emailW);
  const w0 = (await ctxOf(W)).json;
  await W.api("POST", "/api/auth/signout", {});
  check("lifecycle: plain sign-out revokes that browser's token", (await verify(w0.token)).json.reason === "revoked");
  const D = client("D");
  const emailD = `smoke-d-${run}@example.com`;
  await D.signIn(emailD);
  const d0 = (await ctxOf(D)).json;
  await D.api("DELETE", "/api/account", { confirm: emailD });
  check("lifecycle: deleting the account revokes its tokens", (await verify(d0.token)).json.reason === "revoked");

  // --- Staff and the admin capability.
  check("staff: a non-staff account holds no admin.view, in any context", !cX.json.context.capabilities.includes("admin.view") && !cX1.json.context.capabilities.includes("admin.view") && cX.json.context.role !== "staff");
  if (ADMIN_EMAIL) {
    const S = client("staff");
    await S.signIn(ADMIN_EMAIL);
    const s0 = await ctxOf(S);
    check("staff: an ADMIN_EMAILS account gets role staff and admin.view", s0.status === 200 && s0.json.context.role === "staff" && s0.json.context.capabilities.includes("admin.view"), JSON.stringify(s0.json.context));
    check("staff: staff gets no read access to anyone's stub or event", (await ctxOf(S, `stub:${ids.x2}`)).status === 404 && (await ctxOf(S, `event:${evX.eventId}`)).status === 404);
    check("staff: gaining the staff list moved the membership revision", s0.json.context.membershipRevision >= 2);
    try {
      const db = new DatabaseSync(DB);
      db.prepare("UPDATE accounts SET is_staff = 0 WHERE email = ?").run(ADMIN_EMAIL.toLowerCase());
      db.close();
      const s1 = await ctxOf(S);
      check("staff: a change in staff status bumps the revision and stales earlier tokens", s1.json.context.membershipRevision > s0.json.context.membershipRevision && (await verify(s0.json.token)).json?.reason === "stale");
    } catch (e) {
      check("staff: a change in staff status bumps the revision", false, `(could not edit ${DB}: ${e.message})`);
    }
  } else {
    console.log("skip staff-role checks: set SMOKE_ADMIN_EMAIL to an address in the server's ADMIN_EMAILS to run them");
  }

  // --- No secrets in anything the server said, and none in the client bundles.
  const secrets = Object.entries(process.env).filter(([k, v]) => /(SECRET|API_KEY|TOKEN|PASSWORD)/.test(k) && (v ?? "").length >= 8).map(([, v]) => v);
  const sessions = clients.flatMap((c) => [...c.jar].filter(([k]) => k === "ts_session" || k === "ts_device").map(([, v]) => v));
  const bodies = responses.join("\n");
  check("secrets: no configured secret, fixture key or session/device cookie value appears in any response body", ![...secrets, keyFile.key, ...sessions].some((s) => s && bodies.includes(s)));
  check("secrets: no storage internals (hashes, revision columns, signing key material) in any response", !/token_hash|membership_revision|CONTEXT_SECRET|__ticketstubContextKey|RESEND_API_KEY/.test(bodies));
  const graph = importGraphCheck();
  check(`static: no client component imports src/server (${graph.roots} client files, ${graph.files} files)`, graph.roots > 10 && graph.bad.length === 0, graph.bad.join(" | "));
  const chunks = clientChunkScan();
  check(`static: no server marker in built client chunks (${chunks.scanned} files in ${chunks.dirs} build dirs)`, chunks.dirs > 0 && chunks.scanned > 0 && chunks.hits.length === 0, chunks.hits.slice(0, 5).join(" | "));
}

// GT-09: product events, the error envelope and the message catalog.
async function gt09() {
  const t0 = Date.now() - 1000;
  const evs = await import(pathToFileURL(join(ROOT, "src", "server", "events.ts")).href);
  const { MESSAGES, MESSAGE_CODES } = await import(pathToFileURL(join(ROOT, "src", "customer", "feedback-messages", "messages.ts")).href);
  const { sanitizeEvent, sanitizeFields, refOf, requestIdOf, EVENT_SCHEMA, EVENT_TYPES, EVENT_SPEC, pushRing, ringEvents, exportToHarness } = evs;
  const UNSAFE = /@|:\/\/|[?&][\w.%-]+=|[A-Za-z0-9_-]{24,}/;

  // --- The sanitizer: nothing outside the taxonomy, and nothing that looks like an email, URL, query string or token, survives.
  const ref = refOf("stub-1");
  check("events: the taxonomy names every required type", ["intake_submitted", "intake_rejected", "research_started", "fact_corrected", "art_requested", "art_ready", "art_failed", "art_limit", "version_selected", "share_created", "share_revoked", "gift_created", "order_placed", "order_blocked", "signin_link_sent", "signed_in", "claim_redeemed", "storage_unavailable"].every((t) => EVENT_TYPES.includes(t)));
  check("events: refOf is a stable 16-hex hash that does not contain the id", refOf("stub-1") === ref && /^[a-f0-9]{16}$/.test(ref) && refOf("stub-2") !== ref && !ref.includes("stub"));
  const dirty = {
    code: "me@example.com",
    source: "https://example.com/e?token=abcdefghijklmnopqrstuvwxyz0123456789",
    note: "my private note",
    email: "someone@example.com",
    url: "https://x.example/p?a=b",
    prompt: "a moody poster of Alice",
    photo: "data:image/png;base64,AAAA",
    token: "abcdefghijklmnopqrstuvwxyz0123456789ABCD",
    facts: 4,
  };
  const hostile = sanitizeEvent({ type: "intake_rejected", fields: dirty });
  check("events: the sanitizer strips an email in a code field and every field the type does not name", hostile && Object.keys(hostile.fields).length === 0, JSON.stringify(hostile?.fields));
  const research = sanitizeEvent({ type: "research_started", fields: dirty });
  check("events: a URL with a query string or a token in an enum field is dropped; a clean count is kept", research && research.fields.facts === 4 && !("source" in research.fields) && Object.keys(research.fields).length === 1, JSON.stringify(research?.fields));
  const wrongKinds = sanitizeFields("order_placed", { order: "ord_abc@x.com", lines: "3", totalMinor: -5 });
  check("events: values of the wrong kind (unhashed id, string count, negative) are dropped", Object.keys(wrongKinds).length === 0, JSON.stringify(wrongKinds));
  const all = sanitizeEvent({ type: "gift_created", requestId: "bad id with spaces & https://x?y=1", actor: "account", actorRef: "me@example.com", projectRef: "not-a-ref", fields: { share: ref, messageChars: 12, message: "Happy birthday Bob" } });
  check("events: a malformed request id, actor ref and project ref are replaced or dropped", all.requestId.startsWith("req_") && all.actorRef === undefined && all.projectRef === undefined && all.fields.share === ref && all.fields.messageChars === 12 && !("message" in all.fields));
  check("events: nothing in a finished event matches an email, URL, query string or long token", !UNSAFE.test(JSON.stringify([hostile, research, all]).replace(/"(?:requestId)":"req_[\w-]+"/g, "")));
  check("events: an unknown type is refused, and the prototype is not a type", sanitizeEvent({ type: "page_view" }) === null && sanitizeEvent({ type: "__proto__" }) === null && sanitizeEvent({ type: "constructor" }) === null);
  check("events: every spec field is one of ref, code, count, ts, flag or a fixed word list", EVENT_TYPES.every((t) => Object.values(EVENT_SPEC[t]).every((k) => ["ref", "code", "count", "ts", "flag"].includes(k) || Array.isArray(k))));
  check("events: x-request-id is kept when well formed and replaced when not", requestIdOf(new Headers({ "x-request-id": "smoke-0123456789" })) === "smoke-0123456789" && /^req_/.test(requestIdOf(new Headers({ "x-request-id": "no spaces allowed here!" }))) && /^req_/.test(requestIdOf(new Headers())));
  const down = sanitizeEvent({ type: "storage_unavailable", fields: { code: "storage_unavailable", route: "auth_link" } });
  pushRing(down);
  check("events: with storage down an event goes to the in-memory ring", ringEvents().some((e) => e.type === "storage_unavailable" && e.fields.route === "auth_link"));
  check("events: exportToHarness does nothing unless TICKETSTUB_HARNESS_EXPORT=neatlogs (nothing sent, nothing thrown)", process.env.TICKETSTUB_HARNESS_EXPORT === "neatlogs" || (await exportToHarness([down])) === undefined);

  // --- Real actions, then what was recorded.
  const P = client("evP"); // owner
  const Q = client("evQ"); // another account
  const emailP = `smoke-evp-${run}@example.com`;
  const emailQ = `smoke-evq-${run}@example.com`;
  const rid = (what) => `smoke-${run}-${what}`;
  const asReq = (what) => ({ headers: { "x-request-id": rid(what) } });
  const linkRes = await P.api("POST", "/api/auth/link", { email: emailP, returnTo: "/wall", reason: "save" }, asReq("link"));
  check("events: the answer carries the caller's x-request-id", linkRes.headers.get("x-request-id") === rid("link"), String(linkRes.headers.get("x-request-id")));
  const badRid = await P.api("POST", "/api/auth/link", { email: "nope", reason: "save" }, { headers: { "x-request-id": "bad id!" } });
  check("events: a malformed x-request-id is replaced by a generated one", /^req_[\w-]{8,}$/.test(badRid.headers.get("x-request-id") ?? ""), String(badRid.headers.get("x-request-id")));
  const tok = tokenOf(linkRes.json.devLink);
  await P.api("POST", "/api/auth/confirm", { token: tok }, asReq("confirm"));
  await Q.signIn(emailQ);
  const sid = `ev-${run}`;
  const t = Date.now() - 3_600_000;
  await sync(P, [stub(sid, "Event smoke", t)]);
  const share = await P.api("POST", "/api/share", { stub: stub(sid, "Event smoke", t) }, asReq("share"));
  const gift = await P.api("POST", "/api/gift", { stub: sid, to: "Alice", message: "Private words for Alice" }, asReq("gift"));
  const order = await P.api("POST", "/api/orders", { order: { stubIds: [sid], lines: [{ title: "Event smoke", material: "digital", finish: "matte", size: "file", totalMinor: 900 }], totalMinor: 900, method: "card" } }, asReq("order"));
  const blocked = await P.api("POST", "/api/orders", { order: { stubIds: [sid], lines: [{ title: "Event smoke", material: "digital", finish: "matte", size: "classic", totalMinor: 900 }], totalMinor: 900, method: "card" } }, asReq("blocked"));
  check("events: setup ran (share, gift, order placed, an order blocked)", share.status === 200 && gift.status === 200 && order.status === 200 && blocked.status === 422 && blocked.json?.error?.code === "variant_not_orderable", `${share.status} ${gift.status} ${order.status} ${blocked.status}`);
  await P.api("POST", "/api/research", { query: "neat" }, asReq("search"));
  await P.api("POST", "/api/research", { url: "neathack" }, asReq("research"));
  const rej = await P.api("POST", "/api/research", { url: "" }, asReq("rejected"));
  check("events: a rejected intake is the one error envelope", rej.status === 422 && rej.json?.error?.code === "unreadable_link" && typeof rej.json.error.message === "string", rej.text);
  const art = await P.api("POST", "/api/art", { event: { title: "Event smoke" } }, asReq("art"));
  check("events: art still answers", art.status === 200 || art.status === 429, String(art.status));
  const cev = await P.api("POST", "/api/organizer/events", { title: "Event smoke set", stub: stub(`evset-${run}`, "Event smoke set", t), guests: [{ name: "Guest One" }] });
  const claimed = await Q.api("POST", `/api/claim/${cev.json.claims[0].token}`, {}, asReq("claim"));
  check("events: a guest claim went through", claimed.status === 200, claimed.text.slice(0, 120));
  const vs = await P.api("POST", "/api/events", { type: "version_selected", project: sid, fields: { version: "v-secret-1", versions: 3, note: "x@y.com" } }, asReq("version"));
  const fc = await P.api("POST", "/api/events", { type: "fact_corrected", project: sid, fields: { fact: "date", versions: 1 } }, asReq("fact"));
  check("events: the browser can report a version choice and a fact correction for its own stub", vs.status === 200 && fc.status === 200, `${vs.status} ${fc.status}`);
  check("events: only the owner's own project can collect browser events (another account gets 404)", (await Q.api("POST", "/api/events", { type: "version_selected", project: sid, fields: {} })).status === 404);
  check("events: the browser cannot report a server-side type", (await P.api("POST", "/api/events", { type: "order_placed", fields: {} })).status === 400 && (await P.api("POST", "/api/events", { type: "signed_in" })).status === 400);
  check("events: POST /api/events needs a same-site Origin", (await P.api("POST", "/api/events", { type: "version_selected", fields: {} }, { origin: null })).status === 403);
  await P.api("POST", "/api/share/revoke", { stubId: sid }, asReq("revoke"));

  // --- The owner's history, and nobody else's.
  const mine = await P.api("GET", `/api/events?project=stub:${sid}`);
  const types = (mine.json?.events ?? []).map((e) => e.type);
  check("events: the owner reads their project's history", mine.status === 200 && mine.json.schema === EVENT_SCHEMA && ["share_created", "gift_created", "version_selected", "fact_corrected", "share_revoked"].every((x) => types.includes(x)), `${mine.status} ${types}`);
  check("events: every event carries the schema, a request id, a time and the project's hash only", mine.json.events.every((e) => e.schema === EVENT_SCHEMA && /^[\w.-]{8,64}$/.test(e.requestId) && Number.isInteger(e.at) && e.projectRef === refOf(sid)));
  check("events: the correlation id the caller sent is on the events it caused", mine.json.events.some((e) => e.type === "share_created" && e.requestId === rid("share")) && mine.json.events.some((e) => e.type === "gift_created" && e.requestId === rid("gift")));
  const leak = [emailP, emailQ, sid, share.json.token, gift.json.giftToken, tok, "Alice", "Private words", "Event smoke", "v-secret-1", "x@y.com", "devLink"];
  check("events: the history leaks no id, email, name, note, token or title", !leak.some((v) => v && mine.text.includes(v)), leak.filter((v) => v && mine.text.includes(v)).join(","));
  check("events: no ref is a raw id (every ref field is 16-hex)", mine.json.events.every((e) => Object.entries(e.fields).every(([k, v]) => !["share", "version", "fact"].includes(k) || /^[a-f0-9]{16}$/.test(v))));
  const theirs = await Q.api("GET", `/api/events?project=stub:${sid}`);
  const nothing = await Q.api("GET", `/api/events?project=stub:nothing-${run}`);
  check("events: another account asking for it gets 404, identical to a project that does not exist (A vs B)", theirs.status === 404 && theirs.text === nothing.text && theirs.json.error.code === "not_found", `${theirs.status} ${theirs.text}`);
  check("events: an organizer event's history is the captain's alone", (await Q.api("GET", `/api/events?project=event:${cev.json.eventId}`)).status === 404 && (await P.api("GET", `/api/events?project=event:${cev.json.eventId}`)).status === 200);
  const capt = await P.api("GET", `/api/events?project=event:${cev.json.eventId}`);
  check("events: the captain's history never repeats the event id", !capt.text.includes(cev.json.eventId));
  check("events: anonymous gets 404", (await client("evAnon").api("GET", `/api/events?project=stub:${sid}`)).status === 404);
  check("events: no project and no scope is a 404, and so is a malformed project", (await P.api("GET", "/api/events")).status === 404 && (await P.api("GET", "/api/events?project=%00bad")).status === 404);
  const wide = await P.api("GET", "/api/events?scope=all");
  check("events: the staff-wide scope is a 404 for an ordinary account", wide.status === 404 && wide.json.error.code === "not_found");
  if (ADMIN_EMAIL) {
    const S = client("evStaff");
    await S.signIn(ADMIN_EMAIL);
    const all2 = await S.api("GET", "/api/events?scope=all");
    const wideTypes = new Set((all2.json?.events ?? []).map((e) => e.type));
    check("events: staff read events across projects under admin.view", all2.status === 200 && ["intake_rejected", "research_started", "order_placed", "signin_link_sent", "signed_in", "claim_redeemed"].every((x) => wideTypes.has(x)), `${all2.status} ${[...wideTypes]}`);
    check("events: the staff-wide history is just as clean", !leak.some((v) => v && all2.text.includes(v)));
  } else {
    console.log("skip staff-wide events check: set SMOKE_ADMIN_EMAIL to run it");
  }

  // --- The table itself: every main action recorded, append-only, nothing unsafe stored.
  try {
    const db = new DatabaseSync(DB);
    const rows = db.prepare("SELECT * FROM events WHERE at >= ?").all(t0);
    const seen = new Set(rows.map((r) => r.type));
    const wanted = ["intake_submitted", "intake_rejected", "research_started", "art_requested", "art_ready", "version_selected", "fact_corrected", "share_created", "share_revoked", "gift_created", "order_placed", "order_blocked", "signin_link_sent", "signed_in", "claim_redeemed"];
    check("events: the table recorded every main action of this run", wanted.every((x) => seen.has(x)), `missing ${wanted.filter((x) => !seen.has(x))}`);
    check("events: one request id ties a request's events together", rows.some((r) => r.request_id === rid("share") && r.type === "share_created") && rows.some((r) => r.request_id === rid("link") && r.type === "signin_link_sent"));
    const text = JSON.stringify(rows).replace(/"(?:actor_ref|tenant_ref|project_ref)":"[a-f0-9]{16}"/g, "").replace(/"request_id":"[\w.-]+"/g, "");
    check("events: nothing stored matches an email, URL, query string or long token", !UNSAFE.test(text), text.match(UNSAFE)?.[0]);
    check("events: the stored refs are hashes, never the account or stub id", rows.every((r) => [r.actor_ref, r.tenant_ref, r.project_ref].every((v) => v === null || /^[a-f0-9]{16}$/.test(v))));
    let updated = false;
    try {
      db.prepare("UPDATE events SET type = 'x' WHERE at >= ?").run(t0);
      updated = true;
    } catch {
      /* refused, as intended */
    }
    let deleted = false;
    try {
      db.prepare("DELETE FROM events WHERE at >= ?").run(t0);
      deleted = true;
    } catch {
      /* refused, as intended */
    }
    check("events: the table is append-only (UPDATE and DELETE of a recent row are refused)", !updated && !deleted && db.prepare("SELECT COUNT(*) AS n FROM events WHERE at >= ?").get(t0).n === rows.length);
    db.close();
  } catch (e) {
    check("events: could read the events table", false, `(${DB}: ${e.message})`);
  }

  // --- Every error body so far is the one envelope, and every code has a catalog entry.
  const errors = responses
    .map((r) => {
      try {
        return JSON.parse(r);
      } catch {
        return null;
      }
    })
    .filter((j) => j && typeof j === "object" && "error" in j);
  const badShape = errors.filter((j) => !(j.error && typeof j.error === "object" && typeof j.error.code === "string" && typeof j.error.message === "string" && j.error.message.length > 0));
  check(`errors: every API error body (${errors.length} seen) is { error: { code, message } }`, errors.length > 20 && badShape.length === 0, JSON.stringify(badShape.slice(0, 2)));
  const unknownCodes = [...new Set(errors.map((j) => j.error?.code).filter((c) => !Object.hasOwn(MESSAGES, c)))];
  check("errors: every code the server answered with has a catalog entry", unknownCodes.length === 0, unknownCodes.join(", "));
  check("errors: no error message carries a stack or a path", errors.every((j) => !/\bat \w+ \(|node_modules|[A-Z]:\\|\.tsx?:\d+/.test(j.error?.message ?? "")));
  check(`errors: the catalog has ${MESSAGE_CODES.length} entries`, MESSAGE_CODES.length >= 40);
}

main().catch((e) => {
  console.error("smoke crashed:", e.message);
  process.exit(2);
});
