import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import "./analytics-hooks.mjs";

// One shared art-generation lifecycle (issues #98 and #97). The editor owns ONE controller; deferred /api/art responses
// are resolved in either order against the real client, the real controller, the real local persistence (upsertStub)
// and the real account-sync merge. Nothing here reaches a network: fetch is a controllable in-memory fake.

class FakeStorage {
  mode = "ok"; // "ok" | "blocked"
  #m = new Map();
  getItem(k) {
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
globalThis.fetch = (url, init = {}) => {
  assert.equal(String(url), "/api/art", "only the art route is ever requested");
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
  ed.update = (s) => {
    ed.stub = s;
    ed.revision++;
    const stored = store.upsertStub(s);
    ed.saved.push(stored);
    return stored;
  };
  const initial = (seed ? store.getStub(id) : null) ?? makeStub(id);
  if (seed && !store.getStub(id)) store.upsertStub(initial);
  ed.stub = initial;
  const stubRef = { get current() { return ed.stub; } };
  const revRef = { get current() { return ed.revision; } };
  ed.gen = new GenerationController(editorHost(stubRef, revRef, ed.update, (sid) => store.loadDeleted().includes(sid)), localStorage);
  ed.gen.attach();
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
