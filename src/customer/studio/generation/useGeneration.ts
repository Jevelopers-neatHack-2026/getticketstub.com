"use client";
import { useSyncExternalStore } from "react";
import type { GenerationController, GenerationOp } from "./operations";

/** The latest generation operation for a project, re-read whenever the controller changes. */
export function useGenerationOp(controller: GenerationController, stubId: string): GenerationOp | null {
  useSyncExternalStore(controller.subscribe, controller.version, controller.version);
  return controller.get(stubId);
}
