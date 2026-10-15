import { clickVisibleButton } from './visible-pointer.mjs';

/** Synthetic controls in a real browser, kept separate from the application journey. */
export async function checkVisiblePointerControls(browser, check) {
  const results = [];
  for (const kind of ['visible', 'covered', 'disabled', 'inert', 'replaced', 'programmatic']) {
    const page = await browser.newPage({ width: 900, height: 700 });
    try {
      await page.eval(`(() => {
        document.body.innerHTML = '<div role="dialog"><button id="target" style="position:absolute;left:50px;top:50px;width:160px;height:60px">Apply all 2</button></div>';
        globalThis.controlClicks = [];
        const b = document.getElementById('target');
        document.addEventListener('click', e => controlClicks.push({ trusted: e.isTrusted, original: e.composedPath().includes(b) }), true);
        if (${JSON.stringify(kind)} === 'covered') {
          const cover = document.createElement('div');
          cover.style = 'position:fixed;inset:0;z-index:10;background:rgba(0,0,0,.01)';
          document.body.appendChild(cover);
        }
        if (${JSON.stringify(kind)} === 'disabled') b.disabled = true;
        if (${JSON.stringify(kind)} === 'inert') b.parentElement.inert = true;
      })()`);
      // The replacement is deliberate: keep the appearance and coordinates, change node identity
      // after target selection but before the actual native dispatch. No synthetic click is sent.
      const client = kind === 'programmatic' ? {
        eval: page.eval.bind(page),
        click: () => page.eval("document.getElementById('target').click()"),
      } : kind === 'replaced' ? {
        eval: page.eval.bind(page),
        click: async (x, y) => {
          await page.eval(`(() => { const b = document.getElementById('target'); b.replaceWith(b.cloneNode(true)); })()`);
          return page.click(x, y);
        },
      } : page;
      const receipt = await clickVisibleButton(client, { text: 'Apply all' });
      const clicks = await page.eval('globalThis.controlClicks');
      const positive = kind === 'visible';
      const exercised = positive ? clicks.length === 1 && clicks[0].trusted && clicks[0].original
        : kind === 'replaced' ? clicks.length === 1 && clicks[0].trusted && !clicks[0].original
        : kind === 'programmatic' ? clicks.length === 1 && !clicks[0].trusted && clicks[0].original
        : clicks.length === 0;
      const ok = receipt.clicked === positive && exercised;
      check(`synthetic native-pointer control: ${kind} agrees with an actual trusted click on the selected node`, ok, JSON.stringify({ receipt, clicks }));
      results.push({ kind, receipt, clicks, passed: ok });
    } finally {
      await page.close();
    }
  }
  return results;
}
