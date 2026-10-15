import assert from "node:assert/strict";
import { test } from "node:test";
import { labBackground } from "../src/app/stub-lab/background.ts";

test("lab backgrounds permit only literal hex colors or transparent", () => {
  for (const color of ["#abc", "#AbC", "#123456", "#ABCdef", "transparent"]) assert.equal(labBackground(color), color);
  for (const query of [null, "", "red", "#12", "#12345", "#1234567", " #123456", "url(https://background-probe.invalid/__bg_probe__)", 'url("/__bg_probe__")', 'image-set(url("https://background-probe.invalid/__bg_probe__") 1x)', "red url(https://background-probe.invalid/__bg_probe__)", "var(--remote)", "/*comment*/#fff", "#fff; background:url(https://background-probe.invalid/__bg_probe__)"]) {
    assert.equal(labBackground(query), "#1a1a1a", String(query));
  }
});
