// Native pointer checks for the agent fixture. A geometry lookup is not a click receipt.
// The selected node is retained through dispatch; no programmatic click or dispatch retry is used.
let sequence = 0;

export async function clickVisibleButton(page, { text = null, scope = '[role="dialog"]', chipLabel = null }) {
  const token = `agent-pointer-${++sequence}`;
  const target = await page.eval(`new Promise((resolve) => {
    const scope = ${JSON.stringify(scope)};
    const text = ${JSON.stringify(text)};
    const chipLabel = ${JSON.stringify(chipLabel)};
    const root = chipLabel === null ? document : [...document.querySelectorAll(scope + ' ul[aria-label="Proposed changes"] li')]
      .find(e => e.innerText.includes(chipLabel) && e.querySelector('button:not([disabled])'));
    const buttons = root ? [...root.querySelectorAll(chipLabel === null ? scope + ' button' : 'button')] : [];
    const b = buttons.find(e => !e.disabled && e.offsetParent && (text === null || e.textContent.trim().startsWith(text)));
    if (!b || b.closest('[inert]')) { resolve({ ready: false, reason: 'unavailable' }); return; }
    let frame, timer, previous, stable = 0, done = false;
    const finish = value => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      cancelAnimationFrame(frame);
      resolve(value);
    };
    const visible = () => {
      if (!b.isConnected || b.disabled || b.closest('[inert]')) return false;
      for (let e = b; e; e = e.parentElement) {
        const style = getComputedStyle(e);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
      }
      return true;
    };
    const sample = () => {
      if (!visible()) { finish({ ready: false, reason: 'unavailable' }); return; }
      const r = b.getBoundingClientRect();
      const box = [r.x, r.y, r.width, r.height];
      stable = previous && box.every((v, i) => Math.abs(v - previous[i]) < 0.5) ? stable + 1 : 0;
      previous = box;
      if (stable < 2) { frame = requestAnimationFrame(sample); return; }
      const x = r.x + r.width / 2, y = r.y + r.height / 2;
      const hit = document.elementFromPoint(x, y);
      if (r.width < 1 || r.height < 1 || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight || !hit || !(hit === b || b.contains(hit))) {
        finish({ ready: false, reason: 'not_hit_testable' }); return;
      }
      const slots = globalThis.__ticketstubAgentPointerReceipts ??= new Map();
      const state = { button: b, trustedClicks: 0 };
      state.listener = event => { if (event.isTrusted && event.composedPath().includes(b)) state.trustedClicks++; };
      b.addEventListener('click', state.listener, true);
      slots.set(${JSON.stringify(token)}, state);
      finish({ ready: true, x, y });
    };
    timer = setTimeout(() => finish({ ready: false, reason: 'motion_timeout' }), 1000);
    b.scrollIntoView({ block: 'center' });
    frame = requestAnimationFrame(sample);
  })`);
  if (!target.ready) return { clicked: false, reason: target.reason };
  let receipt;
  try {
    await page.click(target.x, target.y);
  } finally {
    receipt = await page.eval(`(() => {
      const slots = globalThis.__ticketstubAgentPointerReceipts;
      const state = slots?.get(${JSON.stringify(token)});
      if (!state) return { clicked: false, reason: 'receipt_missing' };
      state.button.removeEventListener('click', state.listener, true);
      slots.delete(${JSON.stringify(token)});
      return { clicked: state.trustedClicks === 1, reason: state.trustedClicks === 1 ? 'native_click' : 'native_click_not_received' };
    })()`);
  }
  return receipt;
}
