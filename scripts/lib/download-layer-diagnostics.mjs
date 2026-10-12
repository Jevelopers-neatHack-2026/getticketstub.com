// Passive, bounded LayerTree evidence. The protocol reports layer changes/paint notifications,
// not a committed screenshot frame or an artwork-ready guarantee. Never use this as a capture gate.
// LayerTree is experimental: https://github.com/ChromeDevTools/devtools-protocol/blob/master/pdl/domains/LayerTree.pdl
const LIMITS = Object.freeze({ events: 128, layers: 64, nodes: 48 });
const clone = (value) => JSON.parse(JSON.stringify(value));
const immutable = (value) => {
  if (value && typeof value === "object") { Object.values(value).forEach(immutable); Object.freeze(value); }
  return value;
};
const number = (value) => Number.isFinite(value) && Math.abs(value) <= 1e12 ? Math.round(value * 100) / 100 : null;
const integer = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
const opaqueId = (value) => typeof value === "string" && /^[a-f\d-]{1,80}$/i.test(value) ? value : null;
const captureIdIsValid = (value) => typeof value === "string" && /^[a-f\d]{8}(-[a-f\d]{4}){3}-[a-f\d]{12}$/.test(value);
const rectangle = (value) => Object.fromEntries(["x", "y", "width", "height"].map((key) => [key, number(value?.[key])]));
class DiagnosticTimeout extends Error {}

async function bounded(promise, ms) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new DiagnosticTimeout("diagnostic_timeout")), ms); })]);
  } finally { clearTimeout(timer); }
}

export class DownloadLayerDiagnostics {
  constructor(page, { now = () => performance.now(), timeoutMs = 2000 } = {}) {
    this.page = page;
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.startedAt = now();
    this.sequence = 0;
    this.generation = 0;
    this.status = "not_started";
    this.stopped = false;
    this.resetDocument(null, null);
  }

  resetDocument(frameId, loaderId) {
    this.document = { generation: this.generation, frameId, loaderId };
    this.events = [];
    this.eventCount = 0;
    this.eventsDropped = 0;
    this.malformedEvents = 0;
    this.tree = { status: "not_observed", layers: [], layerCount: null, layersOmitted: 0 };
  }

  receive(message) {
    if (this.stopped || message.sessionId !== this.page.sid) return;
    const params = message.params ?? {};
    if (message.method === "Page.frameNavigated" && params.frame && !params.frame.parentId) {
      this.generation++;
      this.resetDocument(opaqueId(params.frame.id), opaqueId(params.frame.loaderId));
      return;
    }
    if (!["LayerTree.layerTreeDidChange", "LayerTree.layerPainted"].includes(message.method)) return;
    const event = { sequence: ++this.sequence, receivedAfterObserverStartMs: number(this.now() - this.startedAt) };
    this.eventCount++;
    if (message.method === "LayerTree.layerPainted") {
      event.kind = "layer_painted";
      event.layerId = opaqueId(params.layerId);
      event.clip = rectangle(params.clip);
      if (!event.layerId || Object.values(event.clip).some((n) => n === null)) this.malformedEvents++;
    } else {
      event.kind = "tree_changed";
      if (params.layers === undefined) {
        this.tree = { status: "not_compositing_reported", layers: [], layerCount: null, layersOmitted: 0 };
      } else if (!Array.isArray(params.layers)) {
        this.malformedEvents++;
        this.tree = { status: "unavailable_malformed_event", layers: [], layerCount: null, layersOmitted: 0 };
      } else {
        const layers = params.layers.slice(0, LIMITS.layers).map((entry) => {
          const layer = entry && typeof entry === "object" ? entry : {};
          const result = {
            layerId: opaqueId(layer.layerId), parentLayerId: opaqueId(layer.parentLayerId),
            backendNodeId: integer(layer.backendNodeId), offsetX: number(layer.offsetX), offsetY: number(layer.offsetY),
            width: number(layer.width), height: number(layer.height), paintCount: integer(layer.paintCount),
            drawsContent: typeof layer.drawsContent === "boolean" ? layer.drawsContent : null,
            invisible: typeof layer.invisible === "boolean" ? layer.invisible : null,
          };
          if (Array.isArray(layer.transform)) {
            result.transform = layer.transform.length === 16 && layer.transform.every((v) => number(v) !== null) ? layer.transform.map(number) : null;
          }
          if (!result.layerId) this.malformedEvents++;
          return result;
        });
        this.tree = { status: "recorded", layers, layerCount: params.layers.length, layersOmitted: Math.max(0, params.layers.length - LIMITS.layers) };
      }
      Object.assign(event, { treeStatus: this.tree.status, layerCount: this.tree.layerCount, layersOmitted: this.tree.layersOmitted });
    }
    this.events.push(event);
    if (this.events.length > LIMITS.events) { this.events.shift(); this.eventsDropped++; }
  }

  async start() {
    if (this.status !== "not_started") return;
    this.status = "enabling";
    this.startedBeforeNavigation = this.generation === 0;
    this.off = this.page.conn.on((message) => this.receive(message));
    try {
      await bounded(this.page.send("LayerTree.enable"), this.timeoutMs);
      this.status = "enabled";
    } catch (error) {
      // Unsupported protocol versions may reject enable. Never expose arbitrary protocol error text;
      // distinguish our own deadline from a rejection without asserting that either means no paint.
      this.status = error instanceof DiagnosticTimeout ? "unavailable_enable_timeout" : "unavailable_enable_error";
      this.off();
      this.off = null;
    }
  }

  mark(captureId, stage) {
    return immutable({
      captureId: captureIdIsValid(captureId) ? captureId : null,
      stage: ["before_screenshot_request", "after_screenshot_response"].includes(stage) ? stage : "unrecognized",
      observedAfterStartMs: number(this.now() - this.startedAt), sequence: this.sequence,
      status: this.status, document: clone(this.document), events: clone(this.events), tree: clone(this.tree),
      completeness: { eventCount: this.eventCount, eventsRetained: this.events.length, eventsDropped: this.eventsDropped,
        malformedEvents: this.malformedEvents, layersOmitted: this.tree.layersOmitted },
    });
  }

  async mapCapturedNodes(captureId, figure, expectedNodeIds) {
    const group = `ticketstub-capture-${captureId}`;
    const token = { active: true };
    const fixedUnavailable = () => ({ status: "unavailable", reason: "mapping_error_or_timeout", nodes: [] });
    const release = async () => {
      const results = await Promise.allSettled([
        bounded(this.page.send("Runtime.releaseObjectGroup", { objectGroup: group }), this.timeoutMs),
        bounded(this.page.eval(`window.__ticketstubCaptureProvenance?.releaseCapture(${JSON.stringify(captureId)}) ?? false`), this.timeoutMs),
      ]);
      return results.every((result) => result.status === "fulfilled") ? "references_and_remote_group_released" : "cleanup_partly_unavailable";
    };
    const live = () => { if (!token.active) throw new Error("mapping_closed"); };
    const operation = (async () => {
      const check = `window.__ticketstubCaptureProvenance?.nodeStatusForCapture(${JSON.stringify(captureId)}, ${figure}) ?? {status:"unavailable",reason:"collector_unavailable"}`;
      const before = await this.page.eval(check);
      live();
      const valid = (state) => ["recorded", "partial"].includes(state?.status) && JSON.stringify(state.nodeIds) === JSON.stringify(expectedNodeIds);
      if (!valid(before)) return { status: "unavailable", reason: "retained_identity_unavailable_before_mapping", nodes: [] };
      const remote = await this.page.send("Runtime.evaluate", { expression: `window.__ticketstubCaptureProvenance?.nodesForCapture(${JSON.stringify(captureId)}, ${figure}) ?? null`,
        objectGroup: group, returnByValue: false });
      live();
      if (remote.exceptionDetails || !remote.result?.objectId || remote.result.subtype !== "array") return { status: "unavailable", reason: "retained_references_unavailable", nodes: [] };
      const properties = await this.page.send("Runtime.getProperties", { objectId: remote.result.objectId, ownProperties: true, accessorPropertiesOnly: false, generatePreview: false });
      live();
      const refs = new Map((properties.result ?? []).filter((p) => /^(0|[1-9]\d{0,2})$/.test(p.name) && Number(p.name) < expectedNodeIds.length).map((p) => [Number(p.name), p.value?.objectId]));
      const nodes = await Promise.all(expectedNodeIds.map(async (nodeId, index) => {
        if (!refs.get(index)) return { nodeId, status: "unavailable" };
        const result = await this.page.send("DOM.describeNode", { objectId: refs.get(index), depth: 0, pierce: false });
        live();
        // Never serialize the returned attributes, source URLs, text, node names or raw error details.
        const backendNodeId = integer(result.node?.backendNodeId);
        return backendNodeId === null ? { nodeId, status: "unavailable" } : { nodeId, backendNodeId, status: "recorded" };
      }));
      const after = await this.page.eval(check);
      live();
      if (!valid(after)) return { status: "unavailable", reason: "retained_identity_changed_during_mapping", nodes: [] };
      return { status: before.status === "partial" || nodes.some((n) => n.status !== "recorded") ? "partial" : "recorded", nodes,
        identityChecks: "same_retained_figure_images_and_ancestry_before_and_after_mapping", observationTime: "after_original_screenshot" };
    })();
    let result, completed = false;
    void operation.then(() => { completed = true; }, () => { completed = true; });
    try { result = await bounded(operation, this.timeoutMs); }
    catch { result = fixedUnavailable(); }
    finally {
      token.active = false;
      // A timed-out Runtime.evaluate can return a remote object late; release that group again then.
      if (!completed) void operation.finally(release).catch(() => {});
      result.cleanup = await release();
    }
    return result;
  }

  async record({ captureId, beforeRequest, afterResponse, provenance, figure, screenshotSha256 }) {
    const validIds = Array.isArray(provenance?.preCaptureNodeIds) && provenance.preCaptureNodeIds.length > 0 && provenance.preCaptureNodeIds.length <= LIMITS.nodes
      && provenance.preCaptureNodeIds.every((id) => Number.isSafeInteger(id) && id > 0) && new Set(provenance.preCaptureNodeIds).size === provenance.preCaptureNodeIds.length;
    const associated = captureIdIsValid(captureId) && provenance?.captureId === captureId && provenance.captureBindingStatus === "recorded"
      && beforeRequest?.captureId === captureId && afterResponse?.captureId === captureId
      && beforeRequest.stage === "before_screenshot_request" && afterResponse.stage === "after_screenshot_response"
      && beforeRequest.sequence <= afterResponse.sequence && beforeRequest.document.generation === afterResponse.document.generation
      && /^[a-f\d]{64}$/.test(screenshotSha256) && validIds;
    const mapping = associated ? await this.mapCapturedNodes(captureId, figure, provenance.preCaptureNodeIds)
      : { status: "unavailable", reason: "capture_association_unavailable", nodes: [] };
    return immutable({ schema: "ticketstub.layer-observation.v1", captureId: captureIdIsValid(captureId) ? captureId : null,
      status: associated ? "associated" : "unavailable", firstScreenshotSha256: /^[a-f\d]{64}$/.test(screenshotSha256) ? screenshotSha256 : null,
      limits: LIMITS, observationStartedBeforeNavigation: this.startedBeforeNavigation === true, instrumentationMayAffectTiming: true,
      eventsAreNotCompositorReadiness: true, documentAssociation: "session_events_since_observed_main_frame_navigation",
      backendMappingDoesNotProveUnobservedIdentityHistory: true, beforeRequest, afterResponse, mapping });
  }

  async stop() {
    if (this.stopped) return { status: "already_stopped" };
    this.stopped = true;
    this.off?.();
    this.off = null;
    try { await bounded(this.page.send("LayerTree.disable"), this.timeoutMs); return { status: "disabled_listener_detached" }; }
    catch { return { status: "listener_detached_disable_unavailable" }; }
  }
}
