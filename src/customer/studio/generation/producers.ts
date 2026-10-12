// The request side of each entry point, shared so the sheet, the note and the chat report and fail the same way.
import type { Stub } from "../types";
import { remixArtNoted } from "../research/client";
import { readImageFile } from "../editor/ops";
import { artOutcome, clock, errorCode, flow, since, type vibeOf } from "@/customer/flows/events";
import type { GenerationVia, Produced } from "./operations";

/** Ask for new art. The result is NOT applied here: the controller decides, against the current draft. */
export function remixProducer(via: Exclude<GenerationVia, "photo">, vibe: string | undefined, vibeLabel: ReturnType<typeof vibeOf>, simulate?: "failure") {
  return async (signal: AbortSignal, source: Stub): Promise<Produced> => {
    flow("remix_request", { via, vibe: vibeLabel });
    const asked = clock();
    try {
      const res = await remixArtNoted(source, vibe, { signal, ...(simulate ? { simulate } : {}) });
      // the daily cap answers with procedural art: a limited result, never reported as generated
      flow("remix_result", { via, result: res.limitNote ? "limited" : "success", ...artOutcome(res.art), duration_ms: since(asked) });
      return { art: res.art, ...(res.limitNote ? { limitNote: res.limitNote } : {}) };
    } catch (e) {
      flow("remix_result", { via, result: "error", duration_ms: since(asked), error_code: errorCode(e) });
      throw e;
    }
  };
}

/** The person's own photo as the art: read and shrunk on this device (never the photo or its name is reported). */
export function photoProducer(file: File) {
  return async (): Promise<Produced> => {
    try {
      const src = await readImageFile(file);
      flow("remix_result", { via: "sheet", result: "success", art: "uploaded", capability: "local" });
      return { art: { kind: "image", src, seed: Date.now() % 100000, vibe: "photo", provenance: "live" } };
    } catch (e) {
      flow("remix_result", { via: "sheet", result: "error", art: "uploaded", capability: "local", error_code: "bad_image" });
      throw e;
    }
  };
}
