// GT-11 automated accessibility checks, run in a real headless Chrome over the DevTools protocol.
//   node scripts/check-a11y.mjs <base-url> [evidence-dir]
// Run through `npm run verify:product -- --suite a11y --mode fixture --evidence-dir <dir>`, which serves the production build.
//  1. axe-core 4 (injected by the protocol) on each page at 390 and 1280 px: serious and critical violations fail the run,
//     minor and moderate ones are written to the evidence file.
//  2. No horizontal overflow at 320 and 640 px (and at 200% zoom: 640 px wide at device scale 2) on the same pages.
//  3. Keyboard: a skip link first, a visible focus ring on every stop of a Tab walk, sheets that hold and return focus.
//  4. Reduced motion: no running animation or transition longer than a blink on the pages once the preference is set.
//  5. The desk colours against paper, raised and sunk, to WCAG AA.
// A page that does not load, a missing Chrome and any skipped check exit nonzero. Offline: Chrome resolves loopback only.
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { launchBrowser, chromePath } from "./lib/cdp.mjs";
import { contrastRows } from "./lib/contrast.mjs";

const base = (process.argv[2] ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const evidenceDir = process.argv[3] ? resolve(process.argv[3]) : null;
const require = createRequire(import.meta.url);
const axeSource = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
const axeVersion = JSON.parse(readFileSync(join(dirname(require.resolve("axe-core/package.json")), "package.json"), "utf8")).version;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
let passed = 0;
function check(name, ok, detail = "") {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` ${detail}`}`);
  return ok;
}

const DEMO = "demo-pale";
const PAGES = ["/make", "/wall", `/studio/${DEMO}`, `/checkout/${DEMO}`, "/cart", "/help", "/account", "/privacy"];
const accepted = [];
const EXCEPTIONS = [
  { rule: "label-content-name-mismatch", match: /data-stub-id|_stubBtn/, reason: "A wall stub is a picture of a ticket; its printed words are artwork. Its name starts with the event title, which is the one word a voice user would say." },
  { rule: "target-size", match: /_(?:pick|pickBtn|subtitle|title)/, reason: "In-place edit targets on the stub scale with the stub. Every field is also reachable by a 44 px control (Facts sheet, Inspector); recorded as a limitation in docs/product/accessibility.md." },
];
const evidence = { accepted, axeVersion, chrome: chromePath(), base, pages: PAGES, axe: [], overflow: [], keyboard: [], motion: [], contrast: [] };

const browser = await launchBrowser();
const pageErrors = [];
try {
  // ---- 5. contrast of the tokens (pure, no browser) ----
  const rows = contrastRows();
  evidence.contrast = rows;
  for (const r of rows) check(`contrast ${r.name} on ${r.on}: ${r.ratio.toFixed(2)}:1 (needs ${r.need}:1)`, r.ratio >= r.need);

  const page = await browser.newPage({ width: 390, height: 844 });

  // Seed the demo stub the way a person does: through /new?demo=pale. Printing takes a few seconds.
  await page.goto(`${base}/new?demo=pale`, { settle: 300 });
  const seeded = await page.waitFor(`location.pathname === "/studio/${DEMO}"`, 30000);
  check(`the demo stub is on the desk (/studio/${DEMO})`, seeded, await page.eval("location.pathname"));

  const open = async (url, width, height, extra = {}) => {
    await page.resize(width, height, extra.dpr ?? 1, width < 700 && !extra.desktop);
    await page.goto(base + url, { settle: 900 });
  };

  // ---- 1. axe ----
  for (const width of [390, 1280]) {
    for (const url of PAGES) {
      await open(url, width, width === 390 ? 844 : 800);
      await page.eval(axeSource);
      const result = await page.eval(`axe.run(document, { resultTypes: ["violations"], runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] } }).then(r => r.violations.map(v => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.map(n => ({ target: n.target.join(" "), html: n.html.slice(0, 160), summary: (n.failureSummary || "").slice(0, 300) })) })))`);
      // Named exceptions, each with its reason, are recorded as evidence and do not fail the run.
      for (const v of result) {
        const ex = EXCEPTIONS.find((x) => x.rule === v.id);
        if (!ex) continue;
        const kept = v.nodes.filter((n) => !ex.match.test(n.target) && !ex.match.test(n.html));
        const excused = v.nodes.filter((n) => ex.match.test(n.target) || ex.match.test(n.html));
        if (excused.length) accepted.push({ url, width, rule: v.id, reason: ex.reason, nodes: excused.map((n) => n.target) });
        v.nodes = kept;
      }
      const checked = result.filter((v) => v.nodes.length > 0);
      const hard = checked.filter((v) => v.impact === "serious" || v.impact === "critical");
      const soft = checked.filter((v) => !(v.impact === "serious" || v.impact === "critical"));
      evidence.axe.push({ url, width, serious: hard, other: soft });
      check(`axe ${url} @${width}: no serious or critical violations (${soft.length} minor or moderate recorded)`, hard.length === 0, hard.map((v) => `${v.id}[${v.impact}] x${v.nodes.length} ${v.nodes[0].target}`).join("; "));
    }
  }

  // ---- 2. overflow ----
  // Controls cut off by the screen edge: clipping hides an action even when nothing scrolls sideways.
  const cutOffJs = `(() => { const w = innerWidth; const out = []; for (const el of document.querySelectorAll("button, a[href], input, select, textarea, [role=button], [role=radio], [role=switch], [role=slider]")) { if (el.closest("[data-cam-world], [inert], [hidden], [aria-hidden=true]")) continue; const cs = getComputedStyle(el); if (cs.visibility === "hidden" || cs.display === "none" || cs.pointerEvents === "none") continue; const r = el.getBoundingClientRect(); if (r.width === 0 || r.height === 0) continue; if (el.closest("[data-skip-cutoff]")) continue; if (r.right > w + 1 || r.left < -1) out.push((el.tagName.toLowerCase() + "." + String(el.className).slice(0, 30)) + " " + Math.round(r.left) + ".." + Math.round(r.right) + " " + (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 24)); } return out.slice(0, 6); })()`;
  const overflowJs = `(() => { const de = document.documentElement; const w = innerWidth; const bad = []; for (const el of document.querySelectorAll("body *")) { const r = el.getBoundingClientRect(); if (r.width === 0 || r.height === 0) continue; const cs = getComputedStyle(el); if (cs.position === "fixed" && r.right <= w + 1) continue; if (r.right > w + 1 || r.left < -1) { let p = el.parentElement, clipped = false; while (p && p !== document.body) { const o = getComputedStyle(p); if (/(hidden|auto|scroll|clip)/.test(o.overflowX) && p.getBoundingClientRect().right <= w + 1 && p.getBoundingClientRect().left >= -1) { clipped = true; break; } p = p.parentElement; } if (!clipped && bad.length < 4) bad.push((el.tagName + "." + String(el.className).slice(0, 40)) + " " + Math.round(r.left) + ".." + Math.round(r.right)); } } return { scroll: de.scrollWidth, client: de.clientWidth, w, bad }; })()`;
  for (const [label, width, dpr, text] of [["320", 320, 1], ["640", 640, 1], ["200% zoom (640 @2x)", 640, 2], ["200% text (390)", 390, 1, true]]) {
    for (const url of PAGES) {
      await open(url, width, 700, { dpr });
      if (text) await page.eval(`document.documentElement.style.fontSize = "200%"; 0`);
      const o = await page.eval(overflowJs);
      evidence.overflow.push({ url, width, dpr, ...o });
      check(`no horizontal overflow ${url} @${label}`, o.scroll <= o.client + 1, `scrollWidth ${o.scroll} > ${o.client}; ${o.bad.join(", ")}`);
      const cut = await page.eval(cutOffJs);
      evidence.overflow[evidence.overflow.length - 1].cutOff = cut;
      check(`no action cut off by the edge ${url} @${label}`, cut.length === 0, cut.join("; "));
    }
  }

  // ---- 3. keyboard ----
  for (const [url, width] of [["/make", 390], ["/wall", 1280], [`/studio/${DEMO}`, 390], [`/studio/${DEMO}`, 1280], ["/cart", 390], [`/checkout/${DEMO}`, 390]]) {
    await open(url, width, 800, { desktop: width >= 960 });
    // transitions off, so a focus ring is read at its end state, not half way
    await page.eval(`(() => { const st = document.createElement("style"); st.textContent = "*,*::before,*::after{transition:none!important}"; document.head.appendChild(st); document.body.focus(); window.scrollTo(0,0); })()`);
    await page.key("Tab");
    const first = await page.eval(`(() => { const e = document.activeElement; return e ? { text: (e.textContent || "").trim().slice(0, 40), href: e.getAttribute("href") } : null })()`);
    check(`${url} @${width}: the first Tab stop is the skip link`, !!first && /skip/i.test(first.text) && first.href === "#content", JSON.stringify(first));
    // walk the tab order: every stop must show a ring and be on screen (or scroll to it)
    const stops = [];
    for (let i = 0; i < 70; i++) {
      await page.key("Tab");
      // A ring is an outline, or any change in the control's own paint when it takes focus (a tag's edge, a box-shadow).
      const s = await page.eval(`(() => { const e = document.activeElement; if (!e || e === document.body) return null; const sig = () => { const c = getComputedStyle(e); return [c.outlineStyle, c.outlineWidth, c.boxShadow, c.backgroundColor, c.borderBottomColor, c.borderTopColor, c.color].join("|"); }; const on = sig(); const cs = getComputedStyle(e); const outline = parseFloat(cs.outlineWidth) > 0 && cs.outlineStyle !== "none"; e.blur(); const off = sig(); e.focus({ preventScroll: true }); const b = e.getBoundingClientRect(); const name = e.getAttribute("aria-label") || e.getAttribute("title") || (e.textContent || "").trim() || e.getAttribute("placeholder") || ""; return { tag: e.tagName.toLowerCase(), cls: String(e.className).slice(0, 40), name: name.slice(0, 40), ring: outline || on !== off, w: Math.round(b.width), h: Math.round(b.height), visible: b.width > 0 && b.height > 0 }; })()`);
      if (!s || s.tag === "nextjs-portal") break;
      stops.push(s);
      if (stops.length > 3 && JSON.stringify(stops[stops.length - 1]) === JSON.stringify(stops[0])) break;
    }
    const noRing = stops.filter((s) => !s.ring);
    const noName = stops.filter((s) => !s.name && s.tag !== "input");
    evidence.keyboard.push({ url, width, stops: stops.length, noRing, noName });
    check(`${url} @${width}: ${stops.length} tab stops, each with a visible focus ring`, stops.length > 3 && noRing.length === 0, noRing.map((s) => `${s.tag}.${s.cls} "${s.name}"`).slice(0, 4).join("; "));
    check(`${url} @${width}: every tab stop has a name`, noName.length === 0, noName.map((s) => `${s.tag}.${s.cls}`).slice(0, 4).join("; "));
  }

  // ---- 3b. the critical path by keyboard: dialogs hold focus, give it back, and every control can be reached ----
  /** Tab until `test` (a JS expression over `e`, the focused element) is true. */
  const tabTo = async (test, max = 90) => {
    for (let i = 0; i < max; i++) {
      await page.key("Tab");
      if (await page.eval(`(() => { const e = document.activeElement; return !!(e && e !== document.body && (${test})); })()`)) return true;
    }
    return false;
  };
  const OPEN_DIALOG = `[role="dialog"]:not([inert]):not([aria-hidden="true"])`;
  const inDialog = `(() => { const d = document.querySelector('${OPEN_DIALOG}'); return !!d && d.contains(document.activeElement); })()`;
  const noDialog = `(() => { const d = [...document.querySelectorAll('[role="dialog"]')].filter((x) => !x.closest("[inert]") && x.getAttribute("aria-hidden") !== "true"); return d.length === 0; })()`;
  const dialogCycle = async (label, opener) => {
    // opened: focus is inside; Tab and Shift+Tab from the ends stay inside; Esc closes and focus returns to the opener
    check(`${label}: focus moves into the dialog when it opens`, await page.waitFor(inDialog, 3000));
    let stayed = true;
    for (let i = 0; i < 30 && stayed; i++) {
      await page.key("Tab");
      stayed = await page.eval(inDialog);
    }
    for (let i = 0; i < 8 && stayed; i++) {
      await page.key("Tab", { shift: true });
      stayed = await page.eval(inDialog);
    }
    check(`${label}: Tab and Shift+Tab never leave the dialog`, stayed);
    await page.key("Escape");
    await page.waitFor(noDialog, 3000);
    const back = await page.eval(`(() => { const e = document.activeElement; return !!(e && e !== document.body && (${opener})); })()`);
    check(`${label}: Esc closes it and focus returns to the control that opened it`, back, await page.eval(`document.activeElement ? document.activeElement.tagName + " " + (document.activeElement.getAttribute("aria-label") || document.activeElement.textContent || "").slice(0, 40) : "none"`));
  };

  // the cart
  await open("/make", 390, 844);
  await page.eval(`document.body.focus(); 0`);
  const isCart = `(e.getAttribute("aria-label") || "").startsWith("Cart,")`;
  check("/make: the cart button can be reached by Tab", await tabTo(isCart));
  await page.key("Enter");
  await dialogCycle("cart", isCart);

  // the editor on a phone: facts and versions sheets
  await open(`/studio/${DEMO}`, 390, 844);
  await page.eval(`document.body.focus(); 0`);
  for (const [name, re] of [["Facts", "^Facts"], ["Versions", "^Versions"]]) {
    const opener = `new RegExp("${re}").test((e.textContent || "").trim())`;
    check(`studio @390: the ${name} button can be reached by Tab`, await tabTo(opener));
    await page.key("Enter");
    await dialogCycle(`${name} sheet`, opener);
  }
  // choose a style, flip, finish: all by keyboard (radios move with the arrow keys)
  const before = await page.eval(`document.querySelector("figure[data-edition]").getAttribute("data-edition")`);
  check("studio @390: a style button changes the style with Enter", await (async () => {
    await page.eval(`document.body.focus(); 0`);
    if (!(await tabTo(`/Letterpress style/.test(e.getAttribute("aria-label") || "")`))) return false;
    await page.key("Enter");
    await page.waitFor(`document.querySelector("figure[data-edition]")?.getAttribute("data-edition") === "letterpress"`, 3000);
    return before !== (await page.eval(`document.querySelector("figure[data-edition]").getAttribute("data-edition")`));
  })());
  check("studio @390: a stub field can be picked from the keyboard and its toolbar reached", await (async () => {
    await page.eval(`document.body.focus(); 0`);
    if (!(await tabTo(`e.matches("figure[data-edition] button") && /Pale/.test(e.textContent || "")`))) return false;
    await page.key("Enter");
    return page.waitFor(`!!document.querySelector('[role="toolbar"][aria-label], [role="toolbar"]') && document.querySelector('figure[data-edition] button[aria-pressed="true"]')`, 2000);
  })());
  await page.key("Escape");
  check("studio @390: the Flip tool flips the stub with Space", await (async () => {
    await page.eval(`document.body.focus(); 0`);
    if (!(await tabTo(`(e.textContent || "").trim() === "Flip"`))) return false;
    await page.key(" ");
    return page.waitFor(`document.querySelector("figure[data-edition]").className.includes("flipped") || document.querySelector("figure[data-edition] [aria-hidden='true']")`, 2000);
  })());
  check("studio @390: the finish picker moves with the arrow keys", await (async () => {
    await page.eval(`document.body.focus(); 0`);
    if (!(await tabTo(`e.getAttribute("role") === "radio" && e.closest('[aria-label="Finish"]')`))) return false;
    await page.key("ArrowRight");
    return page.waitFor(`document.querySelector('[aria-label="Finish"] [aria-checked="true"]') === document.activeElement`, 2000);
  })());
  await page.key("Escape");

  // the tear has a keyboard path: Tab to the strip, Enter, the handle takes focus, arrows tear, Enter finishes
  await page.eval(`document.body.focus(); 0`);
  const tearInView = (w, h) => page.eval(`(() => { const r = document.querySelector('[role="dialog"][aria-label="Tear off your stub"]')?.getBoundingClientRect(); return !!r && r.width > 0 && r.top >= 0 && r.left >= 0 && r.right <= ${w} + 1 && r.bottom <= ${h} + 1 && getComputedStyle(document.querySelector('[role="dialog"][aria-label="Tear off your stub"]')).position === "fixed"; })()`);
  const isStrip = `/Tear off and pin/.test(e.textContent || "")`;
  await open(`/studio/${DEMO}`, 1440, 900, { desktop: true });
  await page.eval(`document.body.focus(); 0`);
  if (await tabTo(isStrip)) {
    await page.key("Enter");
    await page.waitFor(`!!document.querySelector('[role="dialog"][aria-label="Tear off your stub"]')`, 3000);
  }
  check("tear @1440: the stage fills the viewport", await tearInView(1440, 900));
  await page.key("Escape");

  await open(`/studio/${DEMO}`, 390, 844);
  await page.eval(`document.body.focus(); 0`);
  check("studio @390: the tear strip can be reached by Tab", await tabTo(isStrip));
  await page.key("Enter");
  check("tear: focus lands on the tear handle (a slider)", await page.waitFor(`document.activeElement && document.activeElement.getAttribute("role") === "slider"`, 3000));
  check("tear @390: the stage fills the viewport (fixed, not pushed below the fold by .desk-surface)", await tearInView(390, 844));
  await page.key("ArrowRight");
  check("tear: the arrow keys tear a little at a time", Number(await page.eval(`document.activeElement.getAttribute("aria-valuenow")`)) > 0);
  await page.key("Escape");
  await page.waitFor(noDialog, 3000);
  check("tear: Esc goes back to styling and focus returns to the tear strip", await page.eval(`!!document.activeElement && /Tear off and pin/.test(document.activeElement.textContent || "")`));
  await page.key("Enter");
  await page.waitFor(`document.activeElement && document.activeElement.getAttribute("role") === "slider"`, 3000);
  await page.key("Enter");
  check("tear: Enter on the handle tears it off and pins it to the wall", await page.waitFor(`location.pathname === "/wall"`, 6000), await page.eval("location.href"));

  check("tear: the stub just pinned on the wall lifts the lamp when tapped", await (async () => {
    await page.waitFor(`!!document.querySelector('[class*="landingBtn"]')`, 4000);
    await sleep(1200); // the landing animation
    const at = await page.eval(`(() => { const el = document.querySelector('[class*="landingBtn"]'); el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
    await page.click(at[0], at[1]);
    const opened = await page.waitFor(`![...document.querySelectorAll('[role="dialog"]')].every((x) => x.closest("[inert]") || x.getAttribute("aria-hidden") === "true")`, 3000);
    await page.key("Escape");
    await page.waitFor(noDialog, 3000);
    return opened;
  })());

  // the wall: move a stub with the arrow keys, lift it, pin it back
  await open("/wall", 1280, 800);
  await page.eval(`document.body.focus(); 0`);
  check("wall: a stub can be reached by Tab", await tabTo(`e.hasAttribute("data-stub-id")`));
  const pos = () => page.eval(`(() => { const li = document.activeElement.closest("[data-stub-area]"); return li ? li.style.getPropertyValue("--x") + "," + li.style.getPropertyValue("--y") : ""; })()`);
  const p0 = await pos();
  await page.key("ArrowRight");
  await page.key("ArrowDown");
  const p1 = await pos();
  check(`wall: the arrow keys move a focused stub (${p0} to ${p1})`, p0 !== p1 && (await page.eval(`document.activeElement.hasAttribute("data-stub-id")`)));
  await page.key("Enter");
  await dialogCycle("wall lamp (lifted stub)", `e.hasAttribute("data-stub-id")`);
  await page.eval(`document.body.focus(); 0`);
  check("wall: zoom and fullscreen controls can be reached by Tab", await tabTo(`e.getAttribute("aria-label") === "Fullscreen"`));

  // the sign-in sheet
  await open("/wall", 1280, 800);
  await page.eval(`document.body.focus(); 0`);
  const isSave = `/Save your wall/.test(e.textContent || "")`;
  if (await tabTo(isSave)) {
    await page.key("Enter");
    await dialogCycle("sign-in sheet", isSave);
  } else {
    check("wall @1280: the sign-in button can be reached by Tab", false, "no 'Save your wall' control (is saving off?)");
  }

  // the review-before-approving sheet (GT-06B.1): signed in with the sandbox link, opened from the Versions sheet, so it is a dialog on a dialog
  await open(`/studio/${DEMO}`, 390, 844);
  const signedIn = await page.eval(`(async () => { const j = await (await fetch("/api/auth/link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "a11y-approve@example.com", returnTo: "/wall", reason: "save" }) })).json(); if (!j.devLink) return 0; return (await fetch("/api/auth/confirm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: new URL(j.devLink).searchParams.get("token") }) })).status; })()`);
  if (check("approve sheet: the sandbox sign-in link works", signedIn === 200, String(signedIn))) {
    await open(`/studio/${DEMO}`, 390, 844);
    await page.eval(`document.body.focus(); 0`);
    const isVersions = `/^Versions/.test((e.textContent || "").trim())`;
    const isApprove = `/^Approve for print/.test((e.textContent || "").trim())`;
    check("approve sheet: the Versions button can be reached by Tab", await tabTo(isVersions));
    await page.key("Enter");
    await page.waitFor(`!!document.querySelector('${OPEN_DIALOG}')`, 3000);
    if (check("approve sheet: 'Approve for print' can be reached by Tab inside Versions", await tabTo(isApprove))) {
      await page.key("Enter");
      const top = `(() => { const d = [...document.querySelectorAll('${OPEN_DIALOG}')].pop(); return !!d && d.contains(document.activeElement); })()`;
      check("approve sheet: focus moves into the new sheet", await page.waitFor(top, 3000));
      const named = await page.eval(`(() => { const d = [...document.querySelectorAll('${OPEN_DIALOG}')].pop(); const t = d && document.getElementById(d.getAttribute("aria-labelledby") || ""); return { title: t ? t.textContent : "", buttons: [...d.querySelectorAll("button")].map((b) => b.getAttribute("aria-label") || (b.textContent || "").trim()), headings: [...d.querySelectorAll("h3")].map((h) => h.textContent) }; })()`);
      check("approve sheet: it is named 'Approve for print' and its controls have names", named.title === "Approve for print" && ["Approve this version", "Cancel", "Close Approve for print"].every((n) => named.buttons.includes(n)), JSON.stringify(named));
      check("approve sheet: it says what changed, the printed facts and how it is made", ["What changed since your last approval", "Printed facts", "How it is made"].every((h) => named.headings.includes(h)), named.headings.join());
      let held = true;
      for (let i = 0; i < 24 && held; i++) {
        await page.key("Tab");
        held = await page.eval(top);
      }
      for (let i = 0; i < 6 && held; i++) {
        await page.key("Tab", { shift: true });
        held = await page.eval(top);
      }
      check("approve sheet: Tab and Shift+Tab never leave it (nor reach the Versions sheet under it)", held);
      await page.key("Escape");
      await page.waitFor(`document.querySelectorAll('${OPEN_DIALOG}').length === 1`, 3000);
      const one = await page.eval(`document.querySelectorAll('${OPEN_DIALOG}').length === 1`);
      const back = await page.eval(`(() => { const e = document.activeElement; return !!(e && e !== document.body && (${isApprove})); })()`);
      check("approve sheet: Esc closes only the top sheet and focus returns to 'Approve for print'", one && back, `one=${one} back=${back}`);
    }
  }

  // ---- 4. reduced motion ----
  const motion = await browser.newPage({ width: 390, height: 844, reducedMotion: true });
  await motion.goto(`${base}/new?demo=pale`, { settle: 300 });
  await motion.waitFor(`location.pathname === "/studio/${DEMO}"`, 30000);
  for (const url of PAGES) {
    await motion.goto(base + url, { settle: 1200 });
    const running = await motion.eval(`(() => document.getAnimations().filter(a => { const t = a.effect && a.effect.getComputedTiming(); const long = t && (t.iterations === Infinity || t.activeDuration > 300); return a.playState === "running" && long && !(a.effect.target && a.effect.target.closest("[data-motion-ok]")); }).map(a => (a.animationName || a.transitionProperty || "anim") + " on " + (a.effect.target ? a.effect.target.tagName.toLowerCase() + "." + String(a.effect.target.className).slice(0, 30) : "?")).slice(0, 6))()`);
    evidence.motion.push({ url, running });
    check(`reduced motion ${url}: no long or looping animation is running`, running.length === 0, running.join("; "));
  }
  const longRunning = `(() => document.getAnimations().filter(a => { const t = a.effect && a.effect.getComputedTiming(); return a.playState === "running" && t && (t.iterations === Infinity || t.activeDuration > 300); }).map(a => (a.animationName || a.transitionProperty || "anim")).slice(0, 6))()`;
  // printing: the feed does not run, every line is on the receipt at once, and it finishes by itself
  await motion.resize(390, 844, 1, true);
  await motion.goto(`${base}/new?demo=harbour`, { settle: 1500 });
  const printing = await motion.eval(longRunning);
  const lines = await motion.eval(`document.querySelectorAll("[data-receipt] button").length`);
  evidence.motion.push({ url: "/new?demo=harbour (printing)", running: printing, lines });
  check("reduced motion printing: no feed or shimmer is running, and every fact is on the receipt at once", printing.length === 0 && lines > 0, `${printing.join(", ")} lines=${lines}`);
  check("reduced motion printing: the stub lands without the feed animation", await motion.waitFor(`location.pathname === "/studio/demo-harbour"`, 20000), await motion.eval("location.pathname"));
  // holo finish: the tilt does not follow the pointer and nothing shimmers. A control page (motion allowed) proves the probe can see a tilt.
  const tiltOf = async (pg, id) => {
    await pg.resize(1280, 800, 1, false);
    await pg.goto(`${base}/studio/${id}`, { settle: 1500 });
    const at = await pg.eval(`(() => { const r = document.querySelector("[data-deck] figure[data-edition]").getBoundingClientRect(); return { x: r.x + r.width * 0.3, y: r.y + r.height * 0.35 }; })()`);
    await pg.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x - 20, y: at.y });
    await pg.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y });
    await new Promise((r) => setTimeout(r, 600));
    const hit = await pg.eval(`(() => { const e = document.elementFromPoint(${at.x}, ${at.y}); return e ? e.tagName.toLowerCase() + "." + String(e.className).slice(0, 30) + (e.closest("[data-deck] figure") ? " (on the stub)" : " (NOT on the stub)") : "nothing"; })()`);
    return { hit, rx: parseFloat((await pg.eval(`document.querySelector("[data-deck] figure[data-edition] > div").style.getPropertyValue("--rx")`)) || "0"), running: await pg.eval(longRunning), style: await pg.eval(`document.querySelector("[data-deck] figure[data-edition] > div").getAttribute("style")`), reduce: await pg.eval(`matchMedia("(prefers-reduced-motion: reduce)").matches`), edition: await pg.eval(`document.querySelector("[data-deck] figure[data-edition]").dataset.edition`) };
  };
  await motion.eval(`(() => { const k = "ticketstub.wall.v1"; const w = JSON.parse(localStorage.getItem(k)); for (const st of w) { st.finish = "holo"; st.material = "card"; } localStorage.setItem(k, JSON.stringify(w)); 0 })()`);
  const calm = await tiltOf(motion, "demo-harbour");
  // the control is a desktop-sized page of its own, with a stub nothing earlier in this run has touched
  const control = await browser.newPage({ width: 1280, height: 800, reducedMotion: false });
  await control.goto(`${base}/new?demo=neathack`, { settle: 300 });
  await control.waitFor(`location.pathname === "/studio/demo-neathack"`, 30000);
  await control.eval(`(() => { const k = "ticketstub.wall.v1"; const w = JSON.parse(localStorage.getItem(k)); for (const st of w) { st.finish = "holo"; st.material = "card"; } localStorage.setItem(k, JSON.stringify(w)); 0 })()`);
  const lively = await tiltOf(control, "demo-neathack");
  await control.close();
  evidence.motion.push({ url: "holo stub tilt", calm, lively });
  check("motion allowed (control): the pointer tilts the holo stub", Math.abs(lively.rx) > 1, JSON.stringify(lively));
  check("reduced motion holo finish: the pointer does not tilt the stub and no shimmer runs", calm.rx === 0 && calm.running.length === 0, JSON.stringify(calm));
  // cart flight: the stub does not fly across the screen; the count just changes
  await motion.goto(`${base}/checkout/${DEMO}`, { settle: 1200 });
  await motion.eval(`(() => { [...document.querySelectorAll("button")].find(b => /Add to cart/.test(b.textContent))?.click(); 0 })()`);
  await new Promise((r) => setTimeout(r, 150));
  const flying = await motion.eval(`[...document.querySelectorAll("div")].filter(d => /flight/i.test(String(d.className)) && d.getBoundingClientRect().width > 0).length`);
  check("reduced motion cart: no stub flies to the cart", flying === 0, `flights=${flying}`);
  await motion.close();
  pageErrors.push(...page.consoleErrors);
  await page.close();
} catch (e) {
  check("a11y suite ran to completion", false, e instanceof Error ? e.stack : String(e));
} finally {
  await browser.close();
}

if (evidenceDir) {
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(join(evidenceDir, "a11y-detail.json"), JSON.stringify({ ...evidence, pageErrors }, null, 2) + "\n");
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
