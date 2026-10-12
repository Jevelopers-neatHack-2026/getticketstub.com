import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

// GT-11 (#18): swipe, long-press, drag and tear are never the only way to finish an action.
// These are static checks on the source: each gesture sits next to a real button that calls the same handler.
const read = (p) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");

test("long-press on the phone stub has an All styles button that opens the same sheet", () => {
  const src = read("customer/studio/editor/Editor.tsx");
  assert.match(src, /openSheet\("styles"\);\s*\}, LONG_PRESS_MS\)/, "long press opens the styles sheet");
  assert.match(src, /<button type="button" className=\{styles\.allStyles\}[^>]*onClick=\{\(\) => openSheet\("styles"\)\}>\s*All styles/);
});

test("swiping the phone stub has dots and arrow keys that deal the same way", () => {
  const src = read("customer/studio/editor/Editor.tsx");
  assert.match(src, /dealStep\(dx < 0 \? 1 : -1, dx, "swipe"\)/);
  assert.match(src, /onClick=\{\(\) => dealTo\(ed, "dots"\)\}/);
  assert.match(src, /e\.key === "ArrowLeft"/);
});

test("agent note swipe has a Dismiss button on the same handler", () => {
  const src = read("customer/studio/agent/AgentNotes.tsx");
  assert.match(src, /onDismiss\(dx > 0 \? 1 : -1\)/);
  assert.match(src, /aria-label="Dismiss this note" onClick=\{\(\) => onDismiss\(-1\)\}/);
});

test("lamp swipe flips through the same flip() as the Flip button", () => {
  const src = read("app/wall/WallClient.tsx");
  assert.match(src, /swiped\.current = true;\s*flip\(\);/);
  assert.match(src, /<Tool icon=\{<FlipIcon \/>\} onClick=\{flip\}>/);
});

test("wall stub drag has arrow-key moves and the lamp can be pinned back", () => {
  const src = read("app/wall/WallClient.tsx");
  assert.match(src, /onKeyDown=\{\(e\) => stubKey\(e, st\)\}/);
  assert.match(src, /aria-label="Pin it back"/);
});

test("tear has a slider with keys and a button, and a tear strip button", () => {
  const tear = read("customer/studio/stub/TearGesture.tsx");
  assert.match(tear, /role="slider"/);
  assert.match(tear, /onKeyDown=\{onKey\}/);
  assert.match(tear, /Or tear it off for me/);
  assert.match(read("customer/studio/editor/TearStrip.tsx"), /<button\s+type="button"[\s\S]*onClick=\{\(\) => \{[\s\S]*onTear\(\);/);
});

test("scripted motion checks prefers-reduced-motion", () => {
  for (const p of ["customer/studio/stub/TearGesture.tsx", "customer/studio/stub/useTilt.ts", "app/wall/useBoardCamera.ts", "app/organizer/PrintRun.tsx"]) {
    assert.match(read(p), /prefers-reduced-motion: reduce/, p);
  }
});
