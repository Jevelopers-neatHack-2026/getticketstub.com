// Pay asks a signed-out person to sign in first, right where they are, with "Continue as guest" as the way on.
//   node scripts/check-pay-signin.mjs <base-url> [evidence-dir]
// Run through `npm run verify:product -- --suite pay-signin --mode fixture --evidence-dir <dir>` (sandbox mail on).
// In a real headless Chrome, on the cart and on /checkout/[id]:
//  1. signed out, Pay opens the sheet and places nothing; "Continue as guest" then places the order
//  2. signed out, send the link, open it (same tab), confirm: back on ?resume=pay with the cart intact, "Signed in as", no order
//     placed until Pay is tapped, and then it is the account's
//  3. the link opened in another tab of the same browser: the first tab notices and closes the sheet
//  4. signed in, Pay places the order directly, no sheet
//  5. returnTo is a relative path only: absolute, protocol-relative and backslash forms never leave the site
//  6. a pending guest choice uses the current quote clock, checkout gate and cross-tab cart contents; invalid choices place nothing
// Set PAY_SIGNIN_SHOTS to a folder to also write screenshots at 390 and 1440 px.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { launchBrowser } from "./lib/cdp.mjs";

const base = (process.argv[2] ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const evidenceDir = process.argv[3] ? resolve(process.argv[3]) : null;
const shots = process.env.PAY_SIGNIN_SHOTS ? resolve(process.env.PAY_SIGNIN_SHOTS) : null;
if (shots) mkdirSync(shots, { recursive: true });

let failed = 0;
let passed = 0;
const evidence = { base, checks: [] };
function check(name, ok, detail = "") {
  if (ok) passed++;
  else failed++;
  evidence.checks.push({ name, ok, ...(ok ? {} : { detail }) });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` ${detail}`}`);
  return ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DEMO = "demo-pale";
const EMAIL = "pay-signin@example.com";
const browser = await launchBrowser();
try {
  const page = await browser.newPage({ width: 390, height: 844 });

  // every order the browser sends, across navigations
  let orderPosts = 0;
  browser.conn.on((m) => {
    if (m.method === "Network.requestWillBeSent" && m.params.request.method === "POST" && new URL(m.params.request.url).pathname === "/api/orders") orderPosts++;
  });

  const clickText = (sel, text, p = page) => p.eval(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(sel)})].find((e) => e.textContent.trim().startsWith(${JSON.stringify(text)})); if (!b) return false; b.click(); return true; })()`);
  const has = (text, p = page) => p.eval(`document.body.innerText.includes(${JSON.stringify(text)})`);
  const sheetOpen = (p = page) => p.eval(`!!document.querySelector('[role="dialog"][aria-modal="true"]')`);
  const sheetText = (p = page) => p.eval(`document.querySelector('[role="dialog"]')?.innerText ?? ""`);
  const cartCount = (p = page) => p.eval(`(JSON.parse(localStorage.getItem("ticketstub.cart.v1") || "[]")).length`);
  const localOrders = () => page.eval(`JSON.parse(localStorage.getItem("ticketstub.orders.v1") || "[]").length`);
  const me = (p = page) => p.eval(`fetch("/api/auth/me").then((r) => r.json()).then((j) => j.account?.email ?? null)`);
  const shot = async (name, width, height) => {
    if (!shots) return;
    await page.resize(width, height, 1, width < 700);
    await sleep(350);
    await page.screenshot(join(shots, `${name}-${width}.png`));
    await page.resize(390, 844, 1, true);
  };

  const signOut = async () => {
    await page.eval(`fetch("/api/auth/signout", { method: "POST" }).then((r) => r.status)`);
  };
  const stock = async () => {
    // the cart is local: one stub, put in the way a person does it
    await page.goto(`${base}/checkout/${DEMO}`, { settle: 900 });
    await page.waitFor(`[...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Add to cart")`);
    await clickText("button", "Add to cart");
    await page.waitFor(`JSON.parse(localStorage.getItem("ticketstub.cart.v1") || "[]").length === 1`, 5000);
  };
  const typeEmail = async (id, value) => {
    await page.eval(`document.getElementById(${JSON.stringify(id)}).focus()`);
    await page.type(value);
  };
  const ordered = async (before) => page.waitFor(`true`, 1).then(async () => {
    const end = Date.now() + 8000;
    while (Date.now() < end) {
      if (orderPosts > before) return true;
      await sleep(100);
    }
    return false;
  });
  /** Sheet: type the address, send the link, return the sandbox href. */
  const sendLink = async () => {
    await page.waitFor(`document.getElementById("signin-email")`);
    const prefilled = await page.eval(`document.getElementById("signin-email").value`);
    if (!prefilled) {
      await page.eval(`document.getElementById("signin-email").focus()`);
      await page.type(EMAIL);
    }
    await clickText('[role="dialog"] button', "Email me a link");
    const got = await page.waitFor(`[...document.querySelectorAll('[role="dialog"] a')].some((a) => a.textContent.includes("Open the link"))`, 10000);
    return { prefilled, href: got ? await page.eval(`[...document.querySelectorAll('[role="dialog"] a')].find((a) => a.textContent.includes("Open the link")).href`) : null };
  };
  const confirmLink = async (p, href) => {
    await p.goto(href, { settle: 700 });
    await p.waitFor(`document.querySelector('form[action="/api/auth/confirm"] button')`);
    await p.eval(`document.querySelector('form[action="/api/auth/confirm"] button').click()`);
  };

  // ---- the demo stub, as a person makes it ----
  await page.goto(`${base}/new?demo=pale`, { settle: 300 });
  check(`the demo stub is on the desk`, await page.waitFor(`location.pathname === "/studio/${DEMO}"`, 30000), await page.eval("location.pathname"));

  const SCREENS = [
    { name: "cart", url: "/cart", seed: stock, ready: `[...document.querySelectorAll("button")].some((b) => b.textContent.trim().startsWith("Pay"))`, emailId: "cart-email", intact: async () => (await cartCount()) === 1 },
    { name: "checkout", url: `/checkout/${DEMO}`, seed: async () => {}, ready: `[...document.querySelectorAll("button")].some((b) => b.textContent.trim().startsWith("Pay"))`, emailId: "co-email", intact: async () => await has("Checkout") },
  ];

  for (const sc of SCREENS) {
    const T = (s) => `${sc.name}: ${s}`;
    const openScreen = async (url = sc.url) => {
      await page.goto(base + url, { settle: 700 });
      // the account is asked once; Pay waits for the answer so a signed-in person is never asked
      await page.waitFor(sc.ready, 10000);
      await sleep(600);
    };
    const pay = () => clickText("button", "Pay");

    // ---- 1. signed out: the sheet, then Continue as guest ----
    await signOut();
    await sc.seed();
    await openScreen();
    let before = orderPosts;
    await pay();
    check(T("signed out, Pay opens the sign-in sheet and places no order"), (await page.waitFor(`document.querySelector('[role="dialog"]')`)) && orderPosts === before, `${orderPosts - before} orders`);
    const sheet = await sheetText();
    check(T("the sheet says why, in its own words"), sheet.includes("Sign in to keep your order and receipt with your wall") && sheet.includes("it takes a few seconds"), sheet);
    check(T("primary is the link, with Continue as guest as the small way on"), /Email me a link/.test(sheet) && /Continue as guest/.test(sheet), sheet);
    check(T("focus moves into the sheet (the email field)"), await page.eval(`document.activeElement?.id === "signin-email"`));
    await shot(`${sc.name}-sheet`, 390, 844);
    await shot(`${sc.name}-sheet`, 1440, 900);
    await clickText('[role="dialog"] button', "Continue as guest");
    check(T("Continue as guest closes the sheet and places the order"), (await ordered(before)) && !(await sheetOpen()));
    check(T("a guest order is not an account: still signed out"), (await me()) === null);

    // ---- 1b. a typed receipt email is carried into the sheet ----
    await sc.seed();
    await openScreen();
    await typeEmail(sc.emailId, EMAIL);
    before = orderPosts;
    await pay();
    await page.waitFor(`document.getElementById("signin-email")`);
    check(T("the receipt email typed on the page is prefilled in the sheet"), (await page.eval(`document.getElementById("signin-email").value`)) === EMAIL);
    check(T("still no order placed while the sheet is open"), orderPosts === before);
    await page.key("Escape");
    check(T("Escape closes the sheet and places nothing"), (await page.waitFor(`!document.querySelector('[role="dialog"]')`)) && orderPosts === before);

    // ---- 2. send the link, confirm in the same tab, land back on the pay step ----
    await sc.seed();
    await openScreen();
    await pay();
    const link = await sendLink();
    check(T("the link is sent (sandbox mail shows its own button)"), !!link.href && link.href.includes("/signin/confirm?token="), String(link.href));
    check(T("the sent state still offers Continue as guest"), (await sheetText()).includes("Continue as guest"));
    await shot(`${sc.name}-sent`, 390, 844);
    before = orderPosts;
    await confirmLink(page, link.href);
    const back = new URL(await (async () => (await page.waitFor(`location.pathname === ${JSON.stringify(sc.url)}`, 10000), page.eval("location.href")))());
    check(T(`the link lands on ${sc.url} with the resume marker`), back.pathname === sc.url && back.searchParams.get("resume") === "pay", back.href);
    await page.waitFor(`document.body.innerText.includes("Signed in as")`, 8000);
    check(T("it says who they are and to tap Pay"), (await has(`Signed in as`)) && (await has(`${EMAIL}`)) && (await has("Tap Pay to finish")));
    check(T("the cart survived the round trip"), await sc.intact());
    check(T("nothing was charged or placed by coming back"), orderPosts === before, `${orderPosts - before} orders`);
    check(T("the sheet is closed on arrival"), !(await sheetOpen()));
    await shot(`${sc.name}-resumed`, 390, 844);
    await shot(`${sc.name}-resumed`, 1440, 900);
    await pay();
    check(T("Pay then places the order, as the account, with no sheet"), (await ordered(before)) && !(await sheetOpen()) && (await me()) === EMAIL);
    await page.waitFor(`document.body.innerText.includes("Ordered")`, 5000);

    // ---- 4. signed in: Pay goes straight through ----
    await sc.seed();
    await openScreen(sc.url);
    before = orderPosts;
    await pay();
    check(T("signed in, Pay places the order directly (no sheet)"), (await ordered(before)) && !(await sheetOpen()));

    // ---- 3. the link opened in another tab of the same browser ----
    await signOut();
    await sc.seed();
    await openScreen();
    await pay();
    const link2 = await sendLink();
    const other = await browser.newPage({ width: 390, height: 844 });
    await confirmLink(other, link2.href);
    await other.waitFor(`location.pathname === ${JSON.stringify(sc.url)}`, 10000);
    await other.close();
    await page.send("Page.bringToFront");
    check(T("another tab confirmed the link: this tab's sheet closes by itself"), await page.waitFor(`!document.querySelector('[role="dialog"]')`, 10000));
    check(T("and this tab says who they are, ready to Pay"), await page.waitFor(`document.body.innerText.includes("Signed in as") && document.body.innerText.includes("Tap Pay to finish")`, 4000));
    before = orderPosts;
    await pay();
    check(T("Pay in the first tab places the order as the account"), (await ordered(before)) && (await me()) === EMAIL);
    await signOut();
  }

  // ---- 6. the guest callback held by an open sheet must validate the current page, not its opening render ----
  const openPendingGuest = async (name, url, emailId) => {
    await page.goto(base + url, { settle: 300 });
    if (!(await page.waitFor(`document.getElementById(${JSON.stringify(emailId)})`, 10000))) throw new Error(`${name}: receipt field did not load`);
    await typeEmail(emailId, EMAIL);
    const before = { posts: orderPosts, localOrders: await localOrders() };
    await clickText("button", "Pay");
    check(`${name}: a valid quote opens the sheet without ordering`, (await page.waitFor(`document.querySelector('[role="dialog"]')`)) && orderPosts === before.posts && (await localOrders()) === before.localOrders);
    return before;
  };
  const noGuestOrder = async (name, before) => {
    await sleep(600);
    const after = { posts: orderPosts, localOrders: await localOrders(), sheetOpen: await sheetOpen() };
    const rec = { name, before, after };
    (evidence.pendingGuest ??= []).push(rec);
    check(`${name}: guest continuation places no POST or local order`, after.posts === before.posts && after.localOrders === before.localOrders && !after.sheetOpen, JSON.stringify(rec));
  };
  for (const visible of [false, true]) {
    const name = `checkout: ${visible ? "visibly expired" : "expired before the display clock ticks"} sheet`;
    const before = await openPendingGuest(name, `/checkout/${DEMO}`, "co-email");
    // Date.now changes inside the page; the Node runner's wait clock and real timer scheduling remain unchanged.
    const displayWasCurrent = await page.eval(`(() => {
      const realNow = Date.now.bind(Date);
      Date.now = () => realNow() + 16 * 60_000;
      const current = !document.body.innerText.includes("This quote has run out.");
      ${visible ? "" : `const b = [...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent.trim() === "Continue as guest"); b.click();`}
      return current;
    })()`);
    check(`${name}: the deadline advances after a valid opening quote`, displayWasCurrent);
    if (visible) {
      check(`${name}: the page re-renders expired while the sheet remains open`, (await page.waitFor(`document.body.innerText.includes("This quote has run out.")`, 20000)) && (await sheetOpen()));
      await clickText('[role="dialog"] button', "Continue as guest");
    }
    await noGuestOrder(name, before);
    check(`${name}: refresh is required before paying`, await has("This quote has run out. Refresh it to see the current price."));
  }

  const changedCheckout = await openPendingGuest("checkout: changed finish", `/checkout/${DEMO}`, "co-email");
  await page.eval(`document.querySelector('[role="radio"][data-finish="holo"]').click()`);
  check("checkout: the current finish gate blocks Pay while the sheet stays open", (await page.waitFor(`[...document.querySelectorAll("button")].some((b) => b.textContent.trim().startsWith("Pay") && b.disabled)`)) && (await sheetOpen()));
  await clickText('[role="dialog"] button', "Continue as guest");
  await noGuestOrder("checkout: changed finish", changedCheckout);

  for (const clear of [false, true]) {
    const name = `cart: ${clear ? "cleared" : "blocked finish"} in another tab`;
    await page.eval(`localStorage.removeItem("ticketstub.cart.v1")`);
    await stock();
    const before = await openPendingGuest(name, "/cart", "cart-email");
    const other = await browser.newPage({ width: 390, height: 844 });
    try {
      await other.goto(base + "/wall", { settle: 100 });
      await other.eval(`localStorage.setItem("ticketstub.cart.v1", JSON.stringify(${clear ? "[]" : `JSON.parse(localStorage.getItem("ticketstub.cart.v1")).map((item) => ({ ...item, finish: "holo" }))`}))`);
      await page.send("Page.bringToFront");
      const changed = clear ? `document.body.innerText.includes("Nothing in your cart yet.")` : `[...document.querySelectorAll("button")].some((b) => b.textContent.trim().startsWith("Pay") && b.disabled)`;
      check(`${name}: this tab sees the current cart while the sheet stays open`, (await page.waitFor(changed, 10000)) && (await sheetOpen()));
      await clickText('[role="dialog"] button', "Continue as guest");
      await noGuestOrder(name, before);
    } finally {
      await other.close();
    }
  }

  // ---- 5. returnTo is a path on this site, nothing else ----
  const post = (path, body) => fetch(base + path, { method: "POST", redirect: "manual", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify(body) });
  const landing = async (returnTo) => {
    const r = await post("/api/auth/link", { email: `rt-${Math.random().toString(36).slice(2, 8)}@example.com`, reason: "checkout", returnTo });
    const token = new URL((await r.json()).devLink).searchParams.get("token");
    const c = await post("/api/auth/confirm", { token });
    return c.headers.get("location");
  };
  check("returnTo: the pay step's own path and query come back with signedIn=1", (await landing("/cart?resume=pay")) === "/cart?resume=pay&signedIn=1");
  check("returnTo: a checkout path comes back whole", (await landing(`/checkout/${DEMO}?resume=pay`)) === `/checkout/${DEMO}?resume=pay&signedIn=1`);
  for (const [label, bad] of [["absolute URL", "https://evil.example/cart"], ["protocol-relative", "//evil.example/cart"], ["backslash", "/\\evil.example"], ["javascript:", "javascript:alert(1)"]]) {
    check(`returnTo: ${label} is refused, the wall is used`, (await landing(bad)) === "/wall?signedIn=1", label);
  }

  check("no page error in the browser", page.consoleErrors.length === 0, page.consoleErrors.join(" | ").slice(0, 300));
} finally {
  await browser.close();
}

if (evidenceDir) {
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(join(evidenceDir, "pay-signin-checks.json"), JSON.stringify({ ...evidence, passed, failed }, null, 2));
}
console.log(`pay-signin: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
