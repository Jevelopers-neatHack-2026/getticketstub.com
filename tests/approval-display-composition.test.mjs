import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalJson } from "../src/server/approval-token.ts";
import { sameComposition } from "../src/customer/studio/approval/printed.ts";

// Actual server serialization sorts keys; the client must compare the bound
// values, while continuing to reject every changed composition field.
const current = { edition: "researched", material: "digital", finish: "matte", size: "file" };
test("the actual canonical server encoding does not make an unchanged composition stale", () => {
  const returned = JSON.parse(canonicalJson(current));
  assert.notDeepEqual(Object.keys(returned), Object.keys(current));
  assert.equal(sameComposition(returned, current), true);
  assert.equal(sameComposition({ size: "file", finish: "matte", material: "digital", edition: "researched" }, current), true);
});

for (const key of Object.keys(current)) test(`a changed or absent bound ${key} is still stale`, () => {
  const returned = JSON.parse(canonicalJson(current));
  assert.equal(sameComposition({ ...returned, [key]: "different" }, current), false);
  delete returned[key];
  assert.equal(sameComposition(returned, current), false);
});

test("malformed composition values do not appear current", () => {
  for (const value of [null, undefined, [], "current", {}, { ...current, size: ["file"] }, Object.create(current)]) {
    assert.equal(sameComposition(value, current), false);
  }
});
