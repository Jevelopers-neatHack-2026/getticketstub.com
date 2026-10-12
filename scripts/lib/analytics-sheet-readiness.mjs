import { randomUUID } from "node:crypto";

const CODES = new Set(["missing_field", "ambiguous_field", "unowned_form", "identity_changed", "sheet_changed",
  "disabled", "hidden", "animating", "animation_state_unavailable", "ancestry_limit", "offscreen", "covered",
  "focus_failed", "input_changed", "submit_label_changed", "ready"]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const DEADLINE = Symbol("sheet_deadline"), PROTOCOL = Symbol("sheet_protocol");

// Runs on one retained remote object in the current document. Bind the exact field/form/button once;
// a React replacement or another sheet cannot silently become the target while readiness is pending.
export function inspectSheetTarget(phase, expectedEmail) {
  const wait = (code) => ({ state: "wait", code });
  const reject = (code) => ({ state: "reject", code });
  if (this.document !== document) return reject("identity_changed");
  const fields = document.querySelectorAll("#signin-email");
  const sheets = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
  const top = sheets[sheets.length - 1];
  if (!this.field) {
    if (!fields.length) return wait("missing_field");
    if (fields.length !== 1) return reject("ambiguous_field");
    const field = fields[0], form = field.form;
    const buttons = form?.querySelectorAll('button[type="submit"]');
    if (!top || !form || !top.contains(field) || !top.contains(form) || buttons?.length !== 1 || buttons[0].form !== form) return reject("unowned_form");
    Object.assign(this, { field, form, button: buttons[0], sheet: top });
  }
  const { field, form, button, sheet } = this;
  if (fields.length !== 1 || fields[0] !== field || ![field, form, button, sheet].every((node) => node.isConnected && node.ownerDocument === document)
    || field.form !== form || button.form !== form || !form.contains(field) || !form.contains(button)
    || !sheet.contains(form) || form.querySelectorAll('button[type="submit"]').length !== 1) return reject("identity_changed");
  if (top !== sheet) return reject("sheet_changed");
  if (field.disabled || field.readOnly || button.disabled) return wait("disabled");
  if (!(button.textContent || "").replace(/\s+/g, " ").trim().startsWith("Email me a link")) return reject("submit_label_changed");
  if (phase === "submit" && field.value !== expectedEmail) return reject("input_changed");
  const target = phase === "field" ? field : button;
  let ancestor = target, reachedRoot = false;
  for (let depth = 0; ancestor && depth < 32; depth++, ancestor = ancestor.parentElement) {
    if (ancestor.inert || ancestor.getAttribute("aria-hidden")?.trim().toLowerCase() === "true") return wait("hidden");
    const style = getComputedStyle(ancestor);
    if (style.display === "none" || ["hidden", "collapse"].includes(style.visibility) || Number(style.opacity) === 0) return wait("hidden");
    if (typeof ancestor.getAnimations !== "function") return reject("animation_state_unavailable");
    const animations = ancestor.getAnimations();
    if (animations.length > 32) return reject("animation_state_unavailable");
    if (animations.some((animation) => animation.pending || animation.playState === "running")) return wait("animating");
    if (ancestor === document.documentElement) { reachedRoot = true; break; }
  }
  if (!reachedRoot) return reject("ancestry_limit");
  target.scrollIntoView({ block: "center", inline: "center" });
  const box = target.getBoundingClientRect(), x = box.x + box.width / 2, y = box.y + box.height / 2;
  if (![x, y, box.width, box.height].every(Number.isFinite) || box.width < 1 || box.height < 1 || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return wait("offscreen");
  const hit = document.elementFromPoint(x, y);
  if (!hit || !(hit === target || target.contains(hit))) return wait("covered");
  if (phase === "field") {
    target.focus();
    target.select();
    if (document.activeElement !== target || !target.isConnected) return reject("focus_failed");
  }
  return { state: "ready", code: "ready", x, y };
}

/** One bounded entrance-readiness operation, one insertion, one trusted pointer click; never a click retry. */
export async function submitSheetEmail(page, email, { timeoutMs = 2500, pollMs = 25, cleanupMs = 250,
  clock = () => performance.now(), pause = sleep } = {}) {
  const start = clock(), deadline = start + timeoutMs, objectGroup = `ticketstub-sheet-${randomUUID()}`;
  const result = { ok: false, stage: "bind", code: "protocol_unavailable", timedOut: false,
    probes: { field: 0, submit: 0 }, lastReadiness: { field: null, submit: null },
    typeAttempts: 0, typed: false, clickAttempts: 0, clicked: false, cleanup: "pending" };
  const bounded = (operation, milliseconds) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(DEADLINE), Math.max(1, milliseconds));
    Promise.resolve().then(operation).then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error === DEADLINE ? DEADLINE : PROTOCOL); });
  });
  const remaining = () => Math.max(0, deadline - clock());
  const during = (operation) => {
    if (!remaining()) return Promise.reject(DEADLINE);
    return bounded(() => { if (!remaining()) throw DEADLINE; return operation(); }, remaining());
  };
  const send = (method, params) => during(() => page.send(method, params));
  try {
    const remote = await send("Runtime.evaluate", { expression: "({ document })", objectGroup, returnByValue: false });
    if (remote.exceptionDetails || !remote.result?.objectId) throw PROTOCOL;
    for (const phase of ["field", "submit"]) {
      result.stage = phase;
      result.code = "deadline_before_observation";
      let ready;
      while (remaining() > 0) {
        result.probes[phase]++;
        const response = await send("Runtime.callFunctionOn", { objectId: remote.result.objectId,
          functionDeclaration: inspectSheetTarget.toString(), arguments: [{ value: phase }, { value: email }], returnByValue: true });
        if (response.exceptionDetails) throw PROTOCOL;
        const value = response.result?.value;
        result.code = CODES.has(value?.code) ? value.code : "invalid_probe";
        if (CODES.has(value?.code)) result.lastReadiness[phase] = value.code;
        if (value?.state === "ready" && value.code === "ready" && Number.isFinite(value.x) && Number.isFinite(value.y)) { ready = value; break; }
        if (value?.state !== "wait" || !CODES.has(value.code)) return result;
        await pause(Math.min(pollMs, remaining()));
      }
      if (!ready) { result.timedOut = true; return result; }
      if (phase === "field") {
        result.typeAttempts = 1;
        await during(() => page.type(email));
        result.typed = true;
      } else {
        // Mark the attempt before dispatch: an uncertain transport outcome can never trigger another click.
        result.clickAttempts = 1;
        await during(() => page.click(ready.x, ready.y));
        result.clicked = true;
      }
    }
    result.ok = true;
    result.stage = "complete";
  } catch (error) {
    const last = result.lastReadiness[result.stage];
    result.code = result.clickAttempts ? "click_outcome_unknown" : result.typeAttempts && !result.typed ? "input_outcome_unknown"
      : error === DEADLINE ? (last === "ready" ? "deadline_after_ready" : last ?? "deadline_before_observation") : "protocol_unavailable";
    result.timedOut = error === DEADLINE;
  } finally {
    try {
      await bounded(() => page.send("Runtime.releaseObjectGroup", { objectGroup }), cleanupMs);
      result.cleanup = "released";
    } catch {
      result.cleanup = "unconfirmed";
      result.ok = false;
    }
    result.elapsedMs = Math.max(0, Math.round((clock() - start) * 100) / 100);
  }
  return result;
}
