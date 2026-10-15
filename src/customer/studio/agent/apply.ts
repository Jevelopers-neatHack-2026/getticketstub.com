import { factKey } from "../facts/identity";
// Applying one agent action to a stub. Pure: it returns the next stub, or a bounded reason it refused. It goes through
// the same edit functions the editor's own controls use (corrections for facts and the title, setEdition,
// setMaterial, setFinish, addArtVersion), so versions, kept facts and the correction history come out the same as when
// a person makes the change. The action is validated again here: what arrives from a model is never trusted.
import { addArtVersion, setEdition, setFinish, setMaterial, setFactValue, setHidden, toggleKept } from "../editor/ops";
import { currentVersion } from "../types";
import type { ArtLayer, Stub } from "../types";
import { parseAction, sourceFactForAgent } from "./protocol";
import type { Action } from "./protocol";

export type Applied = { ok: true; stub: Stub } | { ok: false; code: "invalid_value" | "not_found" | "unchanged" };

const refuse = (code: "invalid_value" | "not_found" | "unchanged"): Applied => ({ ok: false, code });

/** The synchronous actions. remix_art, show_back and ask_user are carried out by the chat (art route, editor view, a question). */
export function applyToStub(stub: Stub, action: Action, opts: { allowSimulate?: boolean } = {}): Applied {
  const checked = parseAction(action, opts);
  if (!checked.ok) return refuse("invalid_value");
  const a = checked.value;
  switch (a.type) {
    case "set_fact": {
      if (a.field === "keep" || a.field === "unkeep") {
        const f = sourceFactForAgent(stub.event.facts, a.value);
        if (!f) return refuse("not_found");
        if (f.provenance === "pending") return refuse("invalid_value");
        if (!!f.kept === (a.field === "keep")) return refuse("unchanged");
        return { ok: true, stub: toggleKept(stub, factKey(f)) };
      }
      const current = a.field === "date" ? stub.event.dateISO : stub.event.venue;
      if (current === a.value) return refuse("unchanged");
      return { ok: true, stub: setFactValue(stub, a.field, a.value, "Changed with the agent") };
    }
    case "set_style":
      if (currentVersion(stub).edition === a.edition) return refuse("unchanged");
      return { ok: true, stub: setEdition(stub, a.edition) };
    case "set_material":
      if (stub.material === a.material) return refuse("unchanged");
      return { ok: true, stub: setMaterial(stub, a.material) };
    case "set_finish": {
      if (stub.finish === a.finish) return refuse("unchanged");
      const next = setFinish(stub, a.finish);
      return next === stub ? refuse("invalid_value") : { ok: true, stub: next };
    }
    case "set_text": {
      if (a.field === "title") return stub.event.title === a.value ? refuse("unchanged") : { ok: true, stub: setFactValue(stub, "title", a.value, "Changed with the agent") };
      if (a.field === "subtitle") {
        if (stub.event.subtitle === a.value) return refuse("unchanged");
        return { ok: true, stub: setHidden({ ...stub, event: { ...stub.event, subtitle: a.value } }, "subtitle", false) };
      }
      if (stub.personal.note === a.value) return refuse("unchanged");
      return { ok: true, stub: { ...stub, personal: { ...stub.personal, note: a.value } } };
    }
    default:
      return refuse("invalid_value");
  }
}

/** A remix as a new design version. Procedural art needs no provider, which is what makes it the fallback. */
export function withArt(stub: Stub, art: ArtLayer): Stub {
  return addArtVersion(stub, art);
}

export function proceduralArt(vibe?: string): ArtLayer {
  return { kind: "procedural", seed: Math.floor(Math.random() * 2_147_483_647), vibe, provenance: "simulated" };
}
