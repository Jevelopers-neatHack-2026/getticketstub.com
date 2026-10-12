// PR100-ASTRA-001 regression, against a REAL local account server: a generation that is pending (or ready) when its project is
// taken down in another tab must never bring the project back, even after the real account sync has acknowledged the deletion and
// emptied the outbound deletion queue.
//   node scripts/check-generation-account-delete.mjs <evidence-dir>
// Starts its own loopback-only `next start` (needs a build) with a throwaway database and sandbox sign-in, provider/mail keys
// stripped and the fixture network guard preloaded. /api/art is a deferred fake IN THE PAGE; no provider, host or credential is used.
// Also keeps the positive path honest: file persist/resume, an approval that stays valid while generation is pending and is
// refused stale (403) after the generated art syncs, and a fresh approval that verifies.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launchBrowser } from "./lib/cdp.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const evidenceDir = resolve(process.argv[2] ?? "/tmp/gen-account-delete-evidence");
mkdirSync(evidenceDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  checks.push({ name, ok, ...(ok ? {} : { detail }) });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` ${JSON.stringify(detail)}`}`);
  if (ok) passed++;
  else failed++;
}

const tmp = mkdtempSync(join(tmpdir(), "gen-account-delete-"));
const netLog = join(tmp, "net.log");
writeFileSync(netLog, "");
const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => ok(port)); }); });
const env = { ...process.env };
for (const k of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "TICKETMASTER_API_KEY", "RESEND_API_KEY", "TICKETSTUB_RUNTIME_MODE", "APP_URL"]) delete env[k];
const port = await freePort();
const child = spawn(process.execPath, [join(root, "node_modules/next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", String(port)], {
  cwd: root,
  env: { ...env, PORT: String(port), NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1", NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${join(root, "scripts/lib/fixture-network-guard.mjs")}`.trim(), VERIFY_NET_LOG: netLog, TICKETSTUB_DB: join(tmp, "v.sqlite"), TICKETSTUB_FILES: join(tmp, "files"), TICKETSTUB_SANDBOX_MAIL: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
child.stdout.on("data", (d) => (log += d));
child.stderr.on("data", (d) => (log += d));
const base = `http://127.0.0.1:${port}`;
console.log(`own server pid ${child.pid} on ${base}`);

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8Dwn4GBgYGJAQoAHhgCAh6X4CYAAAAASUVORK5CYII=";
const HOOK = `(() => {
  const real = window.fetch.bind(window);
  window.__art = []; window.__sync = [];
  window.fetch = async (u, i) => {
    if (String(u).includes("/api/art")) return new Promise((resolve) => window.__art.push(() => resolve(new Response(JSON.stringify({ kind: "image", src: ${JSON.stringify(PNG)}, seed: 77, provenance: "simulated" }), { status: 200, headers: { "content-type": "application/json" } }))));
    const r = await real(u, i);
    if (String(u).includes("/api/wall/sync")) window.__sync.push({ status: r.status, body: i && i.body, at: Date.now() });
    return r;
  };
})()`;

const mkStub = (id) => ({ id, createdAt: new Date().toISOString(), updatedAt: Date.now(), event: { type: "concert", title: "Account delete race", venue: "Fixture Hall", dateISO: "2026-11-01", facts: [{ id: "venue", label: "Venue", value: "Fixture Hall", source: "fixture", confidence: 0.95, provenance: "simulated", kept: true }] }, versions: [{ id: "v0", edition: "researched", art: { kind: "procedural", seed: 1, provenance: "simulated" }, createdAt: new Date().toISOString() }], currentVersionId: "v0", personal: { titleFont: 0, titleColor: "", foilTitle: false, hiddenFields: [], friends: [] }, material: "card", finish: "matte", torn: false, wallAngle: 0, photos: [] });

let browser;
let exitCode = 1;
try {
  for (let i = 0; i < 60; i++) {
    if (child.exitCode !== null) throw new Error(`server exited early: ${log.slice(0, 400)}`);
    try { if ((await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2000) })).ok) break; } catch { /* not up yet */ }
    await sleep(500);
  }
  browser = await launchBrowser();
  const page = await browser.newPage({ width: 1280, height: 900 });
  await page.send("Page.addScriptToEvaluateOnNewDocument", { source: HOOK });
  await page.goto(`${base}/wall`);
  const api = (method, path, body) => page.eval(`(async()=>{const r=await fetch(${JSON.stringify(path)},{method:${JSON.stringify(method)},headers:{'content-type':'application/json'},${body === undefined ? "" : `body:JSON.stringify(${JSON.stringify(body)}),`}});const t=await r.text();let b;try{b=JSON.parse(t)}catch{b=null}return {status:r.status,body:b};})()`);
  const click = (p, t, starts = false) => p.eval(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.offsetParent!==null&&!b.disabled&&${starts ? `(b.getAttribute('aria-label')||b.textContent).trim().startsWith(${JSON.stringify(t)})` : `b.textContent.trim()===${JSON.stringify(t)}`});if(!b)return false;b.click();return true;})()`);
  const noteMoodier = async (p) => { for (let i = 0; i < 10; i++) { if (await click(p, "Make it moodier")) return true; if (!(await click(p, "Next note", true))) await click(p, "Dismiss this note", true); await sleep(250); } return false; };
  const email = `acct-del-${Date.now()}@example.com`;
  const link = await api("POST", "/api/auth/link", { email, reason: "save", returnTo: "/wall" });
  if (!link.body?.devLink) throw new Error("no sandbox auth link");
  check("sandbox account authenticated (local fixture, no real mail)", (await api("POST", "/api/auth/confirm", { token: new URL(link.body.devLink).searchParams.get("token") })).status === 200);
  const localHas = (p, id) => p.eval(`JSON.parse(localStorage.getItem('ticketstub.wall.v1')||'[]').some(s=>s.id===${JSON.stringify(id)})`);
  const localStub = (p, id) => p.eval(`JSON.parse(localStorage.getItem('ticketstub.wall.v1')||'[]').find(s=>s.id===${JSON.stringify(id)})||null`);
  const queue = (p) => p.eval(`JSON.parse(localStorage.getItem('ticketstub.wall.deleted.v1')||'[]')`);
  const remoteHas = async (id) => (await api("POST", "/api/wall/sync", { stubs: [], deleted: [] })).body.stubs.some((s) => s.id === id);
  const upsertsFor = (p, id, sinceIdx) => p.eval(`window.__sync.slice(${sinceIdx}).filter(x=>x.status===200&&JSON.parse(x.body||'{}').stubs?.some(s=>s.id===${JSON.stringify(id)})).length`);

  async function openStudio(id) {
    await page.eval(`localStorage.clear();localStorage.setItem('ticketstub.wall.v1',${JSON.stringify(JSON.stringify([mkStub(id)]))});localStorage.setItem('ticketstub.hint.swipe.v1','1')`);
    await page.goto(`${base}/studio/${id}`, { settle: 2000 });
    await page.waitFor(`window.__sync.some(x=>x.status===200&&x.body.includes(${JSON.stringify(id)}))`, 12000);
  }
  async function takeItDownElsewhere(id) {
    const other = await browser.newPage({ width: 1280, height: 900 });
    await other.goto(`${base}/wall`, { settle: 1800 });
    check("real wall UI lifts the project in the other tab", await other.eval(`(()=>{const b=document.querySelector('[data-stub-id="${id}"]');if(!b)return false;b.click();return true;})()`));
    await sleep(500);
    for (const label of ["Take it down", "Tap again to take it down"]) { check(`other tab: ${label}`, await other.eval(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)});if(!b)return false;b.click();return true;})()`)); await sleep(350); }
    const acked = await other.waitFor(`!JSON.parse(localStorage.getItem('ticketstub.wall.v1')||'[]').some(s=>s.id===${JSON.stringify(id)})&&!JSON.parse(localStorage.getItem('ticketstub.wall.deleted.v1')||'[]').includes(${JSON.stringify(id)})`, 12000);
    check("real account sync acknowledged the deletion and emptied the outbound queue", acked);
    check("API wall confirms the project is absent", !(await remoteHas(id)));
    await other.close();
  }

  // ---- 1. positive path: approval, generation, sync, file persistence ----
  const pid = `acct-pos-${Date.now()}`;
  await openStudio(pid);
  const first = await api("POST", "/api/approvals", { stubId: pid, purpose: "print.compose", expectedVersionId: "v0" });
  check("approval for the saved selected version", first.status === 200, first.status);
  const ap = first.body.approval;
  const full = (b) => Object.fromEntries(["designHash", "artHash", "factsHash", "compositionHash"].map((k) => [k, b[k]]));
  const verify = (token, a) => api("POST", "/api/approvals/verify", { token, expect: { tenant: a.tenant.id, project: `stub:${pid}`, purpose: "print.compose", content: full(a.binding) } });
  check("note starts one editor-owned request", (await noteMoodier(page)) && (await page.waitFor("window.__art.length===1", 5000)));
  check("old approval stays valid while generation is pending", (await verify(first.body.token, ap)).body.ok === true);
  await page.eval("window.__art[0]()");
  await page.waitFor(`JSON.parse(localStorage.getItem('ticketstub.wall.v1')||'[]').find(s=>s.id===${JSON.stringify(pid)})?.versions.length===2`, 6000);
  const cur = await localStub(page, pid);
  await page.waitFor(`window.__sync.some(x=>x.status===200&&x.body.includes(${JSON.stringify(cur.currentVersionId)}))`, 12000);
  const old = await verify(first.body.token, ap);
  check("old approval is refused stale (403) after the generated art syncs", old.status === 403 && old.body.reason === "stale", { status: old.status, reason: old.body?.reason });
  const fresh = await api("POST", "/api/approvals", { stubId: pid, purpose: "print.compose", expectedVersionId: cur.currentVersionId });
  check("fresh approval for the generated version verifies", fresh.status === 200 && (await verify(fresh.body.token, fresh.body.approval)).body.ok === true);
  await page.goto(`${base}/wall`);
  await page.eval("localStorage.removeItem('ticketstub.wall.v1')");
  await page.goto(`${base}/wall`, { settle: 2000 });
  await page.waitFor(`JSON.parse(localStorage.getItem('ticketstub.wall.v1')||'[]').some(s=>s.id===${JSON.stringify(pid)})`, 12000);
  const back = await localStub(page, pid);
  check("an empty browser cache recovers both versions with server-owned image bytes", back?.versions.length === 2 && back.versions[1].art.src.startsWith("/api/files/"), back?.versions?.length);

  // ---- 2. deletion acknowledged while a note request is PENDING ----
  const did = `acct-del-${Date.now()}`;
  await openStudio(did);
  check("pending note request started", (await noteMoodier(page)) && (await page.waitFor("window.__art.length===1", 5000)));
  await takeItDownElsewhere(did);
  const idx = await page.eval("window.__sync.length");
  check("the editor retired the pending request when it saw the removal", await page.waitFor(`document.querySelector('[aria-label="Art generation status"]')?.getAttribute('data-phase')==='discarded'`, 6000));
  await page.eval("window.__art[0]()");
  await sleep(3500);
  check("late completion does not resurrect the project locally", !(await localHas(page, did)), await localStub(page, did));
  check("no deletion tombstone was re-queued and no resurrected draft exists", (await queue(page)).length === 0);
  check("zero upsert dispatches for the deleted project after the response", (await upsertsFor(page, did, idx)) === 0, await upsertsFor(page, did, idx));
  check("API wall still has no such project", !(await remoteHas(did)));
  check("status says nothing was applied and makes no provider claim", await page.eval(`(()=>{const t=document.querySelector('[aria-label="Art generation status"]')?.textContent||'';return /nothing was applied/.test(t)&&!/provider (cancel|stopp)|%/i.test(t)})()`));
  await page.screenshot(join(evidenceDir, "pending-deleted-acked.png"));

  // ---- 3. deletion acknowledged while the result is READY (selection moved) ----
  const rid = `acct-rdy-${Date.now()}`;
  await openStudio(rid);
  check("note request started for the ready case", (await noteMoodier(page)) && (await page.waitFor("window.__art.length===1", 5000)));
  await page.key("ArrowRight");
  await sleep(600);
  await page.eval("window.__art[0]()");
  check("result is held as ready with an explicit Apply", await page.waitFor(`/New art ready/.test(document.querySelector('[aria-label="Art generation status"]')?.textContent||'')`, 6000));
  await takeItDownElsewhere(rid);
  const idx2 = await page.eval("window.__sync.length");
  check("the ready candidate was retired when the removal was seen: Apply is gone", await page.waitFor(`!([...document.querySelectorAll('button')].some(b=>/Apply as new version/.test(b.textContent)))&&document.querySelector('[aria-label="Art generation status"]')?.getAttribute('data-phase')==='discarded'`, 6000));
  await sleep(2500);
  check("ready case: no local resurrection", !(await localHas(page, rid)));
  check("ready case: zero upsert dispatches for the deleted project", (await upsertsFor(page, rid, idx2)) === 0);
  check("ready case: API wall has no such project", !(await remoteHas(rid)));
  await page.screenshot(join(evidenceDir, "ready-deleted-acked.png"));
  // ---- 4. native paused editor: a peer deletes and restores the same id while this editor cannot run (PR100-ASTRA-003) ----
  const qid = `acct-q-${Date.now()}`;
  await openStudio(qid);
  await page.eval(`(()=>{const w=JSON.parse(localStorage.getItem('ticketstub.wall.v1'));const keep=${JSON.stringify({ ...mkStub("keep-other"), event: { type: "concert", title: "Unrelated project", facts: [] } })};localStorage.setItem('ticketstub.wall.v1',JSON.stringify([...w,keep]))})()`);
  check("queued case: note request pending", (await noteMoodier(page)) && (await page.waitFor("window.__art.length===1", 5000)));
  await page.eval(`window.__storageEvents=[];window.addEventListener('storage',e=>{if(e.key==='ticketstub.wall.v1')window.__storageEvents.push({next:e.newValue})})`);
  const peer = await browser.newPage({ width: 1280, height: 900 });
  await peer.goto(`${base}/wall`, { settle: 1800 });
  await page.send("Debugger.enable");
  let reached;
  const paused = new Promise((r) => (reached = r));
  const off = browser.conn.on((m) => { if (m.sessionId === page.sid && m.method === "Debugger.paused") reached(true); });
  const pausedEval = page.eval("debugger; true");
  if (!(await Promise.race([paused, sleep(5000).then(() => false)]))) throw new Error("harness could not confirm the editor was paused");
  off();
  const peerMutation = peer.eval(`(()=>{const wall=JSON.parse(localStorage.getItem('ticketstub.wall.v1'));const src=wall.find(s=>s.id===${JSON.stringify(qid)});const next={...src,event:{...src.event,title:'Restored independent draft'},versions:[{...src.versions[0],id:'restored-v0'}],currentVersionId:'restored-v0',updatedAt:Date.now()};const rest=wall.filter(s=>s.id!==src.id);localStorage.setItem('ticketstub.wall.v1',JSON.stringify(rest));localStorage.setItem('ticketstub.wall.v1',JSON.stringify([next,...rest]));return true})()`);
  const finishedWhilePaused = await Promise.race([peerMutation.then(() => true), sleep(8000).then(() => false)]);
  await page.send("Debugger.resume");
  await pausedEval;
  await peerMutation;
  check("queued case: the peer deleted and restored while the editor was paused", finishedWhilePaused);
  check("queued case: native storage events delivered, one with this project absent in its payload", (await page.waitFor("window.__storageEvents.length>=2", 5000)) && (await page.eval(`window.__storageEvents.some(e=>!JSON.parse(e.next||'[]').some(s=>s.id===${JSON.stringify(qid)}))`)));
  const restored = await localStub(page, qid);
  check("queued case: the independent restored draft is intact before the late response", restored?.event.title === "Restored independent draft" && restored.currentVersionId === "restored-v0");
  await page.eval("window.__art[0]()");
  await sleep(2500);
  const after = await localStub(page, qid);
  check("queued case: the late old generation does not overwrite the restored draft", after?.event.title === "Restored independent draft" && after.versions.length === 1 && after.currentVersionId === "restored-v0", { title: after?.event.title, versions: after?.versions.length });
  check("queued case: the unrelated project is preserved", (await localStub(page, "keep-other"))?.event.title === "Unrelated project");
  await page.screenshot(join(evidenceDir, "queued-delete-restore.png"));
  await peer.close();

  // ---- 5. unreadable storage (reads throw, writes would work): hold, never write, never call it deleted ----
  const uid = `acct-u-${Date.now()}`;
  await openStudio(uid);
  await page.eval(`(()=>{const w=JSON.parse(localStorage.getItem('ticketstub.wall.v1'));localStorage.setItem('ticketstub.wall.v1',JSON.stringify([...w,${JSON.stringify({ ...mkStub("keep-two"), event: { type: "concert", title: "Second unrelated", facts: [] } })}]))})()`);
  check("unreadable case: note request pending", (await noteMoodier(page)) && (await page.waitFor("window.__art.length===1", 5000)));
  await page.eval(`(()=>{window.__wallWrites=0;const g=Storage.prototype.getItem,st=Storage.prototype.setItem;window.__unreadable=true;Storage.prototype.getItem=function(k){if(window.__unreadable&&k==='ticketstub.wall.v1')throw new DOMException('unreadable','SecurityError');return g.call(this,k)};Storage.prototype.setItem=function(k,v){if(k==='ticketstub.wall.v1')window.__wallWrites++;return st.call(this,k,v)};window.__restoreStorage=()=>{window.__unreadable=false}})()`);
  await page.eval("window.__art[0]()");
  check("unreadable case: result held as ready, not called deleted", await page.waitFor(`/can't be read/.test(document.querySelector('[aria-label="Art generation status"]')?.textContent||'')&&document.querySelector('[aria-label="Art generation status"]')?.getAttribute('data-phase')==='ready'`, 6000));
  check("unreadable case: not one wall write was attempted", (await page.eval("window.__wallWrites")) === 0);
  check("unreadable case: explicit Apply is in-editor only and says NOT saved", (await click(page, "Apply as new version")) && (await page.waitFor(`/NOT saved/.test(document.querySelector('[aria-label="Art generation status"]')?.textContent||'')`, 6000)));
  check("unreadable case: still no wall write", (await page.eval("window.__wallWrites")) === 0);
  await page.eval("window.__restoreStorage()");
  check("unreadable case: no project was erased once readable again", (await localStub(page, "keep-two"))?.event.title === "Second unrelated" && (await localStub(page, uid))?.versions.length === 1);

  // ---- 6. a valid project whose write fails keeps the draft and warns it is unsaved ----
  const wid = `acct-w-${Date.now()}`;
  await openStudio(wid);
  check("write-failure case: note request pending", (await noteMoodier(page)) && (await page.waitFor("window.__art.length===1", 5000)));
  await page.eval(`(()=>{const st=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k==='ticketstub.wall.v1')throw new DOMException('full','QuotaExceededError');return st.call(this,k,v)}})()`);
  await page.eval("window.__art[0]()");
  check("write-failure case: applied once with the unsaved warning", await page.waitFor(`document.querySelector('[aria-label="Art generation status"]')?.getAttribute('data-phase')==='applied'&&/could not be saved/.test(document.querySelector('[aria-label="Art generation status"]').textContent)`, 6000));
  check("write-failure case: the stored project is untouched", (await localStub(page, wid))?.versions.length === 1);

  check("fixture network guard: no outbound attempt", readFileSync(netLog, "utf8").split("\n").filter(Boolean).length === 0, readFileSync(netLog, "utf8"));
  exitCode = failed ? 1 : 0;
} catch (e) {
  check("script ran to completion", false, String(e?.stack ?? e));
} finally {
  if (browser) await browser.close();
  child.kill();
  await new Promise((r) => (child.exitCode !== null ? r() : child.once("close", r)));
  rmSync(tmp, { recursive: true, force: true });
  writeFileSync(join(evidenceDir, "check-generation-account-delete.json"), JSON.stringify({ passed, failed, checks }, null, 2));
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(exitCode);
}
