// Fixture-only provenance for the actual download producer. One action per document, never a filename/time guess.
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const BINDING = "__ticketstubDownloadReceiptBinding";
const SLOT = "__ticketstubDownloadReceipt";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// Installed before application code in each new document. Only observes the app's real methods; never delivers a file.
function observeProducer(binding, slot) {
  const documentId = crypto.randomUUID();
  const send = (type, detail = {}) => globalThis[binding](JSON.stringify({ type, documentId, actionId: action?.id ?? null, ...detail }));
  let action = null, clicks = 0, producers = 0, terminal = false;
  const objects = new Map();
  const create = URL.createObjectURL, revoke = URL.revokeObjectURL, click = HTMLAnchorElement.prototype.click;
  URL.createObjectURL = function (blob) {
    const url = Reflect.apply(create, this, [blob]);
    objects.set(url, blob);
    return url;
  };
  URL.revokeObjectURL = function (url) {
    objects.delete(String(url));
    return Reflect.apply(revoke, this, [url]);
  };
  document.addEventListener("click", (event) => {
    const button = event.composedPath().find((e) => e instanceof Element && e.matches("button[data-download]"));
    if (!button) return;
    clicks++;
    if (!action || button !== action.button || clicks !== 1 || terminal) send("violation", { code: "unexpected_control" });
    send("control", { side: button.getAttribute("data-download"), trusted: event.isTrusted });
  }, true);
  HTMLAnchorElement.prototype.click = function (...args) {
    let receipt;
    if (this.hasAttribute("download")) {
      const url = this.href, blob = objects.get(url);
      const producerId = `${documentId}:${++producers}`;
      if (!action || clicks !== 1 || terminal) send("violation", { code: "unowned_producer", producerId });
      if (producers !== 1) send("violation", { code: "duplicate_producer", producerId });
      receipt = { producerId, url, filename: this.download, bytes: blob?.size ?? null, mime: blob?.type ?? null };
      send("producer", receipt); // before the real anchor invocation, including when native begin is delayed
      if (!url.startsWith("blob:") || !(blob instanceof Blob) || blob.type !== "image/png") {
        send("violation", { code: "unknown_blob", producerId });
      } else receipt.blob = blob;
    }
    try {
      return Reflect.apply(click, this, args);
    } finally {
      // Hash the actual Blob after dispatch. It never delays or substitutes the app's anchor call.
      if (receipt?.blob) {
        const { blob, producerId } = receipt;
        Promise.resolve().then(async () => {
          const hash = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
          const digest = [...new Uint8Array(hash)].map((v) => v.toString(16).padStart(2, "0")).join("");
          send("digest", { producerId, sha256: digest });
        }).catch(() => send("violation", { code: "blob_hash_failed", producerId }));
      }
    }
  };
  const failureMatches = (id, message) => {
    const root = action?.button.closest("[data-download-root]");
    return action?.id === id && typeof message === "string" && message.length > 0
      && root?.querySelector("[data-failure] p")?.textContent?.trim() === message;
  };
  Object.defineProperty(globalThis, slot, { value: Object.freeze({
    arm(id, side) {
      if (action) { send("violation", { code: "document_reused" }); throw new Error("document_reused"); }
      if (clicks || producers) throw new Error("document_already_used");
      const button = [...document.querySelectorAll(`[data-download="${side}"]`)].find((e) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== "hidden";
      });
      if (!button || button.disabled) throw new Error("download_control_unavailable");
      action = Object.freeze({ id, side, button });
      send("armed", { side });
      return { documentId };
    },
    isIdle(id) {
      return action?.id === id && action.button.isConnected && !action.button.disabled;
    },
    failureMatches,
    noDownload(id, outcome, failureMessage) {
      if (!action || action.id !== id || !action.button.isConnected || action.button.disabled || clicks !== 1 || producers !== 0 || terminal) throw new Error("no_download_receipt_invalid");
      if (outcome === "failed" && !failureMatches(id, failureMessage)) throw new Error("no_download_failure_not_terminal");
      terminal = true;
      send("no_download", { outcome });
      return true;
    },
  }) });
}

/** Observe a fresh fixture browser. Install each page before its first application navigation. */
export class DownloadReceipts {
  constructor(browser, directory, { timeoutMs = 40_000 } = {}) {
    this.browser = browser;
    this.directory = resolve(directory);
    this.timeoutMs = timeoutMs;
    this.contexts = new Map();
    this.actions = new Map();
    this.producers = new Map();
    this.downloads = new Map();
    this.violations = [];
    this.events = [];
    this.off = browser.conn.on((event) => this.observe(event));
  }
  async start() {
    mkdirSync(this.directory, { recursive: true });
    // Official CDP: allowAndName names saved files by GUID, independently of the suggested filename.
    await this.browser.conn.send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: this.directory, eventsEnabled: true });
  }
  async install(page) {
    await page.send("Runtime.addBinding", { name: BINDING });
    await page.send("Page.addScriptToEvaluateOnNewDocument", { source: `(${observeProducer.toString()})(${JSON.stringify(BINDING)}, ${JSON.stringify(SLOT)});` });
  }
  fault(code, detail = {}) {
    this.violations.push({ code, ...detail });
  }
  observe(event) {
    const { method, params, sessionId } = event;
    if (method === "Runtime.executionContextCreated") {
      this.contexts.set(`${sessionId}:${params.context.id}`, params.context);
      return;
    }
    if (method === "Runtime.bindingCalled" && params.name === BINDING) {
      let receipt;
      try { receipt = JSON.parse(params.payload); } catch { this.fault("malformed_binding"); return; }
      const context = this.contexts.get(`${sessionId}:${params.executionContextId}`);
      if (!context?.uniqueId || !context.auxData?.frameId || !context.auxData?.isDefault) {
        this.fault("unknown_execution_context", { actionId: receipt.actionId });
        return;
      }
      const identity = { sessionId, executionContextId: params.executionContextId, executionContextUniqueId: context.uniqueId, frameId: context.auxData.frameId, documentId: receipt.documentId };
      this.events.push({ ...receipt, ...identity });
      const action = this.actions.get(receipt.actionId);
      if (!action || action.sessionId !== sessionId) { this.fault("unknown_action", { actionId: receipt.actionId, type: receipt.type }); return; }
      if (receipt.type === "armed") {
        if (action.documentId || [...this.actions.values()].some((a) => a !== action && a.executionContextUniqueId === context.uniqueId)) {
          this.fault("document_reused", { actionId: action.id });
          return;
        }
        Object.assign(action, identity);
      } else if (action.documentId !== receipt.documentId || action.executionContextUniqueId !== context.uniqueId) {
        this.fault("document_identity_changed", { actionId: action.id });
        return;
      }
      if (receipt.type === "control") {
        action.controls++;
        if (action.controls !== 1 || receipt.side !== action.side) this.fault("unexpected_control", { actionId: action.id });
      } else if (receipt.type === "producer") {
        const producer = { ...receipt, ...identity, sha256: null };
        if (this.producers.has(receipt.producerId) || action.producerIds.length || action.settled) this.fault("duplicate_producer", { actionId: action.id });
        this.producers.set(receipt.producerId, producer);
        action.producerIds.push(receipt.producerId);
      } else if (receipt.type === "digest") {
        const producer = this.producers.get(receipt.producerId);
        if (!producer || producer.actionId !== action.id || producer.sha256 || !/^[a-f0-9]{64}$/.test(receipt.sha256)) this.fault("invalid_blob_digest", { actionId: action.id });
        else producer.sha256 = receipt.sha256;
      } else if (receipt.type === "no_download") {
        if (action.noDownload) this.fault("duplicate_terminal", { actionId: action.id });
        action.noDownload = receipt.outcome;
      } else if (receipt.type === "violation") this.fault(receipt.code, { actionId: action.id });
      return;
    }
    if (method === "Browser.downloadWillBegin") {
      if (this.downloads.has(params.guid)) this.fault("duplicate_guid", { guid: params.guid });
      this.downloads.set(params.guid, { ...params, state: "pending" });
      this.events.push({ type: "native_begin", ...params });
    } else if (method === "Browser.downloadProgress") {
      const download = this.downloads.get(params.guid);
      if (!download) this.fault("unknown_guid_progress", { guid: params.guid });
      else Object.assign(download, { state: params.state, receivedBytes: params.receivedBytes, totalBytes: params.totalBytes });
      if (params.state !== "inProgress") this.events.push({ type: "native_terminal", ...params });
    }
  }
  async arm(page, side, label = "") {
    const action = { id: randomUUID(), sessionId: page.sid, side, label, controls: 0, producerIds: [], settled: false };
    this.actions.set(action.id, action);
    try {
      const armed = await page.eval(`${SLOT}.arm(${JSON.stringify(action.id)}, ${JSON.stringify(side)})`);
      await this.until(() => action.documentId === armed.documentId, "armed context receipt", action);
      return action;
    } catch (error) {
      action.rejected = true;
      this.fault("arm_rejected", { actionId: action.id, message: error.message });
      throw error;
    }
  }
  errorsFor(action) {
    return this.violations.filter((v) => v.actionId === action.id);
  }
  async until(predicate, label, action) {
    const end = Date.now() + this.timeoutMs;
    while (Date.now() < end) {
      const errors = action ? this.errorsFor(action) : [];
      if (errors.length) throw new Error(`download receipt: ${errors.map((e) => e.code).join(", ")}`);
      const value = predicate();
      if (value) return value;
      await sleep(25);
    }
    if (action) this.fault("receipt_timeout", { actionId: action.id, waitingFor: label });
    throw new Error(`download receipt timeout: ${label}`);
  }
  nativeFor(producer) {
    return [...this.downloads.values()].filter((d) => d.url === producer.url && d.frameId === producer.frameId);
  }
  async download(action) {
    if (action.settled) throw new Error("download receipt already consumed");
    const file = await this.until(() => {
      if (action.controls !== 1 || action.producerIds.length !== 1) return null;
      const producer = this.producers.get(action.producerIds[0]);
      const sameUrl = [...this.producers.values()].filter((p) => p.url === producer.url);
      const native = this.nativeFor(producer);
      if (sameUrl.length !== 1 || native.length > 1) {
        this.fault("ambiguous_native_download", { actionId: action.id });
        throw new Error("ambiguous_native_download");
      }
      if (native[0]?.state === "canceled") throw new Error("native_download_canceled");
      if (!producer.sha256 || native[0]?.state !== "completed") return null;
      const record = native[0];
      if (!/^[a-zA-Z0-9_-]{1,100}$/.test(record.guid)) throw new Error("invalid_native_guid");
      let bytes;
      try { bytes = readFileSync(join(this.directory, record.guid)); } catch (e) { if (e.code === "ENOENT") return null; throw e; }
      const digest = sha256(bytes);
      if (digest !== producer.sha256 || bytes.length !== producer.bytes || record.suggestedFilename !== producer.filename) {
        this.fault("native_blob_mismatch", { actionId: action.id, guid: record.guid, blobSha256: producer.sha256, fileSha256: digest });
        throw new Error("native_blob_mismatch");
      }
      return { name: record.suggestedFilename, buf: bytes, receipt: { actionId: action.id, documentId: action.documentId, executionContextUniqueId: action.executionContextUniqueId, frameId: producer.frameId, url: producer.url, guid: record.guid, sha256: digest, bytes: bytes.length } };
    }, "producer Blob and completed matching native GUID", action);
    action.settled = true;
    action.result = file.receipt;
    return file;
  }
  waitForFailure(page, action, message, ms = this.timeoutMs) {
    return page.waitFor(`${SLOT}.failureMatches(${JSON.stringify(action.id)}, ${JSON.stringify(message)})`, ms);
  }
  async noDownload(page, action, outcome, { failureMessage = null } = {}) {
    // The caller first observes the actual share/tab/cancel/failure path in this same document.
    // Also wait for the exact armed control to leave its busy state before sealing its terminal receipt.
    if (!await page.waitFor(`${SLOT}.isIdle(${JSON.stringify(action.id)})`, this.timeoutMs)) {
      this.fault("no_download_not_idle", { actionId: action.id });
      throw new Error("no_download_not_idle");
    }
    await page.eval(`${SLOT}.noDownload(${JSON.stringify(action.id)}, ${JSON.stringify(outcome)}, ${JSON.stringify(failureMessage)})`);
    await this.until(() => action.noDownload === outcome, "current-document no-download terminal", action);
    if (action.controls !== 1 || action.producerIds.length) throw new Error("unexpected_download_producer");
    action.settled = true;
    return true;
  }
  audit() {
    const errors = [...this.violations];
    for (const download of this.downloads.values()) {
      const matched = [...this.producers.values()].filter((p) => p.url === download.url && p.frameId === download.frameId);
      if (matched.length !== 1) errors.push({ code: "unknown_or_ambiguous_native_download", guid: download.guid, url: download.url });
    }
    for (const action of this.actions.values()) {
      if (!action.settled) errors.push({ code: "unsettled_action", actionId: action.id });
      if (action.producerIds.length > 1) errors.push({ code: "duplicate_producer", actionId: action.id });
      for (const id of action.producerIds) {
        const producer = this.producers.get(id), native = this.nativeFor(producer);
        if (native.length !== 1 || native[0]?.state !== "completed") errors.push({ code: "incomplete_or_duplicate_native_download", actionId: action.id, producerId: id });
      }
    }
    return errors;
  }
  snapshot() {
    return { actions: [...this.actions.values()], producers: [...this.producers.values()], downloads: [...this.downloads.values()], violations: this.audit(), events: this.events };
  }
  stop() { this.off(); }
}
