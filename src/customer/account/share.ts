"use client";
// Share links. The server stores a snapshot and hands back a short token; with no server (or any
// failure) the stub itself rides in the link, which is how every older /s/<token> link works.
import { memoryPath } from "@/customer/pages/share";
import type { Stub } from "@/customer/studio/types";
import { api } from "./api";
import { isSavingOff } from "./saving";
import { errorCode, flow } from "@/customer/flows/events";

/** The path of a stub's memory page: a short server token when we can, the encoded stub when we can't. */
export async function sharePath(stub: Stub): Promise<string> {
  if (isSavingOff()) {
    flow("server_save", { kind: "share", result: "off" });
    return memoryPath(stub); // saving is off: the stub rides in the link
  }
  try {
    const { token } = await api.share(stub);
    if (token && /^[\w-]+$/.test(token)) {
      flow("server_save", { kind: "share", result: "saved" });
      return `/s/${token}`;
    }
    flow("server_save", { kind: "share", result: "failed", error_code: "unavailable" });
  } catch (e) {
    /* offline, signed out of a server-less deploy, or too large: use the encoded link */
    flow("server_save", { kind: "share", result: "failed", error_code: errorCode(e) });
  }
  return memoryPath(stub);
}
