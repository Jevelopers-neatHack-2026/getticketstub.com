// A small Chrome DevTools Protocol driver, no dependencies (Node's own WebSocket and fetch).
// Used by the a11y suite of verify:product and by hand-run audits. It starts its own headless Chrome with a
// throwaway profile, and refuses every host but loopback so a page can never reach the network.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CANDIDATES = [
  process.env.CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);

export const chromePath = () => CANDIDATES.find((p) => existsSync(p)) ?? null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launchBrowser() {
  const exe = chromePath();
  if (!exe) throw new Error("no Chrome or Edge found (set CHROME_PATH)");
  const profile = mkdtempSync(join(tmpdir(), "ticketstub-chrome-"));
  const child = spawn(
    exe,
    [
      "--headless=new",
      // Background audits must not play sound or take over the user's media keys.
      "--mute-audio",
      "--disable-features=HardwareMediaKeyHandling",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--hide-scrollbars",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      // loopback only: any other host does not resolve, so a fixture run cannot touch the network
      "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1 , EXCLUDE localhost",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let log = "";
  child.stderr.on("data", (d) => (log += d));
  // A cold headless start on a busy CI runner can take well over 10 s, so allow 30 s. On timeout the child is killed
  // rather than left running behind the failed check.
  let wsUrl = null;
  const deadline = Date.now() + 30_000;
  while (!wsUrl && Date.now() < deadline) {
    const m = /DevTools listening on (ws:\/\/\S+)/.exec(log);
    if (m) wsUrl = m[1];
    else if (child.exitCode !== null) throw new Error(`Chrome exited early: ${log.slice(0, 300)}`);
    else await sleep(100);
  }
  if (!wsUrl) {
    child.kill("SIGKILL");
    throw new Error(`Chrome did not report a DevTools address within 30 s: ${log.slice(0, 300)}`);
  }
  const conn = await connect(wsUrl);
  return {
    conn,
    async newPage(opts) {
      const { targetId } = await conn.send("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await conn.send("Target.attachToTarget", { targetId, flatten: true });
      const page = new Page(conn, sessionId, targetId);
      await page.setup(opts);
      return page;
    },
    async close() {
      try {
        await conn.send("Browser.close");
      } catch {
        /* already gone */
      }
      child.kill();
      await new Promise((r) => (child.exitCode !== null ? r() : child.once("close", r)));
      try {
        rmSync(profile, { recursive: true, force: true });
      } catch {
        /* Windows may hold the profile a moment; a leftover temp folder is not a failure */
      }
    },
  };
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    const listeners = new Set();
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { ok, no } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) no(new Error(`${msg.error.message}`));
        else ok(msg.result);
      } else if (msg.method) listeners.forEach((l) => l(msg));
    };
    ws.onerror = () => reject(new Error("DevTools socket error"));
    ws.onopen = () =>
      resolve({
        send: (method, params = {}, sessionId) =>
          new Promise((ok, no) => {
            const n = ++id;
            pending.set(n, { ok, no });
            ws.send(JSON.stringify({ id: n, method, params, sessionId }));
          }),
        on: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
      });
  });
}

export class Page {
  constructor(conn, sessionId, targetId) {
    this.conn = conn;
    this.sid = sessionId;
    this.targetId = targetId;
    /** Requests that failed to load (404s excluded), for evidence. */
    this.failed = [];
    this.consoleErrors = [];
    conn.on((m) => {
      if (m.sessionId !== sessionId) return;
      if (m.method === "Network.loadingFailed" && !m.params.canceled) this.failed.push(m.params.errorText);
      if (m.method === "Runtime.exceptionThrown") this.consoleErrors.push(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text ?? "exception");
    });
  }
  send(method, params) {
    return this.conn.send(method, params, this.sid);
  }
  async setup({ width = 390, height = 844, dpr = 1, mobile, reducedMotion = false } = {}) {
    await this.send("Page.enable");
    await this.send("Runtime.enable");
    await this.send("Network.enable");
    await this.send("DOM.enable");
    await this.resize(width, height, dpr, mobile ?? width < 700);
    // Always set, so a run never depends on the machine's own "reduce motion" setting.
    await this.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: reducedMotion ? "reduce" : "no-preference" }] });
  }
  async resize(width, height = 844, dpr = 1, mobile = width < 700) {
    await this.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: dpr, mobile, screenWidth: width, screenHeight: height });
    if (mobile) await this.send("Emulation.setTouchEmulationEnabled", { enabled: true });
    else await this.send("Emulation.setTouchEmulationEnabled", { enabled: false });
  }
  async goto(url, { settle = 600 } = {}) {
    const loaded = new Promise((r) => {
      const off = this.conn.on((m) => {
        if (m.sessionId === this.sid && m.method === "Page.loadEventFired") {
          off();
          r();
        }
      });
      setTimeout(r, 20000);
    });
    await this.send("Page.navigate", { url });
    await loaded;
    await sleep(settle);
  }
  /** Evaluates an expression (awaiting promises) and returns its JSON value. */
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }
  async waitFor(expression, ms = 8000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      try {
        if (await this.eval(`!!(${expression})`)) return true;
      } catch {
        /* the page is navigating */
      }
      await sleep(100);
    }
    return false;
  }
  async key(key, { shift = false, code } = {}) {
    const info = KEYS[key] ?? { key, code: code ?? (key.length === 1 ? `Key${key.toUpperCase()}` : key), vk: key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0 };
    const modifiers = shift ? 8 : 0;
    const text = key === "Enter" ? "\r" : key.length === 1 ? key : key === " " ? " " : undefined;
    await this.send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", key: info.key, code: info.code, windowsVirtualKeyCode: info.vk, modifiers, text });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", key: info.key, code: info.code, windowsVirtualKeyCode: info.vk, modifiers });
    await sleep(60);
  }
  async type(text) {
    await this.send("Input.insertText", { text });
    await sleep(40);
  }
  async click(x, y) {
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    await sleep(80);
  }
  async screenshot(file, { clip } = {}) {
    const { data } = await this.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false, ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
    writeFileSync(file, Buffer.from(data, "base64"));
  }
  /** A screenshot of the element that currently has focus, with some room around it. */
  async screenshotFocus(file, pad = 24) {
    const r = await this.eval(`(() => { const e = document.activeElement; if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.x + scrollX, y: b.y + scrollY, width: b.width, height: b.height, vw: document.documentElement.scrollWidth, vh: document.documentElement.scrollHeight }; })()`);
    if (!r) return this.screenshot(file);
    const x = Math.max(0, r.x - pad);
    const y = Math.max(0, r.y - pad);
    return this.screenshot(file, { clip: { x, y, width: Math.min(r.vw - x, r.width + pad * 2), height: Math.min(r.vh - y, r.height + pad * 2) } });
  }
  async close() {
    try {
      await this.conn.send("Target.closeTarget", { targetId: this.targetId });
    } catch {
      /* gone */
    }
  }
}

const KEYS = {
  Tab: { key: "Tab", code: "Tab", vk: 9 },
  Enter: { key: "Enter", code: "Enter", vk: 13 },
  Escape: { key: "Escape", code: "Escape", vk: 27 },
  " ": { key: " ", code: "Space", vk: 32 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  Home: { key: "Home", code: "Home", vk: 36 },
  End: { key: "End", code: "End", vk: 35 },
};
