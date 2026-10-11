// Analytics ordering and page context in a real headless Chrome, against the production build.
//   npm run build && node scripts/check-analytics-order.mjs
// Starts `next start` on a free loopback port with a synthetic preview configuration (G-TEST000000, never a real
// property) and a throwaway database, answers the gtag.js request with an empty stub, and reads window.dataLayer.
// Nothing can reach Google: Chrome resolves loopback only (scripts/lib/cdp.mjs) and the tag request is fulfilled
// locally. Checks, after consent:
//  1. SPA navigations /make -> /organizer, /make -> /wall, /make -> /studio/<demo>: the destination's page_view comes
//     first, and the route's mount event (organizer_step, wall_view, studio_open) follows it exactly once, stamped
//     with the destination's template.
//  2. A navigating click keeps the page it was clicked on (nav_select is stamped with the source page).
//  3. Back and forward each give one page_view; returning to the same URL is not double counted.
//  3b. Tear -> wall: router.push("/wall?pinned=<id>") then the wall's own history.replaceState("/wall") cleanup is
//     one /wall page_view (and one wall_view), whose location carries no pinned id; a later real return to the
//     wall is still counted.
//  4. Throughout the run, every event carries the route_template of the latest page_view before it, and no
//     seeded private value appears in the dataLayer.
//  5. A remembered "Allow" on a hard load of /studio/<demo>: page_view first, then studio_open, both stamped.
// Exits nonzero on any failure, a missing Chrome or a missing build.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchBrowser } from "./lib/cdp.mjs";

const root = new URL("..", import.meta.url).pathname;
if (!existsSync(join(root, ".next/BUILD_ID"))) {
  console.error("FAIL no production build: run `npm run build` first");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

const SEED = "SEEDTOKEN7f3a";
const DEMO = "demo-pale";
let failed = 0;
let passed = 0;
function check(name, ok, detail = "") {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` :: ${detail}`}`);
  return ok;
}

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const dataDir = mkdtempSync(join(tmpdir(), "ticketstub-analytics-order-"));
const server = spawn(process.execPath, [join(root, "node_modules/next/dist/bin/next"), "start", "-H", "127.0.0.1", "-p", String(port)], {
  cwd: root,
  env: {
    ...process.env,
    TICKETSTUB_OPS_TELEMETRY: "off",
    NODE_ENV: "production",
    TICKETSTUB_ANALYTICS_ENV: "preview",
    TICKETSTUB_GA_MEASUREMENT_ID: "G-TEST000000",
    TICKETSTUB_ANALYTICS_DISABLED: "",
    TICKETSTUB_GA_DEBUG: "",
    TICKETSTUB_RUNTIME_MODE: "demo",
    TICKETSTUB_DB: join(dataDir, "ticketstub.sqlite"),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
server.stdout.on("data", (d) => (log += d));
server.stderr.on("data", (d) => (log += d));
for (let i = 0; i < 150 && !/Ready|started server/i.test(log); i++) await sleep(200);

const browser = await launchBrowser();
try {
  const page = await browser.newPage({ width: 1280, height: 900 });
  const tagRequests = [];
  page.conn.on((m) => {
    if (m.sessionId !== page.sid || m.method !== "Fetch.requestPaused") return;
    tagRequests.push(m.params.request.url);
    page.send("Fetch.fulfillRequest", {
      requestId: m.params.requestId,
      responseCode: 200,
      responseHeaders: [{ name: "content-type", value: "text/javascript" }],
      body: Buffer.from("/* offline stub of gtag.js */").toString("base64"),
    });
  });
  await page.send("Fetch.enable", { patterns: [{ urlPattern: "*googletagmanager.com*" }, { urlPattern: "*google-analytics.com*" }] });

  const layer = async () => JSON.parse(await page.eval("JSON.stringify((window.dataLayer || []).map((a) => Array.from(a)))"));
  const events = async () => (await layer()).filter((a) => a[0] === "event").map((a) => ({ name: a[1], p: a[2] }));
  const clickLink = (href) =>
    page.eval(`(() => { const a = [...document.querySelectorAll("a")].find((a) => a.getAttribute("href") === ${JSON.stringify(href)}); if (!a) return false; a.click(); return true; })()`);
  const clickButton = (text) =>
    page.eval(`(() => { const b = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === ${JSON.stringify(text)}); if (!b) return false; b.click(); return true; })()`);
  const at = (path, ms = 15000) => page.waitFor(`location.pathname === ${JSON.stringify(path)}`, ms);
  const since = (all, from) => all.slice(from);

  // The demo stub, seeded the way a person does (no analytics yet: nothing is configured until consent).
  await page.goto(`${base}/new?demo=pale`, { settle: 300 });
  check(`demo stub seeded (/studio/${DEMO})`, await at(`/studio/${DEMO}`, 30000), await page.eval("location.pathname"));

  await page.goto(`${base}/make?from=${SEED}`, { settle: 1200 });
  check("no tag request before consent", tagRequests.length === 0, tagRequests.join(","));
  check("consent: Allow analytics", await clickButton("Allow analytics"));
  await sleep(800);
  check("exactly one tag request after consent", tagRequests.length === 1, tagRequests.join(","));

  /** Navigate from /make with `go`, then check the destination's page_view precedes its mount event. */
  async function spa(label, go, path, template, mountEvent) {
    if ((await page.eval("location.pathname")) !== "/make") {
      check(`${label}: back on /make`, await clickLink("/make") && (await at("/make")));
      await sleep(800);
    }
    const from = (await events()).length;
    check(`${label}: navigation started`, await go());
    check(`${label}: arrived at ${path}`, await at(path));
    await sleep(1500);
    const ev = since(await events(), from);
    const viewAt = ev.findIndex((e) => e.name === "page_view" && e.p.route_template === template);
    const mounts = ev.filter((e) => e.name === mountEvent);
    const mountAt = ev.findIndex((e) => e.name === mountEvent);
    const order = ev.map((e) => `${e.name}@${e.p.route_template}`).join(", ");
    check(`${label}: one page_view for ${template}`, ev.filter((e) => e.name === "page_view").length === 1 && viewAt >= 0, order);
    check(`${label}: ${mountEvent} exactly once`, mounts.length === 1, order);
    check(`${label}: page_view before ${mountEvent}`, viewAt >= 0 && mountAt > viewAt, order);
    check(`${label}: ${mountEvent} stamped ${template}`, mounts.every((e) => e.p.route_template === template && e.p.page_location === `${base}${template}`), order);
    return ev;
  }

  const toOrganizer = await spa("/make -> /organizer", () => clickLink("/organizer"), "/organizer", "/organizer", "organizer_step");
  const click = toOrganizer.filter((e) => e.name === "nav_select");
  check("navigating click keeps its source page (nav_select stamped /make)", click.length > 0 && click.every((e) => e.p.route_template === "/make"), JSON.stringify(click.map((e) => e.p.route_template)));

  await spa("/make -> /wall", () => clickLink("/wall"), "/wall", "/wall", "wall_view");
  await spa(
    "/make -> /studio",
    () => page.eval(`(() => { if (!window.next?.router?.push) return false; window.next.router.push("/studio/${DEMO}"); return true; })()`),
    `/studio/${DEMO}`,
    "/studio/:id",
    "studio_open",
  );

  // Back and forward: one page_view each, the same URL twice in a row is not counted again.
  let from = (await events()).length;
  await page.eval("history.back()");
  check("back: arrived at /make", await at("/make"));
  await sleep(1200);
  await page.eval("history.forward()");
  check(`forward: arrived at /studio/${DEMO}`, await at(`/studio/${DEMO}`));
  await sleep(1500);
  const views = since(await events(), from).filter((e) => e.name === "page_view").map((e) => e.p.route_template);
  check("back and forward: one page_view each", JSON.stringify(views) === JSON.stringify(["/make", "/studio/:id"]), JSON.stringify(views));

  // Tear -> wall, as TearFlow does it: push /wall?pinned=<id>; WallClient then replaces the address with /wall.
  from = (await events()).length;
  check(
    "tear -> wall: push /wall?pinned=<id>",
    await page.eval(`(() => { if (!window.next?.router?.push) return false; window.next.router.push("/wall?pinned=${DEMO}"); return true; })()`),
  );
  check("tear -> wall: arrived at /wall", await at("/wall"));
  check("tear -> wall: the wall cleaned ?pinned from the address", await page.waitFor(`location.pathname === "/wall" && location.search === ""`, 15000), await page.eval("location.search"));
  await sleep(1500);
  const tear = since(await events(), from);
  const tearOrder = tear.map((e) => `${e.name}@${e.p.route_template}`).join(", ");
  const tearViews = tear.filter((e) => e.name === "page_view");
  check("tear -> wall: push + replace cleanup is one /wall page_view", tearViews.length === 1 && tearViews[0].p.route_template === "/wall", tearOrder);
  check("tear -> wall: wall_view exactly once, after it", tear.filter((e) => e.name === "wall_view").length === 1 && tear.findIndex((e) => e.name === "wall_view") > tear.findIndex((e) => e.name === "page_view"), tearOrder);
  check("tear -> wall: page_location is the template, no pinned id", tearViews[0]?.p.page_location === `${base}/wall`, tearViews[0]?.p.page_location);
  check("tear -> wall: the pinned stub id is in no event", !JSON.stringify(tear).includes("pinned") && !JSON.stringify(tear).includes(DEMO), tearOrder);
  // A real visit away and back is still a view: only the transient ?pinned is ignored.
  from = (await events()).length;
  await page.eval("history.back()");
  check(`tear -> wall: back to /studio/${DEMO}`, await at(`/studio/${DEMO}`));
  await sleep(1200);
  await page.eval("history.forward()");
  check("tear -> wall: forward to /wall", await at("/wall"));
  await sleep(1500);
  const again = since(await events(), from).filter((e) => e.name === "page_view").map((e) => e.p.route_template);
  check("tear -> wall: back and forward after the cleanup count one page_view each", JSON.stringify(again) === JSON.stringify(["/studio/:id", "/wall"]), JSON.stringify(again));

  // The run as a whole: every event belongs to the latest page_view before it.
  const all = await events();
  let current = null;
  const wrong = [];
  for (const e of all) {
    if (e.name === "page_view") current = e.p.route_template;
    else if (e.p.route_template !== current) wrong.push(`${e.name}@${e.p.route_template} (page ${current})`);
  }
  check("every event carries the template of the latest page_view before it", wrong.length === 0, wrong.join("; "));
  check("no seeded private value in the dataLayer", !JSON.stringify(await layer()).includes(SEED));

  // A remembered "Allow" on a hard load.
  await page.goto(`${base}/studio/${DEMO}?from=${SEED}`, { settle: 2500 });
  const hard = await events();
  const order = hard.map((e) => `${e.name}@${e.p.route_template}`).join(", ");
  check("remembered grant: page_view first", hard[0]?.name === "page_view" && hard[0].p.route_template === "/studio/:id", order);
  check("remembered grant: studio_open once, after it, stamped /studio/:id", hard.filter((e) => e.name === "studio_open").length === 1 && hard.findIndex((e) => e.name === "studio_open") > 0 && hard.every((e) => e.p.route_template === "/studio/:id"), order);
  check("no page errors", page.consoleErrors.length === 0, page.consoleErrors.join(" | "));
} catch (e) {
  check("run", false, e.stack);
} finally {
  await browser.close();
  server.kill();
  rmSync(dataDir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
