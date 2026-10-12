import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import "./analytics-hooks.mjs";

// Version history must survive the browser store (GT-02.3, GT-06A): older versions keep their inline art across
// saves, reloads and restores; a full store releases the oldest unselected pictures and says so, never swapping art;
// legacy walls that already lost pictures read as unavailable; and a sync does not give a lost picture back to the account.

class FakeStorage {
  limit = Infinity; // total characters the store holds
  mode = "ok"; // "ok" | "blocked"
  writes = 0;
  #m = new Map();
  getItem(k) {
    return this.#m.has(k) ? this.#m.get(k) : null;
  }
  setItem(k, v) {
    this.writes++;
    if (this.mode === "blocked") throw Object.assign(new Error("blocked"), { name: "SecurityError" });
    const next = [...this.#m].filter(([key]) => key !== k).reduce((n, [, val]) => n + val.length, 0) + String(v).length;
    if (next > this.limit) throw Object.assign(new Error("full"), { name: "QuotaExceededError" });
    this.#m.set(k, String(v));
  }
  removeItem(k) {
    this.#m.delete(k);
  }
}
const localStorage = new FakeStorage();
Object.assign(new EventTarget(), {});
globalThis.window = Object.assign(new EventTarget(), { localStorage, location: { origin: "https://x.example", hostname: "x.example", pathname: "/", search: "" } });
globalThis.localStorage = localStorage;

const store = await import("../src/customer/studio/store.ts");
const retention = await import("../src/customer/studio/versions/retention.ts");
const versions = await import("../src/customer/studio/versions/versions.ts");
const sync = await import("../src/customer/account/sync.ts");

const img = (tag, size = 2000) => `data:image/png;base64,${tag}${"A".repeat(size)}`;
const version = (id, n, art = {}) => ({
  id,
  ...(n ? { parentId: `v${n - 1}` } : {}),
  edition: "researched",
  art: { kind: "image", src: img(id), seed: n, provenance: "live", ...art },
  createdAt: new Date(Date.UTC(2026, 9, 1, 0, n)).toISOString(),
});
const stub = (id, count, current = `v${count - 1}`) => ({
  id,
  createdAt: "2026-10-01T00:00:00.000Z",
  event: { type: "concert", title: "T", facts: [] },
  versions: Array.from({ length: count }, (_, n) => version(`v${n}`, n)),
  currentVersionId: current,
  personal: { titleFont: 0, titleColor: "", foilTitle: false, hiddenFields: [], friends: [] },
  material: "card",
  finish: "matte",
  torn: false,
  wallAngle: 0,
  photos: [],
});
const art = (s, id) => s.versions.find((v) => v.id === id).art;

beforeEach(() => {
  localStorage.limit = Infinity;
  localStorage.mode = "ok";
  localStorage.removeItem("ticketstub.wall.v1");
  localStorage.removeItem("ticketstub.wall.deleted.v1");
});

describe("version art across save, reload and restore", () => {
  test("older versions keep their inline art after the selection moves, a reload and a restore", () => {
    assert.equal(store.upsertStub(stub("a", 4)), true);
    // select an older version (restore), save, reload, select the newest again: every picture is still there
    let s = store.getStub("a");
    s = versions.restoreVersion(s, "v1");
    store.upsertStub(s);
    s = versions.restoreVersion(store.getStub("a"), "v3");
    store.upsertStub(s);
    const back = store.getStub("a");
    for (const id of ["v0", "v1", "v2", "v3"]) {
      assert.equal(art(back, id).src, img(id), `${id} keeps its picture`);
      assert.equal(art(back, id).kind, "image");
      assert.ok(!retention.artUnavailable(art(back, id)));
    }
  });

  test("the version hash does not change when the selection moves", () => {
    store.upsertStub(stub("a", 3));
    const before = versions.versionHash(store.getStub("a").versions[0]);
    store.upsertStub(versions.restoreVersion(store.getStub("a"), "v0"));
    store.upsertStub(versions.restoreVersion(store.getStub("a"), "v2"));
    assert.equal(versions.versionHash(store.getStub("a").versions[0]), before);
  });
});

describe("a full store", () => {
  test("releases only as many of the oldest unselected pictures as it must, and marks them unavailable", () => {
    const s = stub("a", 5); // v4 selected; v0..v3 can go
    const full = JSON.stringify([s]).length;
    localStorage.limit = full - 3900; // two pictures (about 2000 characters each) must go, one is not enough
    assert.equal(store.writeWall([s]), true);
    const back = store.getStub("a");
    assert.ok(retention.artUnavailable(art(back, "v0")));
    assert.ok(retention.artUnavailable(art(back, "v1")));
    assert.equal(art(back, "v0").seed, 0, "its identity stays");
    assert.equal(art(back, "v2").src, img("v2"), "newer unselected art stays");
    assert.equal(art(back, "v3").src, img("v3"));
    assert.equal(art(back, "v4").src, img("v4"), "the selected picture is never released");
    assert.match(versions.artLabel(art(back, "v0")).text, /not kept on this device/);
    assert.equal(store.writeWallDetailed([s]).released, 2);
  });

  test("never releases the selected version: if it alone doesn't fit, nothing is stored and the old wall stays", () => {
    const small = stub("a", 1);
    store.writeWall([small]);
    const before = localStorage.getItem("ticketstub.wall.v1");
    localStorage.limit = before.length + 10;
    const big = stub("a", 3);
    big.versions[2].art.src = img("v2", 50_000);
    assert.equal(store.writeWall([big]), false);
    assert.equal(localStorage.getItem("ticketstub.wall.v1"), before);
  });

  test("storage that is blocked fails once, without retrying every picture", () => {
    localStorage.mode = "blocked";
    const before = localStorage.writes;
    assert.equal(store.writeWall([stub("a", 6)]), false);
    assert.equal(localStorage.writes - before, 1);
  });

  test("the number of write attempts stays logarithmic in the pictures held", () => {
    const stubs = Array.from({ length: 10 }, (_, i) => stub(`s${i}`, 8));
    localStorage.limit = JSON.stringify(stubs).length / 2;
    const before = localStorage.writes;
    store.writeWall(stubs);
    assert.ok(localStorage.writes - before <= 12, `took ${localStorage.writes - before} writes`);
  });

  test("a later save does not bring a released picture back as other art, and reload shows it unavailable", () => {
    const s = stub("a", 3);
    localStorage.limit = JSON.stringify([s]).length - 2500;
    store.upsertStub(s);
    const first = store.getStub("a");
    assert.ok(retention.artUnavailable(art(first, "v0")));
    store.upsertStub(versions.restoreVersion(first, "v0")); // restoring it keeps it unavailable, never invents art
    const again = store.getStub("a");
    assert.equal(again.currentVersionId, "v0");
    assert.ok(retention.artUnavailable(art(again, "v0")));
    assert.equal(art(again, "v0").src, undefined);
  });
});

describe("legacy walls and sync", () => {
  test("a wall written by the old silent drop reads as unavailable art, not as different art", () => {
    const legacy = stub("a", 2, "v1");
    legacy.versions[0].art = { kind: "procedural", seed: 0, provenance: "live" }; // what the old slim() left behind
    assert.equal(retention.artUnavailable(legacy.versions[0].art), true);
    assert.equal(retention.artUnavailable(legacy.versions[1].art), false);
    assert.equal(retention.artUnavailable({ kind: "procedural", seed: 1, provenance: "simulated" }), false);
    localStorage.setItem("ticketstub.wall.v1", JSON.stringify([legacy]));
    assert.equal(store.getStub("a").versions[0].art.kind, "procedural"); // loaded untouched: nothing migrated away
  });

  test("a released picture is filled back from a copy that still has it, and only by version id", () => {
    const full = stub("a", 3);
    const lost = retention.releaseOldest([full], 1)[0];
    const fixed = retention.retainArt(lost, full);
    assert.equal(fixed.versions[0].art.src, img("v0"));
    assert.equal(retention.retainArt(lost, { ...full, versions: [{ ...full.versions[0], id: "other" }] }), lost);
    assert.equal(retention.retainArt(full, lost), full, "a copy with its picture never takes the unavailable one");
  });

  test("an account sync does not give away a picture the account still has", () => {
    const full = stub("a", 3);
    full.updatedAt = 1;
    const remote = JSON.parse(JSON.stringify(full));
    remote.versions[0].art.src = "/api/files/" + "a".repeat(64) + ".png";
    const mine = { ...retention.releaseOldest([full], 1)[0], updatedAt: 2 };
    const merged = sync.foldWall([mine], [remote], [], 0);
    assert.equal(merged[0].versions[0].art.src, remote.versions[0].art.src);
    assert.ok(!retention.artUnavailable(merged[0].versions[0].art));
  });

  test("a photo version that lost its picture is labelled unavailable, never as 'Your photo'", () => {
    const released = { kind: "procedural", seed: 3, vibe: "photo", provenance: "sandbox", unavailable: true };
    const legacy = { kind: "procedural", seed: 3, vibe: "photo", provenance: "sandbox" };
    for (const a of [released, legacy]) {
      assert.equal(retention.artUnavailable(a), true);
      assert.deepEqual(versions.artLabel(a), { text: "Your photo, image not kept on this device (sample shown)", sample: true });
    }
    assert.deepEqual(versions.artLabel({ kind: "image", src: "/api/files/x.png", seed: 3, vibe: "photo", provenance: "sandbox" }), { text: "Your photo", sample: false });
  });

  test("retainArt never takes art from a different stub", () => {
    const a = stub("a", 3);
    const lost = retention.releaseOldest([a], 1)[0];
    const other = { ...stub("b", 3) };
    assert.equal(retention.retainArt(lost, other), lost);
  });
});
