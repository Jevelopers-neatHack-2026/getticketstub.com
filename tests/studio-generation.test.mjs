import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { beforeEach, describe, test } from "node:test";
import "./analytics-hooks.mjs";

// One shared art-generation lifecycle (issues #98 and #97). The editor owns ONE controller; deferred /api/art responses
// are resolved in either order against the real client, the real controller, the real local persistence (upsertStub)
// and the real account-sync merge. Nothing here reaches a network: fetch is a controllable in-memory fake.

class FakeStorage {
  mode = "ok"; // "ok" | "blocked"
  readFails = false; // reads throw (storage unavailable) while writes still work
  #m = new Map();
  getItem(k) {
    if (this.readFails) throw Object.assign(new Error("unreadable"), { name: "SecurityError" });
    return this.#m.has(k) ? this.#m.get(k) : null;
  }
  setItem(k, v) {
    if (this.mode === "blocked") throw Object.assign(new Error("blocked"), { name: "SecurityError" });
    this.#m.set(k, String(v));
  }
  removeItem(k) {
    this.#m.delete(k);
  }
  clear() {
    this.#m.clear();
  }
}
const localStorage = new FakeStorage();
globalThis.window = Object.assign(new EventTarget(), { localStorage, location: { origin: "https://x.example", hostname: "x.example", pathname: "/", search: "" } });
globalThis.localStorage = localStorage;

// ---- deferred /api/art ----
let calls = [];
// A tiny in-memory account for the REAL sync client (account/sync.ts syncNow): it records every upsert it is sent.
const account = { stubs: new Map(), upserts: [], syncs: 0, externalize: false };
const resetAccount = () => Object.assign(account, { stubs: new Map(), upserts: [], syncs: 0, externalize: false });
// What src/server/files.ts does on a real sync: every inline image becomes /api/files/<sha256 of the decoded bytes>.<ext>, the
// version id and updatedAt untouched.
const externalizeLikeServer = (v) =>
  typeof v === "string"
    ? (() => {
        const m = /^data:image\/(png|jpe?g|webp);base64,(.+)$/.exec(v);
        return m ? `/api/files/${createHash("sha256").update(Buffer.from(m[2], "base64")).digest("hex")}.${m[1] === "jpeg" ? "jpg" : m[1]}` : v;
      })()
    : Array.isArray(v)
      ? v.map(externalizeLikeServer)
      : v && typeof v === "object"
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, externalizeLikeServer(x)]))
        : v;
globalThis.fetch = (url, init = {}) => {
  if (String(url) === "/api/wall/sync") {
    const { stubs, deleted } = JSON.parse(init.body);
    account.syncs++;
    for (const id of deleted) account.stubs.delete(id);
    for (const s of stubs) {
      if (!deleted.includes(s.id)) {
        account.upserts.push(s.id);
        account.stubs.set(s.id, account.externalize ? externalizeLikeServer(s) : s);
      }
    }
    return Promise.resolve(new Response(JSON.stringify({ stubs: [...account.stubs.values()], deleted: [], now: Date.now() }), { status: 200, headers: { "content-type": "application/json" } }));
  }
  assert.equal(String(url), "/api/art", "only the art route and the account sync route are ever requested");
  return new Promise((resolve, reject) => {
    const call = { body: JSON.parse(init.body), signal: init.signal, settled: false };
    call.respond = (status, body) => {
      call.settled = true;
      resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
    };
    call.ok = (tag) => call.respond(200, { kind: "image", src: `/art/${tag}.webp`, seed: tag.length, provenance: "simulated" });
    init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    calls.push(call);
  });
};

const store = await import("../src/customer/studio/store.ts");
const ops = await import("../src/customer/studio/editor/ops.ts");
const { GenerationController, editorHost } = await import("../src/customer/studio/generation/operations.ts");
const { remixProducer } = await import("../src/customer/studio/generation/producers.ts");
const status = await import("../src/customer/studio/generation/status-store.ts");
const sync = await import("../src/customer/account/sync.ts");
const { currentVersion } = await import("../src/customer/studio/types.ts");

const fact = (id, value, kept = true) => ({ id, label: id, value, source: "setlist.fm", confidence: 0.95, provenance: "live", kept });
const makeStub = (id = "s1") => ({
  id,
  createdAt: "2026-10-01T00:00:00.000Z",
  event: { type: "concert", title: "Synthetic Night", facts: [fact("venue", "Hall A"), fact("date", "2026-11-01"), fact("seat", "Row 4", false)] },
  versions: [{ id: "v0", edition: "researched", art: { kind: "procedural", seed: 1, provenance: "simulated" }, createdAt: "2026-10-01T00:00:00.000Z" }],
  currentVersionId: "v0",
  personal: { titleFont: 0, titleColor: "", foilTitle: false, hiddenFields: [], friends: [] },
  material: "card",
  finish: "matte",
  torn: false,
  wallAngle: 0,
  photos: [],
});

/** The editor's commit path, as Editor.update does it: live ref, revision, then the real local save. */
function openEditor(id = "s1", { seed = true } = {}) {
  const ed = { stub: null, revision: 0, saved: [] };
  ed.update = (s, opts) => {
    ed.stub = s;
    ed.revision++;
    const stored = opts?.persist === false ? false : store.upsertStub(s);
    ed.saved.push(stored);
    return stored;
  };
  const initial = (seed ? store.getStub(id) : null) ?? makeStub(id);
  if (seed && !store.getStub(id)) store.upsertStub(initial);
  ed.stub = initial;
  const stubRef = { get current() { return ed.stub; } };
  const revRef = { get current() { return ed.revision; } };
  ed.gen = new GenerationController(editorHost(stubRef, revRef, ed.update, (sid) => store.loadDeleted().includes(sid), store.stubPresence), localStorage);
  ed.gen.attach();
  // the same observation the Editor wires: wall changes, other-tab storage events and account sync writes
  for (const ev of [store.WALL_CHANGED, sync.WALL_SYNCED, "storage"]) window.addEventListener(ev, ed.gen.observe);
  /** An entry point asks for art; resolves at a terminal phase. */
  ed.ask = (via = "sheet", fallback = "apply", vibe = undefined) => ed.gen.start({ via, vibe, fallback, run: remixProducer(via, vibe, "none") });
  return ed;
}
const tick = () => new Promise((r) => setImmediate(r));
const versionsOf = (s) => s.versions.map((v) => v.id);
const withoutArtFields = (s) => ({ ...s, versions: undefined, currentVersionId: undefined });

beforeEach(() => {
  localStorage.clear();
  localStorage.mode = "ok";
  localStorage.readFails = false;
  resetAccount();
  calls = [];
});

describe("deferred completion preserves edits (issue #98)", () => {
  test("every edit accepted while the request ran survives; only art changes", async () => {
    const ed = openEditor();
    const p = ed.ask("sheet");
    await tick();
    assert.equal(calls.length, 1);
    // the sheet is closed; the person keeps editing, each through the real editor commit
    ed.update(ops.setFactValue(ed.stub, "venue", "Hall B", "typo"));
    ed.update(ops.toggleKept(ed.stub, "seat"));
    ed.update(ops.setHidden(ed.stub, "date", true));
    ed.update(ops.setFont(ed.stub, 2));
    ed.update(ops.setTitleColour(ed.stub, "#E4572E"));
    ed.update(ops.toggleFoil(ed.stub));
    ed.update(ops.setMaterial(ed.stub, "print"));
    ed.update(ops.setFinish(ed.stub, "foil"));
    ed.update({ ...ed.stub, personal: { ...ed.stub.personal, note: "for Sam" } });
    const before = structuredClone(ed.stub);
    calls[0].ok("first");
    const { op } = await p;
    assert.equal(op.phase, "applied");
    assert.equal(op.saved, true);
    const after = ed.stub;
    assert.deepEqual(withoutArtFields(after), withoutArtFields(before), "nothing but art/version fields changed");
    assert.deepEqual(after.corrections, before.corrections, "correction history intact");
    assert.equal(after.event.facts.find((f) => f.id === "venue").value, "Hall B");
    assert.equal(after.versions.length, before.versions.length + 1);
    assert.deepEqual(versionsOf(after).slice(0, before.versions.length), versionsOf(before));
    const added = currentVersion(after);
    assert.equal(added.parentId, "v0");
    assert.equal(added.art.src, "/art/first.webp");
    assert.equal(added.context.material, "print", "the new version records the CURRENT material, not the request-time one");
    // the real persistence agrees, before and after a reload of the wall
    const reloaded = store.getStub("s1");
    assert.deepEqual(withoutArtFields(reloaded), { ...withoutArtFields(after), updatedAt: reloaded.updatedAt });
    assert.equal(reloaded.currentVersionId, after.currentVersionId);
  });

  test("a version added meanwhile is kept and the result is parented on the selection it was made for", async () => {
    const ed = openEditor();
    const p = ed.ask("note");
    await tick();
    ed.update(ops.addArtVersion(ed.stub, { kind: "procedural", seed: 9, provenance: "simulated" })); // e.g. a photo/procedural add meanwhile
    assert.notEqual(currentVersion(ed.stub).id, "v0");
    calls[0].ok("late");
    const { op } = await p;
    assert.equal(op.phase, "ready", "selection moved: held for review, never silently switched");
    assert.equal(ed.stub.versions.length, 2);
    assert.equal(store.getStub("s1").versions.length, 2);
  });
});

describe("changed selection is never silently switched (candidate + explicit Apply)", () => {
  test("changing the edition while pending keeps the edition; Apply is explicit and once", async () => {
    const ed = openEditor();
    const p = ed.ask("sheet");
    await tick();
    ed.update(ops.setEdition(ed.stub, "risograph"));
    const chosen = currentVersion(ed.stub).id;
    calls[0].ok("cand");
    const { op } = await p;
    assert.equal(op.phase, "ready");
    assert.equal(ed.stub.currentVersionId, chosen, "latest choice preserved");
    assert.equal(ed.stub.versions.length, 2, "no version added yet");
    assert.match(op.message, /not applied/i);
    const applied = ed.gen.apply(op.runId);
    assert.equal(applied.phase, "applied");
    assert.equal(ed.stub.versions.length, 3);
    const v = currentVersion(ed.stub);
    assert.equal(v.edition, "risograph", "result joins the CURRENT style, parented on the CURRENT version");
    assert.equal(v.parentId, chosen);
    ed.gen.apply(op.runId);
    assert.equal(ed.stub.versions.length, 3, "a second Apply is a no-op (at most once)");
    assert.equal(store.getStub("s1").versions.length, 3);
  });

  test("selecting history while pending, then discarding, changes nothing", async () => {
    const ed = openEditor();
    ed.update(ops.addArtVersion(ed.stub, { kind: "procedural", seed: 5, provenance: "simulated" }));
    const p = ed.ask("sheet");
    await tick();
    ed.update(ops.atVersion(ed.stub, "v0")); // history pick
    const picked = structuredClone(ed.stub);
    calls[0].ok("hist");
    const { op } = await p;
    assert.equal(op.phase, "ready");
    ed.gen.discard(op.runId);
    assert.equal(ed.gen.get("s1").phase, "discarded");
    assert.deepEqual(ed.stub, picked);
    assert.equal(ed.gen.apply(op.runId).phase, "discarded", "a discarded candidate cannot be applied later");
  });
});

describe("operation ownership, order and duplicates", () => {
  test("every operation has a unique run id with project, source version and revision", async () => {
    const ed = openEditor();
    ed.update(ops.setFont(ed.stub, 1));
    const a = ed.ask();
    await tick();
    const opA = ed.gen.get("s1");
    assert.match(opA.runId, /^gen-/);
    assert.equal(opA.stubId, "s1");
    assert.equal(opA.sourceVersionId, "v0");
    assert.equal(opA.sourceRevision, 1);
    ed.gen.cancel(opA.runId);
    await a;
    const b = ed.ask();
    await tick();
    assert.notEqual(ed.gen.get("s1").runId, opA.runId);
    calls[1].ok("b");
    await b;
  });

  for (const order of ["A then B", "B then A"]) {
    test(`A canceled, B dispatched, responses ${order}: only B applies and A never clears B's status`, async () => {
      const ed = openEditor();
      const a = ed.ask("sheet");
      await tick();
      const idA = ed.gen.get("s1").runId;
      ed.gen.cancel(idA); // dismiss/retry: A is superseded by an explicit new operation
      assert.equal((await a).op.phase, "canceled");
      assert.equal(calls[0].signal.aborted, true, "transport aborted");
      const b = ed.ask("note");
      await tick();
      const idB = ed.gen.get("s1").runId;
      assert.equal(calls.length, 2);
      const lateA = () => {
        if (!calls[0].settled) calls[0].ok("A");
      }; // a late/duplicate arrival of A's answer
      if (order === "A then B") {
        lateA();
        await tick();
        assert.equal(ed.gen.get("s1").runId, idB);
        assert.equal(ed.gen.get("s1").phase, "pending", "late A did not clear B's pending status");
        assert.equal(ed.stub.versions.length, 1);
        calls[1].ok("B");
      } else {
        calls[1].ok("B");
        await b;
        ed.update(ops.setFont(ed.stub, 3)); // a later edit
        lateA();
        await tick();
      }
      const { op } = await b;
      assert.equal(op.phase, "applied");
      assert.equal(ed.stub.versions.length, 2, "exactly one new version");
      assert.equal(currentVersion(ed.stub).art.src, "/art/B.webp");
      if (order === "B then A") assert.equal(ed.stub.personal.titleFont, 3);
      assert.equal(ed.gen.get("s1").runId, idB);
    });
  }

  test("a second request while one is pending is refused: no duplicate dispatch from any entry point", async () => {
    const ed = openEditor();
    const a = ed.ask("sheet");
    await tick();
    const dup = await ed.ask("note");
    const dup2 = await ed.ask("agent", "offer");
    assert.equal(dup.started, false);
    assert.equal(dup2.started, false);
    assert.equal(calls.length, 1);
    calls[0].ok("one");
    await a;
    assert.equal(ed.stub.versions.length, 2);
  });

  test("duplicate delivery of the same response applies once", async () => {
    const ed = openEditor();
    const p = ed.ask();
    await tick();
    calls[0].ok("dup");
    const { op } = await p;
    // a duplicate completion path (e.g. a retried delivery) has nothing pending to settle
    ed.gen.settle?.(op.runId, { art: { kind: "procedural", seed: 2 } });
    ed.gen.apply(op.runId);
    ed.gen.cancel(op.runId);
    assert.equal(ed.stub.versions.length, 2);
    assert.equal(ed.gen.get("s1").phase, "applied");
  });
});

describe("lifecycle: close/reopen, project switch, delete, unmount, reload", () => {
  test("closing and reopening panels never owns the request: the status is the controller's, not the panel's", async () => {
    const ed = openEditor();
    const p = ed.ask("sheet");
    await tick();
    const first = ed.gen.get("s1");
    // a reopened panel reads the same operation
    assert.equal(ed.gen.get("s1"), first);
    assert.equal((await ed.ask("sheet")).started, false);
    assert.equal(calls.length, 1);
    calls[0].ok("kept");
    await p;
    assert.equal(ed.gen.get("s1").phase, "applied");
  });

  test("cross-project: a response after the editor moved to another project cannot write to either", async () => {
    const ed = openEditor("s1");
    store.upsertStub(makeStub("s2"));
    const p = ed.ask();
    await tick();
    const s2Before = JSON.stringify(store.getStub("s2"));
    ed.stub = store.getStub("s2"); // the editor now holds another project (same host object)
    calls[0].ok("wrong");
    const { op } = await p;
    assert.equal(op.phase, "discarded");
    assert.equal(op.code, "project_changed");
    assert.equal(JSON.stringify(store.getStub("s2")), s2Before);
    assert.equal(store.getStub("s1").versions.length, 1);
  });

  test("project deleted while pending: the result cannot resurrect it", async () => {
    const ed = openEditor();
    const p = ed.ask();
    await tick();
    store.removeStub("s1");
    calls[0].ok("zombie");
    const { op } = await p;
    assert.equal(op.phase, "discarded");
    assert.equal(store.getStub("s1"), undefined);
    assert.deepEqual(store.loadWall().map((s) => s.id), []);
  });

  test("unmount (navigation away) interrupts honestly and the late response writes nothing", async () => {
    const ed = openEditor();
    const p = ed.ask();
    await tick();
    ed.gen.detach();
    assert.equal(calls[0].signal.aborted, true);
    if (!calls[0].settled) calls[0].ok("late");
    await tick();
    assert.equal(ed.gen.get("s1").phase, "interrupted");
    assert.equal(store.getStub("s1").versions.length, 1);
    await p;
    // reattach (Strict Mode re-run) does not resurrect the run
    ed.gen.attach();
    assert.equal(ed.gen.get("s1").phase, "interrupted");
  });

  test("reload while pending: the stored status becomes interrupted/unknown, never a resumed backend call", async () => {
    const ed = openEditor();
    ed.ask();
    await tick();
    const saved = JSON.parse(localStorage.getItem("ticketstub.generation.v1")).s1;
    assert.equal(saved.phase, "pending");
    assert.equal("art" in saved, false);
    const reopened = openEditor("s1"); // a fresh page: new controller over the same storage
    const op = reopened.gen.get("s1");
    assert.equal(op.phase, "interrupted");
    assert.match(op.message, /can't tell whether it finished/);
    assert.doesNotMatch(op.message, /\d\s*%|ETA|remaining/i);
    assert.equal(reopened.gen.canRetry(op.runId), false, "the request is not kept across a reload");
    assert.equal(calls.length, 1, "reload dispatched nothing");
    reopened.gen.dismiss(op.runId);
    assert.equal(openEditor("s1").gen.get("s1"), null);
  });

  test("a deleted project keeps no generation status", async () => {
    const ed = openEditor();
    ed.ask();
    await tick();
    store.removeStub("s1");
    assert.equal(status.loadStatus("s1", localStorage), null);
  });
});

describe("failure, quota fallback, storage failure, account sync", () => {
  test("failure keeps the draft and art, shows a saved failure, and Try again is an explicit NEW run", async () => {
    const ed = openEditor();
    const p = ed.ask();
    await tick();
    ed.update(ops.setFont(ed.stub, 2));
    const draft = structuredClone(ed.stub);
    calls[0].respond(500, { error: { code: "provider_unavailable", message: "The art service is unavailable." } });
    const { op } = await p;
    assert.equal(op.phase, "failed");
    assert.deepEqual(ed.stub, draft);
    assert.equal(JSON.parse(localStorage.getItem("ticketstub.generation.v1")).s1.phase, "failed", "failure survives a reload");
    assert.equal(openEditor("s1").gen.get("s1").phase, "failed");
    const retry = ed.gen.retry(op.runId);
    await tick();
    assert.equal(calls.length, 2);
    assert.notEqual(ed.gen.get("s1").runId, op.runId);
    calls[1].ok("again");
    assert.equal((await retry).op.phase, "applied");
  });

  test("daily limit: the sheet applies labelled procedural fallback; the agent only reports the limit", async () => {
    const ed = openEditor();
    const p = ed.ask("sheet", "apply");
    await tick();
    calls[0].respond(429, { error: { code: "art_limit" }, art: { kind: "procedural", seed: 7, provenance: "simulated" } });
    const { op } = await p;
    assert.equal(op.phase, "applied");
    assert.equal(op.fallback, true);
    assert.match(op.message, /No generated image was made/);
    assert.equal(currentVersion(ed.stub).art.kind, "procedural");

    const agent = ed.ask("agent", "offer");
    await tick();
    calls[1].respond(429, { error: { code: "art_limit" }, art: { kind: "procedural", seed: 8, provenance: "simulated" } });
    const r = await agent;
    assert.equal(r.op.phase, "failed");
    assert.equal(r.op.code, "art_limit");
    assert.equal(ed.stub.versions.length, 2, "nothing applied for the agent");
  });

  test("storage failure keeps the live draft and says it is not saved", async () => {
    const ed = openEditor();
    const p = ed.ask();
    await tick();
    localStorage.mode = "blocked";
    calls[0].ok("nosave");
    const { op } = await p;
    assert.equal(op.phase, "applied");
    assert.equal(op.saved, false);
    assert.match(op.message, /could not be saved on this device/);
    assert.equal(currentVersion(ed.stub).art.src, "/art/nosave.webp", "the open editor still holds it");
  });

  test("mock account sync: the stale request-time snapshot cannot be published or restored over the edited draft", async () => {
    const ed = openEditor();
    const snapshot = structuredClone(store.getStub("s1")); // what the account holds from before the request (older by the request's duration)
    const p = ed.ask();
    await tick();
    ed.update(ops.setFactValue(ed.stub, "venue", "Hall B"));
    ed.update(ops.setHidden(ed.stub, "date", true));
    calls[0].ok("sync");
    await p;
    const local = store.loadWall();
    const folded = sync.foldWall(local, [{ ...snapshot, updatedAt: (snapshot.updatedAt ?? 0) - 1000 }], [], Date.now());
    const s = folded.find((x) => x.id === "s1");
    assert.equal(s.event.facts.find((f) => f.id === "venue").value, "Hall B");
    assert.deepEqual(s.personal.hiddenFields, ["date"]);
    assert.equal(s.versions.length, 2);
    assert.equal(s.currentVersionId, ed.stub.currentVersionId);
  });
});

describe("truthful cancel and status copy", () => {
  test("Stop is local: it aborts the transport and never claims the provider cancelled", async () => {
    const ed = openEditor();
    const p = ed.ask();
    await tick();
    ed.gen.cancel(ed.gen.get("s1").runId);
    const { op } = await p;
    assert.equal(op.phase, "canceled");
    assert.match(op.message, /does not cancel the request on the art service/);
    assert.doesNotMatch(op.message, /provider (was )?cancel(l)?ed|cancelled by/i);
    assert.equal(ed.stub.versions.length, 1);
  });

  test("pending text has no percentage, ETA or edit-safety promise", async () => {
    const ed = openEditor();
    ed.ask();
    await tick();
    const text = ed.gen.get("s1").message;
    assert.match(text, /Generating new art/);
    assert.doesNotMatch(text, /%|ETA|seconds|safe/i);
  });
});

describe("one owner per project: an older run cannot supersede or write over the current one", () => {
  /** Count of local-save notifications the account sync listens to. */
  const watchWrites = () => {
    const n = { count: 0 };
    window.addEventListener(store.WALL_CHANGED, () => n.count++);
    return n;
  };
  /** A is ready (selection moved while it ran), then B is dispatched and pending. */
  async function readyAThenPendingB(ed) {
    const a = ed.ask("sheet");
    await tick();
    ed.update(ops.setEdition(ed.stub, "risograph")); // selection moves: A will be held
    calls[0].ok("A");
    const first = await a;
    assert.equal(first.op.phase, "ready");
    const b = ed.ask("agent", "offer");
    await tick();
    return { idA: first.op.runId, b };
  }
  const snapshot = (ed) => ({ draft: JSON.stringify(ed.stub), wall: localStorage.getItem("ticketstub.wall.v1"), saves: ed.saved.length });

  test("ready A -> pending B -> stale Apply A: zero draft, storage and sync writes; B then succeeds exactly once", async () => {
    const ed = openEditor();
    const writes = watchWrites();
    const { idA, b } = await readyAThenPendingB(ed);
    const idB = ed.gen.get("s1").runId;
    assert.notEqual(idB, idA);
    assert.equal(ed.gen.all().find((o) => o.runId === idA).phase, "discarded", "A was deliberately retired");
    assert.equal(ed.gen.all().find((o) => o.runId === idA).code, "superseded");
    const before = snapshot(ed);
    const w0 = writes.count;
    const res = ed.gen.apply(idA);
    assert.equal(res.phase, "discarded");
    assert.deepEqual(snapshot(ed), before, "no draft change, no local save");
    assert.equal(writes.count, w0, "no wall-changed notification, so nothing for the account sync to publish");
    assert.equal(ed.gen.get("s1").runId, idB);
    assert.equal(ed.gen.get("s1").phase, "pending", "A did not displace B");
    calls[1].ok("B");
    const done = await b;
    assert.equal(done.op.phase, "applied");
    assert.equal(ed.stub.versions.length, 3, "A's version never added; B's added once");
    assert.equal(currentVersion(ed.stub).art.src, "/art/B.webp");
    ed.gen.apply(idB);
    ed.gen.apply(idA);
    assert.equal(ed.stub.versions.length, 3, "duplicates change nothing");
    assert.equal(store.getStub("s1").versions.length, 3);
  });

  test("the supplied negative: A ready, B pending, apply(A) commits nothing", async () => {
    let stub = { ...makeStub("neg"), versions: [{ id: "v0", edition: "researched", art: { kind: "procedural", seed: 1 }, createdAt: "2026-10-12T00:00:00Z" }, { id: "v1", edition: "researched", art: { kind: "procedural", seed: 2 }, createdAt: "2026-10-12T00:00:00Z" }] };
    let commits = 0;
    let resolveB;
    const c = new GenerationController({ current: () => stub, revision: () => 0, isGone: () => false, commit: (s) => ((stub = s), commits++, true) }, localStorage);
    c.attach();
    const a = c.start({ via: "sheet", run: async () => ({ art: { kind: "procedural", seed: 11 } }) });
    stub = { ...stub, currentVersionId: "v1" };
    const first = await a;
    assert.equal(first.op.phase, "ready");
    const b = c.start({ via: "agent", run: () => new Promise((r) => (resolveB = r)) });
    const before = commits;
    c.apply(first.op.runId);
    assert.equal(commits - before, 0);
    assert.equal(c.get("neg").phase, "pending");
    resolveB({ art: { kind: "procedural", seed: 12 } });
    assert.equal((await b).op.phase, "applied", "B was dispatched on the current selection, so it applies");
    assert.equal(commits, 1, "B committed exactly once; A never");
    assert.equal(stub.versions.length, 3);
  });

  test("stale Retry A while B is pending or ready is ignored: no request, B untouched", async () => {
    const ed = openEditor();
    const a = ed.ask("sheet");
    await tick();
    calls[0].respond(500, { error: { code: "provider_unavailable", message: "down" } });
    const idA = (await a).op.runId;
    assert.equal(ed.gen.canRetry(idA), true);
    const b = ed.ask("note"); // explicit new operation replaces A's failed status
    await tick();
    const idB = ed.gen.get("s1").runId;
    assert.equal(ed.gen.canRetry(idA), false);
    assert.equal(ed.gen.retry(idA), null, "B pending");
    assert.equal(calls.length, 2);
    ed.update(ops.setEdition(ed.stub, "minimal")); // move selection so B becomes ready
    calls[1].ok("B");
    assert.equal((await b).op.phase, "ready");
    assert.equal(ed.gen.retry(idA), null, "B ready");
    assert.equal(calls.length, 2, "no new request");
    assert.equal(ed.gen.get("s1").runId, idB);
    assert.equal(ed.gen.get("s1").phase, "ready");
    assert.equal(ed.gen.apply(idB).phase, "applied", "B's explicit Apply still works, once");
    ed.gen.apply(idB);
    assert.equal(ed.stub.versions.length, 3);
  });

  test("late callbacks of retired runs (cancel, discard, dismiss, apply) cannot disturb the current one, in any order", async () => {
    for (const order of [["apply", "discard", "cancel", "dismiss"], ["dismiss", "cancel", "discard", "apply"]]) {
      localStorage.clear();
      calls = [];
      const ed = openEditor();
      const { idA, b } = await readyAThenPendingB(ed);
      const idB = ed.gen.get("s1").runId;
      const before = snapshot(ed);
      for (const m of order) ed.gen[m](idA);
      assert.deepEqual(snapshot(ed), before);
      assert.equal(ed.gen.get("s1").runId, idB);
      assert.equal(ed.gen.get("s1").phase, "pending");
      assert.equal(calls[1].signal.aborted, false, "B's transport untouched");
      calls[1].ok("B");
      assert.equal((await b).op.phase, "applied");
      assert.equal(ed.stub.versions.length, 3, "B applied once");
    }
  });

  test("A and B completions in either order; project, selection, history and edits are preserved", async () => {
    for (const bFirst of [true, false]) {
      localStorage.clear();
      calls = [];
      const ed = openEditor();
      ed.update(ops.setFont(ed.stub, 2));
      const { idA, b } = await readyAThenPendingB(ed);
      ed.update(ops.setHidden(ed.stub, "date", true)); // an edit while B is pending
      const chosen = ed.stub.currentVersionId;
      const hist = versionsOf(ed.stub);
      if (bFirst) calls[1].ok("B");
      ed.gen.apply(idA);
      if (!bFirst) calls[1].ok("B");
      const { op } = await b;
      assert.equal(op.phase, "applied", "selection unchanged since B started, so B applies");
      assert.equal(ed.stub.personal.titleFont, 2);
      assert.deepEqual(ed.stub.personal.hiddenFields, ["date"]);
      assert.deepEqual(versionsOf(ed.stub).slice(0, hist.length), hist, "history kept in order");
      assert.equal(ed.stub.versions.length, hist.length + 1);
      assert.equal(currentVersion(ed.stub).parentId, chosen);
      assert.equal(store.getStub("s1").versions.length, hist.length + 1);
      assert.deepEqual(store.loadWall().map((s) => s.id), ["s1"]);
    }
  });
});

describe("photo art uses the same lifecycle with photo-truthful outcomes", () => {
  const photo = (ed, run) => ed.gen.start({ via: "photo", fallback: "apply", run });
  const read = () => {
    const d = {};
    d.promise = new Promise((resolve, reject) => ((d.resolve = resolve), (d.reject = reject)));
    return d;
  };
  test("pending and Stop talk about the photo, never an art service; no art request is made", async () => {
    const ed = openEditor();
    const r = read();
    const p = photo(ed, () => r.promise);
    await tick();
    const pending = ed.gen.get("s1");
    assert.match(pending.message, /photo/i);
    assert.doesNotMatch(pending.message, /art service|Generating new art/i);
    ed.gen.cancel(pending.runId);
    const { op } = await p;
    assert.match(op.message, /photo/i);
    assert.doesNotMatch(op.message, /art service|provider/i);
    r.resolve({ art: { kind: "image", src: "data:image/png;base64,AAAA", vibe: "photo", seed: 1, provenance: "live" } });
    await tick();
    assert.equal(ed.stub.versions.length, 1, "late read after Stop writes nothing");
    assert.equal(calls.length, 0, "a photo never calls the art route");
  });

  test("photo completion keeps edits; changed selection waits for explicit Apply; a pending art request blocks a photo (one lifecycle)", async () => {
    const ed = openEditor();
    const art = ed.ask("sheet");
    await tick();
    const dup = await photo(ed, async () => ({ art: { kind: "image", src: "data:x", vibe: "photo", seed: 2 } }));
    assert.equal(dup.started, false);
    assert.equal(calls.length, 1);
    ed.gen.cancel(ed.gen.get("s1").runId);
    await art;
    const r = read();
    const p = photo(ed, () => r.promise);
    await tick();
    ed.update(ops.setMaterial(ed.stub, "framed"));
    ed.update(ops.setEdition(ed.stub, "minimal"));
    r.resolve({ art: { kind: "image", src: "data:image/png;base64,BBBB", vibe: "photo", seed: 3, provenance: "live" } });
    const { op } = await p;
    assert.equal(op.phase, "ready");
    assert.equal(ed.stub.versions.length, 2);
    assert.equal(ed.gen.apply(op.runId).phase, "applied");
    assert.equal(ed.stub.material, "framed");
    assert.equal(currentVersion(ed.stub).art.vibe, "photo");
    assert.equal(store.getStub("s1").versions.length, 3);
  });

  test("an unreadable photo fails honestly and leaves the draft", async () => {
    const ed = openEditor();
    const before = JSON.stringify(ed.stub);
    const { op } = await photo(ed, async () => {
      throw new Error("We couldn't read that photo. Try another one.");
    });
    assert.equal(op.phase, "failed");
    assert.match(op.message, /couldn't read that photo/);
    assert.equal(JSON.stringify(ed.stub), before);
  });
});

describe("an observed removal retires operations for good, independent of the outbound deletion queue (PR100-ASTRA-001)", () => {
  /** Sign-in has pushed the project; the other tab takes it down; the REAL sync client acknowledges and clears the queue. */
  async function signedInThenDeletedElsewhere(ed, { restore = false } = {}) {
    await sync.syncNow();
    assert.equal(account.stubs.has("s1"), true);
    store.removeStub("s1"); // the wall's "Take it down" (writes the wall and queues the deletion)
    window.dispatchEvent(new Event("storage")); // what this tab hears from the other tab's write
    await sync.syncNow(); // the real client sends the tombstone, the account drops the project, the queue is cleared
    assert.deepEqual(store.loadDeleted(), [], "the acknowledged deletion queue is empty");
    assert.equal(account.stubs.has("s1"), false, "the account confirms the project is absent");
    assert.equal(store.getStub("s1"), undefined);
    if (restore) {
      store.upsertStub(makeStub("s1")); // a legitimate re-create/import under the SAME id
      window.dispatchEvent(new Event("storage"));
    }
  }

  test("pending run + deletion acknowledged by real sync: late completion cannot resurrect local, account or versions", async () => {
    const ed = openEditor();
    const p = ed.ask("sheet");
    await tick();
    await signedInThenDeletedElsewhere(ed);
    const upserts = account.upserts.length;
    const saves = ed.saved.length;
    const r = (calls[0].ok("late"), await p);
    assert.equal(r.op.phase, "discarded");
    assert.equal(r.op.code, "project_removed");
    assert.equal(store.getStub("s1"), undefined, "no local resurrection");
    assert.deepEqual(store.loadWall(), []);
    assert.equal(ed.saved.length, saves, "no editor commit at all");
    await sync.syncNow();
    assert.equal(account.upserts.length, upserts, "no upsert was dispatched to the account");
    assert.equal(account.stubs.has("s1"), false, "no server resurrection");
    assert.equal(calls[0].signal.aborted, true, "transport aborted (no provider-cancel claim)");
    assert.doesNotMatch(r.op.message, /provider|cancel/i);
    assert.equal(JSON.stringify(ed.stub).includes("late.webp"), false, "the open draft was not changed to hide the race");
  });

  test("the same, with the deletion acknowledged BEFORE the response is even released, and the id restored", async () => {
    const ed = openEditor();
    const p = ed.ask("note");
    await tick();
    await signedInThenDeletedElsewhere(ed, { restore: true });
    const restored = JSON.stringify(store.getStub("s1"));
    calls[0].ok("late2");
    const { op } = await p;
    assert.equal(op.phase, "discarded");
    assert.equal(JSON.stringify(store.getStub("s1")), restored, "the restored project is not touched by the old run");
    assert.equal(store.getStub("s1").versions.length, 1);
  });

  test("a READY candidate: deletion acknowledged, then Apply, retry, new start and every retained callback are inert", async () => {
    const ed = openEditor();
    const a = ed.ask("sheet");
    await tick();
    ed.update(ops.setEdition(ed.stub, "risograph")); // selection moves: A is held as ready
    calls[0].ok("A");
    const first = await a;
    assert.equal(first.op.phase, "ready");
    await signedInThenDeletedElsewhere(ed, { restore: true });
    const before = JSON.stringify(store.loadWall());
    const upserts = account.upserts.length;
    const n = calls.length;
    assert.equal(ed.gen.apply(first.op.runId).phase, "discarded");
    assert.equal(ed.gen.retry(first.op.runId), null);
    const again = await ed.ask("agent", "offer"); // a brand-new request in the stale open draft
    assert.equal(again.started, false);
    assert.equal(again.op.code, "project_removed");
    assert.equal(calls.length, n, "no art request for a removed project");
    for (const m of ["discard", "cancel", "dismiss", "apply"]) ed.gen[m](first.op.runId);
    assert.equal(JSON.stringify(store.loadWall()), before, "no localStorage change");
    await sync.syncNow();
    // the legitimately re-created project syncs as itself (one upsert at most); nothing the old run made reaches the account
    assert.ok(account.upserts.length - upserts <= 1);
    assert.equal(account.stubs.get("s1").versions.length, 1, "the account holds the restored project, not the generated art");
    assert.equal(JSON.stringify(account.stubs.get("s1")).includes("A.webp"), false);
  });

  test("a deletion seen by a purely LOCAL save path (no account, no event helper) is observed at the guard too", async () => {
    const ed = openEditor();
    const p = ed.ask("photo" === "x" ? "sheet" : "sheet");
    await tick();
    store.removeStub("s1");
    store.saveDeleted([]); // the queue is emptied by whatever means
    calls[0].ok("quiet");
    assert.equal((await p).op.phase, "discarded");
    assert.equal(store.getStub("s1"), undefined);
  });

  test("unknown storage is honest: never 'deleted', never an unsafe write; Apply changes the open editor only", async () => {
    const ed = openEditor();
    const other = makeStub("keep");
    store.upsertStub(other);
    const p = ed.ask("sheet");
    await tick();
    localStorage.readFails = true; // storage became unreadable (writes would still work)
    calls[0].ok("held");
    const { op } = await p;
    assert.equal(op.phase, "ready", "held for review rather than written blindly");
    assert.notEqual(op.code, "project_removed");
    assert.match(op.message, /can't be read/);
    assert.equal(ed.stub.versions.length, 1, "open draft untouched");
    const applied = ed.gen.apply(op.runId);
    assert.equal(applied.phase, "applied");
    assert.equal(applied.saved, false);
    assert.match(applied.message, /NOT saved/);
    assert.equal(ed.stub.versions.length, 2, "the open editor has it");
    localStorage.readFails = false;
    assert.ok(store.getStub("keep"), "other projects were not overwritten");
    assert.equal(store.getStub("s1").versions.length, 1, "nothing was persisted for the unreadable moment");
    ed.gen.apply(op.runId);
    assert.equal(ed.stub.versions.length, 2, "at most once");
  });

  test("write failure and quota on a valid project still apply at most once with the draft kept and an unsaved warning", async () => {
    const ed = openEditor();
    const p = ed.ask();
    await tick();
    localStorage.mode = "blocked";
    calls[0].ok("nosave2");
    const { op } = await p;
    assert.equal(op.phase, "applied");
    assert.equal(op.saved, false);
    assert.match(op.message, /could not be saved on this device/);
    ed.gen.apply(op.runId);
    assert.equal(ed.stub.versions.length, 2);
  });

  test("legitimate flows keep working: a freshly opened editor on a restored or new project applies art once; old versions unchanged", async () => {
    const ed = openEditor();
    const oldVersions = JSON.stringify(ed.stub.versions);
    await signedInThenDeletedElsewhere(ed, { restore: true });
    const ed2 = openEditor("s1"); // a new editor session on the restored project
    const p = ed2.ask("sheet");
    await tick();
    calls[calls.length - 1].ok("fresh");
    assert.equal((await p).op.phase, "applied");
    const s1 = store.getStub("s1");
    assert.equal(s1.versions.length, 2);
    assert.equal(JSON.stringify(s1.versions.slice(0, 1)), oldVersions, "the immutable older version is byte-equal");
    const created = openEditor("brand-new");
    const q = created.ask("note");
    await tick();
    calls[calls.length - 1].ok("new");
    assert.equal((await q).op.phase, "applied");
    assert.equal(store.getStub("brand-new").versions.length, 2);
  });
});

describe("boundary repairs: first-observation unknown, and a removal that restoration hides (PR100-ASTRA-002/003)", () => {
  const restoredStub = (id = "s1") => ({ ...makeStub(id), event: { ...makeStub(id).event, title: "Restored independent draft" }, versions: [{ ...makeStub(id).versions[0], id: "restored-v0" }], currentVersionId: "restored-v0" });

  test("unknown storage at the very FIRST observation holds the result, writes nothing and erases no other project", async () => {
    const ed0 = openEditor();
    store.upsertStub(makeStub("other"));
    const live = store.getStub("s1");
    localStorage.readFails = true; // unreadable before the controller ever observes the project
    const writes = { n: 0 };
    const orig = localStorage.setItem.bind(localStorage);
    localStorage.setItem = (k, v) => ((k === "ticketstub.wall.v1" && writes.n++, orig(k, v)));
    const ed = { stub: live, saves: 0 };
    const g = new GenerationController(editorHost({ get current() { return ed.stub; } }, { current: 0 }, (s) => ((ed.stub = s), ed.saves++, store.upsertStub(s)), (id) => store.loadDeleted().includes(id), store.stubPresence), localStorage);
    g.attach();
    const r = await g.start({ via: "sheet", run: async () => ({ art: { kind: "procedural", seed: 9, provenance: "simulated" } }) });
    localStorage.setItem = orig;
    localStorage.readFails = false;
    assert.equal(r.op.phase, "ready");
    assert.equal(ed.saves, 0, "no commit at all");
    assert.equal(writes.n, 0, "no wall write was even attempted");
    assert.ok(store.getStub("other"), "the unrelated project survives");
    assert.ok(store.getStub("s1"));
    void ed0;
  });

  test("the typed store write refuses an unreadable wall instead of erasing it (upsertStub)", () => {
    store.upsertStub(makeStub("a"));
    store.upsertStub(makeStub("b"));
    localStorage.readFails = true;
    assert.equal(store.upsertStub(makeStub("c")), false, "reported unsaved");
    localStorage.readFails = false;
    assert.deepEqual(store.loadWall().map((s) => s.id).sort(), ["a", "b"], "nothing was erased and nothing half-written");
  });

  test("malformed storage is unknown, never absent; a never-seen project in a writable store still works", async () => {
    const ed = openEditor();
    localStorage.setItem("ticketstub.wall.v1", "{not json");
    assert.equal(store.stubPresence("s1"), "unknown");
    const p = ed.ask();
    await tick();
    calls[0].ok("m");
    assert.equal((await p).op.phase, "ready", "malformed wall: held, not 'deleted' and not written");
    localStorage.clear();
    store.upsertStub(makeStub("s1"));
    const fresh = openEditor("s1");
    const q = fresh.ask();
    await tick();
    calls[calls.length - 1].ok("ok");
    assert.equal((await q).op.phase, "applied");
  });

  /** What the paused editor will be handed later: removal then restoration, as two queued storage events. */
  function queuedDeleteThenRestore(ed) {
    const key = "ticketstub.wall.v1";
    const before = localStorage.getItem(key);
    const other = store.getStub("keep") ?? makeStub("keep");
    localStorage.setItem(key, JSON.stringify([other])); // peer removes the project
    const removedValue = localStorage.getItem(key);
    localStorage.setItem(key, JSON.stringify([restoredStub(), other])); // and restores the same id before this tab handles anything
    const restoredValue = localStorage.getItem(key);
    const events = [
      { key, oldValue: before, newValue: removedValue },
      { key, oldValue: removedValue, newValue: restoredValue },
    ];
    return () => {
      for (const e of events) ed.gen.observeTransition((id) => store.wallPresenceFromValue(e.newValue, id));
    };
  }

  test("queued removal + same-id restore: the event payload keeps the removal; old run and retained callbacks stay invalid", async () => {
    const ed = openEditor();
    store.upsertStub(makeStub("keep"));
    const a = ed.ask("note");
    await tick();
    const idA = ed.gen.get("s1").runId;
    const deliver = queuedDeleteThenRestore(ed);
    assert.equal(store.getStub("s1").event.title, "Restored independent draft", "by delivery time the id is already restored");
    deliver();
    calls[0].ok("late");
    const { op } = await a;
    assert.equal(op.phase, "discarded");
    assert.equal(store.getStub("s1").event.title, "Restored independent draft", "the restored project was not overwritten");
    assert.deepEqual(store.getStub("s1").versions.map((v) => v.id), ["restored-v0"]);
    for (const m of ["apply", "discard", "cancel", "dismiss"]) ed.gen[m](idA);
    assert.equal(ed.gen.retry(idA), null);
    assert.equal((await ed.ask("agent", "offer")).started, false, "an old editor session cannot start new work on the restored id");
    // a genuinely new editor session on the restored project generates normally
    const fresh = openEditor("s1");
    const q = fresh.ask("sheet");
    await tick();
    calls[calls.length - 1].ok("fresh");
    assert.equal((await q).op.phase, "applied");
    assert.deepEqual(store.getStub("s1").versions.map((v) => v.id).slice(0, 1), ["restored-v0"], "older immutable version unchanged");
    assert.ok(store.getStub("keep"), "the unrelated project is preserved throughout");
  });

  test("even with NO event delivered, a restored (different) project is detected at the write and never overwritten", async () => {
    const live = openEditor().stub;
    const box = { stub: live };
    // a bare controller: no observer is wired, so only the write-time check can notice
    const g = new GenerationController(editorHost({ get current() { return box.stub; } }, { current: 0 }, (s) => ((box.stub = s), store.upsertStub(s)), (id) => store.loadDeleted().includes(id), store.stubPresence), localStorage);
    g.attach();
    let release;
    const a = g.start({ via: "sheet", run: () => new Promise((r) => (release = r)) });
    store.removeStub("s1");
    store.saveDeleted([]);
    store.upsertStub(restoredStub());
    release({ art: { kind: "procedural", seed: 3, provenance: "simulated" } });
    const { op } = await a;
    assert.equal(op.phase, "discarded");
    assert.equal(op.code, "project_changed");
    assert.deepEqual(store.getStub("s1").versions.map((v) => v.id), ["restored-v0"]);
  });

});

describe("version history is reconciled, never dropped (PR100-ASTRA-004 / 005)", () => {
  const peerVersion = { id: "peer-v1", parentId: "v0", edition: "researched", art: { kind: "image", src: "/api/files/peer-bytes.png", seed: 5, vibe: "peer", provenance: "live" }, createdAt: "2026-10-02T00:00:00.000Z", context: { material: "card", finish: "matte", keptFacts: [], personal: { titleFont: 0, titleColor: "", foilTitle: false, hiddenFields: [] } } };
  const withPeer = (s0, extra = {}) => ({ ...s0, versions: [...s0.versions, peerVersion], ...extra });
  const ids = (s0) => s0.versions.map((v) => v.id);

  test("a peer version saved BEFORE the old result survives: stored, live, account and reload all keep its exact body", async () => {
    const ed = openEditor();
    await sync.syncNow();
    const p = ed.ask("sheet");
    await tick();
    store.upsertStub(withPeer(store.getStub("s1"))); // another editor saved a version; the project was not removed
    calls[0].ok("late");
    const { op } = await p;
    assert.equal(op.phase, "applied");
    const stored = store.getStub("s1");
    const added = ids(stored).filter((id) => id !== "v0" && id !== "peer-v1");
    assert.equal(stored.versions.length, 3);
    assert.equal(added.length, 1, "exactly one new version besides v0 and the peer's");
    assert.deepEqual(stored.versions.find((v) => v.id === "peer-v1"), peerVersion, "the peer's version body is byte-equal");
    assert.deepEqual(stored.versions.find((v) => v.id === "v0"), makeStub("s1").versions[0]);
    assert.equal(stored.currentVersionId, added[0], "selection is this editor's new art");
    assert.ok(ed.stub.versions.some((v) => v.id === "peer-v1"), "the open editor also holds the peer version");
    await sync.syncNow();
    assert.deepEqual(account.stubs.get("s1").versions.map((v) => v.id), ids(stored), "the account copy keeps the peer version too");
    assert.deepEqual(account.stubs.get("s1").versions.find((v) => v.id === "peer-v1"), peerVersion);
  });

  test("a peer that SELECTED its own version is never silently switched: held for an explicit Apply that keeps both", async () => {
    const ed = openEditor();
    const p = ed.ask("note");
    await tick();
    store.upsertStub(withPeer(store.getStub("s1"), { currentVersionId: "peer-v1" }));
    const before = JSON.stringify(store.getStub("s1"));
    calls[0].ok("held");
    const { op } = await p;
    assert.equal(op.phase, "ready");
    assert.equal(op.code, "peer_selected");
    assert.equal(JSON.stringify(store.getStub("s1")), before, "nothing was written");
    assert.equal(ed.gen.apply(op.runId).phase, "applied");
    const stored = store.getStub("s1");
    assert.equal(stored.versions.length, 3);
    assert.deepEqual(stored.versions.find((v) => v.id === "peer-v1"), peerVersion);
    ed.gen.apply(op.runId);
    assert.equal(store.getStub("s1").versions.length, 3, "at most once");
  });

  test("the same version id with a different body is a typed conflict: nothing merged, nothing written, no fake success", async () => {
    const ed = openEditor();
    const p = ed.ask("sheet");
    await tick();
    const stored = store.getStub("s1");
    store.upsertStub({ ...stored, versions: [{ ...stored.versions[0], art: { kind: "image", src: "/api/files/other.png", seed: 99, provenance: "live" } }] });
    const before = JSON.stringify(store.getStub("s1"));
    const draft = JSON.stringify(ed.stub);
    calls[0].ok("conflict");
    const { op } = await p;
    assert.equal(op.phase, "discarded");
    assert.equal(op.code, "version_conflict");
    assert.match(op.message, /can't be merged safely/);
    assert.equal(JSON.stringify(store.getStub("s1")), before);
    assert.equal(JSON.stringify(ed.stub), draft);
  });

  test("after a write failure the editor's own unsaved version is NOT a replacement: the next generation applies and recovers persistence", async () => {
    const ed = openEditor();
    localStorage.mode = "blocked";
    const first = ed.ask("sheet");
    await tick();
    calls[0].ok("first");
    const a = await first;
    assert.equal(a.op.phase, "applied");
    assert.equal(a.op.saved, false);
    assert.equal(store.getStub("s1").versions.length, 1, "storage has only v0");
    const unsavedBody = JSON.parse(JSON.stringify(ed.stub.versions[1]));
    localStorage.mode = "ok";
    const second = ed.ask("note");
    await tick();
    assert.equal(ed.gen.get("s1").phase, "pending", "the next request is dispatched, not discarded");
    calls[calls.length - 1].ok("second");
    const r = await second;
    assert.equal(r.op.phase, "applied");
    assert.notEqual(r.op.code, "project_changed");
    const stored = store.getStub("s1");
    assert.equal(stored.versions.length, 3, "v0, the earlier unsaved art and the new art are all persisted now");
    assert.deepEqual(stored.versions[1], unsavedBody, "the previously unsaved version body is persisted unchanged");
    assert.equal(r.op.saved, true);
    // and a third generation still works: nothing was latched removed
    const third = ed.ask("note");
    await tick();
    calls[calls.length - 1].ok("third");
    assert.equal((await third).op.phase, "applied");
    assert.equal(store.getStub("s1").versions.length, 4);
  });

  test("memory-only Apply on an unreadable store, then recovery: the next generation persists the whole history", async () => {
    const ed = openEditor();
    const p = ed.ask("sheet");
    await tick();
    localStorage.readFails = true;
    calls[0].ok("held");
    const { op } = await p;
    assert.equal(op.phase, "ready");
    assert.equal(ed.gen.apply(op.runId).saved, false);
    const memOnly = JSON.parse(JSON.stringify(ed.stub.versions[1]));
    localStorage.readFails = false;
    assert.equal(store.getStub("s1").versions.length, 1);
    const next = ed.ask("agent", "offer");
    await tick();
    calls[calls.length - 1].ok("again");
    const r = await next;
    assert.equal(r.op.phase, "applied");
    assert.equal(r.op.saved, true);
    assert.deepEqual(store.getStub("s1").versions[1], memOnly);
    assert.equal(store.getStub("s1").versions.length, 3);
  });

  test("own unsaved history AND a peer's saved version are both kept in one commit", async () => {
    const ed = openEditor();
    localStorage.mode = "blocked";
    const first = ed.ask("sheet");
    await tick();
    calls[0].ok("own");
    await first;
    localStorage.mode = "ok";
    store.upsertStub(withPeer(store.getStub("s1")));
    const second = ed.ask("sheet");
    await tick();
    calls[calls.length - 1].ok("both");
    assert.equal((await second).op.phase, "applied");
    const stored = store.getStub("s1");
    assert.equal(stored.versions.length, 4);
    assert.ok(stored.versions.some((v) => v.id === "peer-v1"));
    assert.ok(ed.stub.versions.every((v) => stored.versions.some((w) => w.id === v.id)), "every version the editor had is stored");
  });

  test("strict upsert: malformed or non-list storage is never replaced by a one-project wall", () => {
    for (const raw of ["{not json", '{"a":1}', '"text"']) {
      localStorage.clear();
      localStorage.setItem("ticketstub.wall.v1", raw);
      assert.equal(store.upsertStub(makeStub("x")), false, `reported unsaved for ${raw}`);
      assert.equal(localStorage.getItem("ticketstub.wall.v1"), raw, "the unknown content is untouched");
    }
    localStorage.clear();
    localStorage.setItem("ticketstub.wall.v1", JSON.stringify([makeStub("keep")]));
    assert.equal(store.upsertStub(makeStub("x")), true, "a valid wall is merged");
    assert.match(localStorage.getItem("ticketstub.wall.v1"), /"id":"keep"/, "the unrelated project is preserved");
  });
});

const identity = await import("../src/customer/studio/generation/art-identity.ts");
const reconcile = await import("../src/customer/studio/generation/reconcile.ts");

describe("a server-externalized picture is the same body, not a conflict (PR100-OPUS-001)", () => {
  const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8Dwn4GBgYGJAQoAHhgCAh6X4CYAAAAASUVORK5CYII=";
  const PNG2_B64 = PNG_B64.slice(0, -6) + "AAAAAA";
  const JPG_B64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]).toString("base64");
  const png = `data:image/png;base64,${PNG_B64}`;
  const jpg = `data:image/jpeg;base64,${JPG_B64}`;
  const nameOf = (b64, ext) => `/api/files/${createHash("sha256").update(Buffer.from(b64, "base64")).digest("hex")}.${ext}`;

  test("the synchronous SHA-256 equals node's for every padding boundary and a large buffer", () => {
    for (const n of [0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 1000, 100000]) {
      const b = Buffer.alloc(n, 0x61 + (n % 7));
      assert.equal(identity.sha256Hex(new Uint8Array(b)), createHash("sha256").update(b).digest("hex"), `len ${n}`);
    }
  });

  test("the file name derived from inline bytes is the server's (sha256 + sniffed type); wrong or refusable input has none", () => {
    assert.equal(`/api/files/${identity.dataUrlFileName(png)}`, nameOf(PNG_B64, "png"));
    assert.equal(`/api/files/${identity.dataUrlFileName(jpg)}`, nameOf(JPG_B64, "jpg"));
    assert.equal(identity.dataUrlFileName(`data:image/jpeg;base64,${PNG_B64}`), null, "declared type must match the bytes");
    assert.equal(identity.dataUrlFileName("data:image/png;base64,AAAAAAAA"), null, "not a PNG: the server refuses it");
    assert.equal(identity.dataUrlFileName("data:text/plain;base64,AAAA"), null);
    assert.equal(identity.dataUrlFileName("data:image/png;base64,!!!"), null);
  });

  test("comparison matrix: same bytes are same; other bytes, other names and caller-supplied references are not", () => {
    const rel = identity.compareArtSrc;
    assert.equal(rel(png, nameOf(PNG_B64, "png")), "same");
    assert.equal(rel(nameOf(PNG_B64, "png"), png), "same", "symmetric");
    assert.equal(rel(png, nameOf(PNG2_B64, "png")), "different", "a server-named file of OTHER bytes is provably different");
    assert.equal(rel(png, png), "same");
    assert.equal(rel("/art/a.webp", "/art/b.webp"), "different");
    assert.equal(rel(png, "/art/a.webp"), "different");
    assert.equal(rel(png, "/api/files/not-a-server-name.png"), "unverifiable", "a reference the server never produces is not trusted either way");
    assert.equal(rel(png, "/api/files/abcdef0123456789.png"), "unverifiable");
    assert.equal(rel("data:image/png;base64,AAAAAAAA", nameOf(PNG_B64, "png")), "unverifiable", "an inline picture the server would refuse");
    assert.equal(rel(undefined, png), "different");
  });

  const sheetVersion = (id, art) => ({ id, parentId: "v0", edition: "researched", art, createdAt: "2026-10-03T00:00:00.000Z" });
  test("compareVersions: externalization alone is the same body; a changed seed, vibe, edition or other bytes is a conflict", () => {
    const inline = sheetVersion("x", { kind: "image", src: png, seed: 5, vibe: "photo", provenance: "live" });
    const file = sheetVersion("x", { kind: "image", src: nameOf(PNG_B64, "png"), seed: 5, vibe: "photo", provenance: "live" });
    assert.equal(reconcile.compareVersions(inline, file), "same");
    for (const patch of [{ seed: 6 }, { vibe: "other" }, { provenance: "simulated" }, { src: nameOf(PNG2_B64, "png") }]) {
      assert.equal(reconcile.compareVersions(inline, { ...file, art: { ...file.art, ...patch } }), "different", JSON.stringify(patch));
    }
    assert.equal(reconcile.compareVersions(inline, { ...file, edition: "minimal" }), "different");
  });

  async function generateTwiceAround(syncBetween, art1, art2) {
    const ed = openEditor();
    account.externalize = true;
    const a = ed.ask("sheet");
    await tick();
    calls[0].respond(200, art1);
    assert.equal((await a).op.phase, "applied");
    const firstInline = JSON.parse(JSON.stringify(ed.stub.versions[1]));
    if (syncBetween) {
      const r = await sync.syncNow(); // the REAL sync client: the server's externalized copy comes back (same updatedAt)
      assert.equal(r.ok, true);
      assert.ok(account.stubs.get("s1").versions[1].art.src.startsWith("/api/files/"), "precondition: the account holds a file reference");
    }
    const b = ed.ask("note");
    await tick();
    calls[1].respond(200, art2);
    return { ed, second: await b, firstInline };
  }

  for (const [label, art1] of [
    ["generated inline PNG", { kind: "image", src: png, seed: 31, provenance: "live" }],
    ["inline photo-style JPEG", { kind: "image", src: jpg, seed: 32, vibe: "photo", provenance: "live" }],
  ]) {
    test(`real sync externalizes the editor's own ${label}; the next generation in the SAME open editor still applies, history and bytes intact`, async () => {
      const { ed, second, firstInline } = await generateTwiceAround(true, art1, { kind: "procedural", seed: 77, provenance: "simulated" });
      assert.equal(second.op.phase, "applied");
      assert.notEqual(second.op.code, "version_conflict");
      assert.equal(second.op.saved, true);
      const stored = store.getStub("s1");
      assert.equal(stored.versions.length, 3);
      assert.deepEqual(stored.versions[1].art, firstInline.art, "the earlier version's body is unchanged (immutable)");
      assert.deepEqual(ed.stub.versions.map((v) => v.id), stored.versions.map((v) => v.id));
      await sync.syncNow();
      const acct = account.stubs.get("s1");
      assert.equal(acct.versions.length, 3, "the account holds the whole history");
      assert.equal(acct.versions[1].art.src, nameOf(art1.src.split(",")[1], art1.src.startsWith("data:image/jpeg") ? "jpg" : "png"), "and the same server-owned bytes");
    });
  }

  test("without the fix's equivalence the same sequence would be a false conflict (the control: a file-to-file difference still is one)", async () => {
    const { second } = await generateTwiceAround(true, { kind: "image", src: png, seed: 31, provenance: "live" }, { kind: "procedural", seed: 78, provenance: "simulated" });
    assert.equal(second.op.phase, "applied");
    // a GENUINE conflict: the same id, other bytes behind the server-named file
    const ed = openEditor();
    account.externalize = true;
    const a = ed.ask("sheet");
    await tick();
    calls[calls.length - 1].respond(200, { kind: "image", src: png, seed: 41, provenance: "live" });
    await a;
    const stored = store.getStub("s1");
    store.upsertStub({ ...stored, versions: stored.versions.map((v, i) => (i === 1 ? { ...v, art: { ...v.art, src: nameOf(PNG2_B64, "png") } } : v)) });
    const before = localStorage.getItem("ticketstub.wall.v1");
    const b = ed.ask("note");
    await tick();
    calls[calls.length - 1].ok("late");
    const r = await b;
    assert.equal(r.op.phase, "discarded");
    assert.equal(r.op.code, "version_conflict", "different bytes under the same id are still a real conflict");
    assert.equal(localStorage.getItem("ticketstub.wall.v1"), before, "nothing written");
  });

  test("a reference THIS editor's own sync wrote is attested: naming need not be re-derived; a later change to it voids that", async () => {
    const odd = (v) => (typeof v === "string" ? (v.startsWith("data:") ? "/api/files/odd-name-from-a-future-server.png" : v) : Array.isArray(v) ? v.map(odd) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, odd(x)])) : v);
    const ed = openEditor();
    const a = ed.ask("sheet");
    await tick();
    calls[0].respond(200, { kind: "image", src: png, seed: 61, provenance: "live" });
    await a;
    // the account moves the picture under a name this client cannot derive (e.g. the server changed its scheme)
    const real = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (String(url) !== "/api/wall/sync") return real(url, init);
      const { stubs } = JSON.parse(init.body);
      return new Response(JSON.stringify({ stubs: stubs.map(odd), deleted: [], now: Date.now() }), { status: 200 });
    };
    assert.equal((await sync.syncNow()).ok, true);
    globalThis.fetch = real;
    assert.equal(store.getStub("s1").versions[1].art.src, "/api/files/odd-name-from-a-future-server.png");
    const b = ed.ask("note");
    await tick();
    calls[calls.length - 1].ok("attested");
    assert.equal((await b).op.phase, "applied", "own sync's rewrite is not a conflict");
    // a peer now points that same version at another file: the attestation no longer matches
    const stored = store.getStub("s1");
    store.upsertStub({ ...stored, versions: stored.versions.map((v) => (v.id === ed.stub.versions[1].id ? { ...v, art: { ...v.art, src: "/api/files/someone-elses.png" } } : v)) });
    const before = localStorage.getItem("ticketstub.wall.v1");
    const c = ed.ask("note");
    await tick();
    calls[calls.length - 1].ok("voided");
    assert.equal((await c).op.phase, "ready");
    assert.equal(localStorage.getItem("ticketstub.wall.v1"), before);
  });

  test("the event name the controller listens for is the sync's own", () => {
    assert.equal(sync.WALL_SYNCED, "ticketstub:wall-synced");
  });

  test("a stored reference the server never produces is held, typed, never merged and never applied", async () => {
    const ed = openEditor();
    const a = ed.ask("sheet");
    await tick();
    calls[0].respond(200, { kind: "image", src: png, seed: 51, provenance: "live" });
    await a;
    const stored = store.getStub("s1");
    store.upsertStub({ ...stored, versions: stored.versions.map((v, i) => (i === 1 ? { ...v, art: { ...v.art, src: "/api/files/abcdef0123456789.png" } } : v)) });
    const before = localStorage.getItem("ticketstub.wall.v1");
    const draft = JSON.stringify(ed.stub);
    const b = ed.ask("note");
    await tick();
    calls[calls.length - 1].ok("held");
    const { op } = await b;
    assert.equal(op.phase, "ready");
    assert.equal(op.code, "art_unverifiable");
    assert.equal(localStorage.getItem("ticketstub.wall.v1"), before);
    assert.equal(JSON.stringify(ed.stub), draft);
    assert.equal(ed.gen.apply(op.runId).phase, "ready", "an explicit Apply cannot merge what it cannot compare");
    assert.equal(localStorage.getItem("ticketstub.wall.v1"), before);
  });
});
