"use client";
import { createContext, useContext, useSyncExternalStore } from "react";

// A container can reduce its React children as well as its imperative landing hosts.
// Other screens, and an embedded studio when landing motion is on, still honor the OS preference.
export const MotionOffContext = createContext(false);
const QUERY = "(prefers-reduced-motion: reduce)";
const subscribe = (update: () => void) => {
  const media = window.matchMedia?.(QUERY);
  media?.addEventListener("change", update);
  return () => media?.removeEventListener("change", update);
};
const systemReduced = () => window.matchMedia?.(QUERY).matches ?? false;
const serverReduced = () => false;

export function useReducedMotion(): boolean {
  const localOff = useContext(MotionOffContext);
  const osReduced = useSyncExternalStore(subscribe, systemReduced, serverReduced);
  return localOff || osReduced;
}
