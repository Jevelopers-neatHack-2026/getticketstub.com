// Deliberately synthetic producers, real Chromium Blob/anchor/native downloads. No application or provider acceptance.
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchBrowser } from "./cdp.mjs";
import { DownloadReceipts } from "./download-receipts.mjs";
import { MESSAGES } from "../../src/customer/feedback-messages/messages.ts";

const fixture = (url) => {
  const { searchParams } = new URL(url, "http://127.0.0.1");
  const colour = searchParams.get("colour") === "red" ? "red" : "blue";
  const copies = searchParams.get("duplicate") === "1" ? 2 : 1;
  return `<!doctype html><html><body><div data-download-root><button data-download="front" style="width:160px;height:60px">Download control</button><div id="status"></div></div><script>
    const state = window.fixture = { clicks: 0, deliveries: [], ready: false };
    const canvas = Object.assign(document.createElement('canvas'), { width: 32, height: 16 });
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = ${JSON.stringify(colour)}; ctx.fillRect(0, 0, 32, 16);
    const gate = new Promise((resolve) => state.release = resolve);
    const blobReady = new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    blobReady.then(async (blob) => {
      state.sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))].map(v => v.toString(16).padStart(2, '0')).join('');
      state.ready = true;
    });
    document.querySelector('button').onclick = async () => {
      state.clicks++;
      await gate;
      const blob = await blobReady;
      for (let i = 0; i < ${copies}; i++) {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        // Intentionally the same suggested name for A and B: it cannot establish identity.
        a.download = 'ticketstub-control-2026-10-12.png';
        document.body.appendChild(a);
        state.deliveries.push({ url: a.href, bytes: blob.size });
        a.click(); a.remove();
      }
    };
  </script></body></html>`;
};

/** Every negative has its own real browser and retained directory so it cannot contaminate the app journey. */
export async function checkDownloadReceiptControls(check, directory, { kinds = ["fresh-b", "late-a-current-b", "unknown", "duplicate", "duplicate-native", "second-arm", "saved-file-mismatch", "late-after-no-download", "unknown-pending"], Collector = DownloadReceipts } = {}) {
  mkdirSync(directory, { recursive: true });
  const server = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
    res.end(fixture(req.url));
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const results = [];
  try {
    for (const kind of kinds) {
      const folder = join(directory, kind), browser = await launchBrowser();
      const tracker = new Collector(browser, join(folder, "native"), { timeoutMs: 8000 });
      const rec = { kind, mode: "synthetic producer in real native browser", observations: {} };
      let ok = false;
      try {
        rec.browser = await browser.conn.send("Browser.getVersion");
        await tracker.start();
        const page = async (query, observed = true) => {
          const p = await browser.newPage({ width: 800, height: 600, mobile: false });
          if (observed) await tracker.install(p);
          await p.goto(`${base}/${query}`, { settle: 30 });
          if (!await p.waitFor("fixture.ready", 5000)) throw new Error("synthetic PNG fixture was not ready");
          return p;
        };
        const press = async (p) => {
          await p.send("Page.bringToFront");
          const r = await p.eval("(() => { const r = document.querySelector('button').getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2 }; })()");
          await p.click(r.x, r.y);
          if (!await p.waitFor("fixture.clicks === 1", 1000)) throw new Error("native control click did not occur exactly once");
        };
        const release = (p) => p.eval("fixture.release(); true");
        const rejection = async (fn) => { try { await fn(); return null; } catch (e) { return e.message; } };

        if (kind === "late-a-current-b") {
          const a = await page("?colour=red"), b = await page("?colour=blue");
          const aa = await tracker.arm(a, "front", "pending A");
          await press(a); // A is pending before B is armed, and both remain gated before their real anchors.
          const ab = await tracker.arm(b, "front", "current B");
          await press(b);
          let bResult = null, bError = null;
          const collectingB = tracker.download(ab).then((v) => bResult = v, (e) => bError = e.message);
          await release(a);
          const aResult = await tracker.download(aa); // actual A completion while B's producer is still held
          const heldB = await b.eval("({ clicks: fixture.clicks, deliveries: fixture.deliveries.length })");
          const didNotTakeA = !bResult && !bError && heldB.clicks === 1 && heldB.deliveries === 0 && !ab.settled;
          await release(b);
          await collectingB;
          const expected = { a: await a.eval("fixture.sha256"), b: await b.eval("fixture.sha256") };
          Object.assign(rec.observations, { didNotTakeA, heldB, expected, a: aResult.receipt, b: bResult?.receipt, bError });
          ok = didNotTakeA && !bError && aResult.receipt.sha256 === expected.a && bResult?.receipt.sha256 === expected.b
            && expected.a !== expected.b && aResult.receipt.guid !== bResult.receipt.guid
            && aResult.receipt.executionContextUniqueId !== bResult.receipt.executionContextUniqueId;
        } else if (kind === "unknown") {
          const p = await page("?colour=red", false);
          await press(p); await release(p);
          await tracker.until(() => [...tracker.downloads.values()].some((d) => d.state === "completed"), "actual unknown native completion");
          const deliveries = await p.eval("fixture.deliveries");
          rec.observations.deliveries = deliveries;
          ok = deliveries.length === 1 && tracker.downloads.size === 1 && tracker.producers.size === 0
            && tracker.audit().some((v) => v.code === "unknown_or_ambiguous_native_download");
        } else {
          const p = await page(kind === "duplicate" ? "?duplicate=1" : "?colour=blue");
          const action = await tracker.arm(p, "front", kind);
          await press(p);
          if (kind === "unknown-pending") {
            // Reproduce the UI ambiguity with a genuinely held producer. An unrelated completed
            // bad-image message elsewhere must not qualify this selected control's timeout.
            rec.observations.pending = await p.eval(`(() => {
              const failure = document.createElement('div'); failure.dataset.failure = '';
              failure.appendChild(document.createElement('p')).textContent = ${JSON.stringify(MESSAGES.timeout.message)};
              document.getElementById('status').appendChild(failure);
              const other = failure.cloneNode(true); other.querySelector('p').textContent = ${JSON.stringify(MESSAGES.bad_image.message)};
              document.body.appendChild(other);
              return { genericFailure: !!document.querySelector('[data-failure]'), enabled: !document.querySelector('button').disabled, deliveries: fixture.deliveries.length };
            })()`);
            rec.observations.rejection = await rejection(() => tracker.noDownload(p, action, "failed", { failureMessage: MESSAGES.bad_image.message }));
            rec.observations.refusedTerminal = !action.settled && !action.noDownload;
            await release(p);
            await tracker.until(() => tracker.downloads.size === 1 && [...tracker.downloads.values()][0].state === "completed", "held unknown producer actually delivering after release");
            rec.observations.afterRelease = await p.eval("fixture.deliveries");
            // A rejected terminal must leave the actual single producer available for correct collection.
            try { rec.observations.result = (await tracker.download(action)).receipt; }
            catch (e) { rec.observations.collectionError = e.message; }
            const expected = await p.eval("fixture.sha256");
            ok = rec.observations.pending.genericFailure && rec.observations.pending.enabled && rec.observations.pending.deliveries === 0
              && rec.observations.rejection?.includes("no_download_failure_not_terminal") && rec.observations.refusedTerminal
              && rec.observations.afterRelease.length === 1 && rec.observations.result?.sha256 === expected;
          } else if (kind === "late-after-no-download") {
            // Deliberately lie about a terminal outcome, then exercise an actual late native producer.
            // The collector must retain the contradiction even after the no-download action was settled.
            rec.observations.sealed = await tracker.noDownload(p, action, "synthetic-cancelled");
            await release(p);
            await tracker.until(() => tracker.downloads.size === 1 && [...tracker.downloads.values()][0].state === "completed", "actual late native completion after terminal");
            ok = action.settled && action.noDownload === "synthetic-cancelled" && action.producerIds.length === 1
              && tracker.audit().some((v) => v.code === "unowned_producer");
          } else if (kind === "duplicate") {
            await release(p);
            await tracker.until(() => tracker.downloads.size === 2 && [...tracker.downloads.values()].every((d) => d.state === "completed"), "two actual duplicate native completions");
            rec.observations.rejection = await rejection(() => tracker.download(action));
            rec.observations.deliveries = await p.eval("fixture.deliveries");
            ok = action.controls === 1 && action.producerIds.length === 2 && rec.observations.deliveries.length === 2
              && rec.observations.rejection?.includes("duplicate_producer") && tracker.audit().some((v) => v.code === "duplicate_producer");
          } else if (kind === "duplicate-native") {
            await release(p);
            await tracker.until(() => tracker.downloads.size === 1 && [...tracker.downloads.values()][0].state === "completed", "first actual native completion before same-URL replay");
            // A real default anchor activation does not call the wrapped prototype method. Reuse the
            // exact URL in the same frame: one producer now has two actual native GUIDs and is ambiguous.
            const r = await p.eval(`(() => {
              const a = document.createElement('a');
              a.href = fixture.deliveries[0].url; a.download = 'ticketstub-control-2026-10-12.png';
              a.textContent = 'Native replay'; a.style = 'display:block;width:160px;height:60px';
              document.body.appendChild(a);
              const r = a.getBoundingClientRect(); return { x:r.x+r.width/2, y:r.y+r.height/2 };
            })()`);
            await p.click(r.x, r.y);
            await tracker.until(() => tracker.downloads.size === 2 && [...tracker.downloads.values()].every((d) => d.state === "completed"), "two actual native completions for one Blob URL");
            rec.observations.rejection = await rejection(() => tracker.download(action));
            ok = action.controls === 1 && action.producerIds.length === 1
              && new Set([...tracker.downloads.values()].map((d) => d.url)).size === 1
              && rec.observations.rejection?.includes("ambiguous_native_download");
          } else if (kind === "saved-file-mismatch") {
            await release(p);
            await tracker.until(() => tracker.downloads.size === 1 && [...tracker.downloads.values()][0].state === "completed"
              && tracker.producers.size === 1 && [...tracker.producers.values()][0].sha256, "real completed file before intentional corruption");
            const guid = [...tracker.downloads.keys()][0], file = join(tracker.directory, guid);
            const original = readFileSync(file);
            writeFileSync(join(folder, "before-intentional-corruption.png"), original);
            writeFileSync(file, Buffer.concat([original, Buffer.from("synthetic corruption")]));
            rec.observations.rejection = await rejection(() => tracker.download(action));
            ok = original.subarray(0, 8).toString("hex") === "89504e470d0a1a0a"
              && rec.observations.rejection?.includes("native_blob_mismatch") && tracker.audit().some((v) => v.code === "native_blob_mismatch");
          } else {
            await release(p);
            const result = await tracker.download(action), expected = await p.eval("fixture.sha256");
            Object.assign(rec.observations, { result: result.receipt, expected });
            ok = result.receipt.sha256 === expected && tracker.downloads.size === 1 && result.buf.subarray(0, 8).toString("hex") === "89504e470d0a1a0a";
            if (kind === "second-arm") {
              rec.observations.rejection = await rejection(() => tracker.arm(p, "front", "second action in same document"));
              ok &&= rec.observations.rejection?.includes("document_reused") && tracker.audit().some((v) => v.code === "document_reused")
                && [...tracker.actions.values()].filter((a) => a.documentId).length === 1;
            }
          }
        }
      } catch (e) {
        rec.error = e.message;
        ok = false;
      } finally {
        await browser.close(); // keep observing late/cancelled native events through teardown
        rec.receipts = tracker.snapshot();
        tracker.stop();
      }
      if (kind === "fresh-b" || kind === "late-a-current-b" || kind === "unknown-pending") ok &&= rec.receipts.violations.length === 0;
      rec.passed = Boolean(ok);
      writeFileSync(join(folder, "control.json"), JSON.stringify(rec, null, 2));
      results.push(rec);
      check(`synthetic native-download control: ${kind}`, rec.passed, JSON.stringify({ error: rec.error, observations: rec.observations, violations: rec.receipts.violations }));
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  return results;
}
