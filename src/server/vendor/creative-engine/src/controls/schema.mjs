/** Local consumer proposal; not an agreed shared-contracts publication. */
export const SCHEMA_VERSIONS = Object.freeze(['creative-controls/1.0', 'creative-controls/1.1']);
export const ACTION_VERSIONS = Object.freeze(['creative-apply/1.0', 'creative-apply/1.1']);
const definitions = Object.freeze([
  { id: 'c01', label: 'Name size', field: 'name_size', route: 'composition.update', options: ['small', 'medium', 'large'] },
  { id: 'c02', label: 'Layout', field: 'layout', route: 'composition.update', options: ['centered', 'stacked'] },
  { id: 'c03', label: 'Approved logo position', field: 'logo_position', route: 'composition.update', options: ['top', 'bottom'] },
  { id: 'c04', label: 'Artwork style', field: 'style', route: 'artwork.edit', options: ['calm', 'vibrant'] },
]);

/** Bounded own-data snapshot: never call input getters, iterators or methods. */
export function snapshotControlJson(input) {
  const seen = new Set(); let nodes = 0, bytes = 0;
  function copy(value, depth) {
    if (++nodes > 8192 || depth > 24) throw new TypeError('Invalid control JSON');
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') { bytes += value.length; if (bytes > 65536) throw new TypeError('Invalid control JSON'); return value; }
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value !== 'object' || seen.has(value)) throw new TypeError('Invalid control JSON');
    seen.add(value);
    try {
      const array = Array.isArray(value), proto = Object.getPrototypeOf(value);
      if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) throw new TypeError('Invalid control JSON');
      const keys = Reflect.ownKeys(value), descriptors = Object.getOwnPropertyDescriptors(value);
      if (keys.some(key => typeof key !== 'string')) throw new TypeError('Invalid control JSON');
      const result = array ? [] : {};
      const length = array ? descriptors.length.value : 0;
      if (array && (!Number.isSafeInteger(length) || length > 8192 || keys.length !== length + 1)) throw new TypeError('Invalid control JSON');
      for (const key of keys) {
        if (array && key === 'length') continue;
        const descriptor = descriptors[key];
        if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value') ||
          (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length))) throw new TypeError('Invalid control JSON');
        Object.defineProperty(result, key, { value: copy(descriptor.value, depth + 1), enumerable: true, writable: true, configurable: true });
      }
      return result;
    } finally { seen.delete(value); }
  }
  return copy(input, 0);
}
export function canonical(input) {
  const value = snapshotControlJson(input);
  function serialize(item) {
    if (Array.isArray(item)) return `[${item.map(serialize).join(',')}]`;
    if (item !== null && typeof item === 'object') return `{${Object.keys(item).sort().map(k => `${JSON.stringify(k)}:${serialize(item[k])}`).join(',')}}`;
    return JSON.stringify(item);
  }
  return serialize(value);
}
export const isRecord = x => x !== null && typeof x === 'object' && !Array.isArray(x);
// Scalar privacy screening for the bounded ASCII ID alphabet below. This mirrors
// CE11's credential/PII text policy without Node Buffer or a browser polyfill.
// Percent escapes, URLs, email, whitespace and '=' never pass the ID grammar.
function sensitiveIdentifier(value) {
  if (/\bAKIA[0-9A-Z]{16}\b/.test(value) || /\bgh[pousr]_[A-Za-z0-9]{20,}\b/.test(value) ||
      /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}\b/i.test(value) ||
      /\b(?:admission[_-]?token|working[_-]?admission|qr[_-]?(?:payload|code)|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret|password|authorization|credential|cookie):[A-Za-z0-9_:.+-]+/i.test(value) ||
      /(?<!\d)(?:\+?1[.-]?)?\d{3}[.-]\d{3}[.-]\d{4}(?!\d)/.test(value)) return true;
  const ordinary = new Set(['a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'by', 'for', 'from', 'in', 'is', 'it', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'was', 'were', 'with']);
  const bearer = /\bbearer\+([A-Za-z0-9._+-]+)/gi;
  let match;
  while ((match = bearer.exec(value)) !== null) {
    if (match[1].length >= 8 || !ordinary.has(match[1].toLowerCase()) || value.slice(bearer.lastIndex).length === 0) return true;
  }
  const basic = /\bbasic\+([A-Za-z0-9+]+)/gi;
  while ((match = basic.exec(value)) !== null) {
    const token = match[1];
    if (token.length % 4 === 1) continue;
    try {
      const decoded = atob(token);
      if (btoa(decoded).replace(/=+$/, '') === token && decoded.includes(':') &&
          [...decoded].every(char => char.charCodeAt(0) >= 0x20 && char.charCodeAt(0) !== 0x7f)) return true;
    } catch { /* Not a canonical Basic credential candidate. */ }
  }
  return false;
}
export const validId = x => typeof x === 'string' && /^[a-zA-Z0-9_-][a-zA-Z0-9_:.+-]{0,199}$/.test(x) &&
  !/^(?:sk-|rk-|pk-|gh[pousr]_|AKIA[0-9A-Z]{16})/i.test(x) && !sensitiveIdentifier(x);
export function equalVersions(a, b) { return canonical(a) === canonical(b); }

/** Only a trusted, versioned brief/state projection may be passed here. */
export function createControlSchema(state, version = SCHEMA_VERSIONS.at(-1)) {
  state = snapshotControlJson(state);
  if (!SCHEMA_VERSIONS.includes(version)) throw new TypeError('Unsupported local schema version');
  if (!isRecord(state) || !validId(state.tenant_id) || !validId(state.project_id) ||
      !isRecord(state.versions) || Object.keys(state.versions).sort().join(',') !== 'brief,composition,design' ||
      Object.values(state.versions).some(v => !validId(v)) || !validId(state.brief_id) ||
      !Array.isArray(state.available_operations) || state.available_operations.some(x => !['composition.update', 'artwork.edit'].includes(x)) ||
      (state.locks !== undefined && (!Array.isArray(state.locks) || state.locks.some(x => !definitions.some(d => d.field === x)))) ||
      (state.follow_up_locks !== undefined && (!Array.isArray(state.follow_up_locks) || state.follow_up_locks.some(x => x !== 'q01'))) ||
      !isRecord(state.values) || !isRecord(state.allowed_options)) {
    throw new TypeError('Invalid trusted control state');
  }
  const controls = definitions.filter(d => state.available_operations.includes(d.route) &&
    // Logo controls require a separately permitted asset reference, never a client URL.
    (d.field !== 'logo_position' || validId(state.logo_asset_id))).map(d => {
      const configured = state.allowed_options[d.field];
      if (!Array.isArray(configured) || !configured.length || configured.some(x => !d.options.includes(x)) ||
          new Set(configured).size !== configured.length || !configured.includes(state.values[d.field])) {
        throw new TypeError('Invalid trusted option state');
      }
      return { id: d.id, label: d.label, kind: 'select', value_type: 'string', field: d.field,
        route: d.route, options: configured.map(value => ({ value, label: value[0].toUpperCase() + value.slice(1) })),
        default_value: state.values[d.field], locked: state.locks?.includes(d.field) === true,
        ...(d.field === 'logo_position' ? { asset_id: state.logo_asset_id } : {}) };
    });
  const hasLayout = controls.some(c => c.field === 'layout');
  if (hasLayout && (!isRecord(state.follow_up_answers) || Object.keys(state.follow_up_answers).some(k => k !== 'q01') ||
      !['balanced', 'name'].includes(state.follow_up_answers.q01))) throw new TypeError('Missing or invalid trusted follow-up baseline');
  return { schema_version: version, contract_status: 'local-consumer-proposal',
    tenant_id: state.tenant_id, project_id: state.project_id, brief_id: state.brief_id,
    expected_versions: { ...state.versions }, controls,
    follow_up_questions: hasLayout ? [{ id: 'q01', label: 'Stacked layout emphasis', field: 'layout_emphasis', route: 'composition.update',
      when: { control_id: 'c02', value: 'stacked' }, required: true,
      locked: state.follow_up_locks?.includes('q01') === true,
      options: [{ value: 'balanced', label: 'Balanced' }, { value: 'name', label: 'Name' }], default_value: state.follow_up_answers.q01 }] : [],
    submit_intent: 'apply', approval: false, purchase: false };
}

export function defaultDraft(schema) {
  schema = assertRenderableSchema(schema);
  const draft = { selections: Object.fromEntries(schema.controls.map(c => [c.id, c.default_value])), answers: {} };
  for (const q of activeQuestions(schema, draft)) draft.answers[q.id] = q.default_value;
  return draft;
}
export function activeQuestions(schema, draft) {
  schema = snapshotControlJson(schema); draft = snapshotControlJson(draft);
  return schema.follow_up_questions.filter(q => draft.selections[q.when.control_id] === q.when.value);
}

/** Defensive consumer check before rendering; application never executes schema strings. */
export function assertRenderableSchema(schema) {
  schema = snapshotControlJson(schema);
  if (!isRecord(schema) || !SCHEMA_VERSIONS.includes(schema.schema_version) ||
      schema.contract_status !== 'local-consumer-proposal' || !Array.isArray(schema.controls) || schema.controls.length > definitions.length ||
      !Array.isArray(schema.follow_up_questions) || schema.follow_up_questions.length > 1 ||
      !validId(schema.tenant_id) || !validId(schema.project_id) || !validId(schema.brief_id) || !isRecord(schema.expected_versions) ||
      Object.keys(schema.expected_versions).sort().join(',') !== 'brief,composition,design' || Object.values(schema.expected_versions).some(x => !validId(x)) ||
      schema.submit_intent !== 'apply' || schema.approval !== false || schema.purchase !== false) throw new TypeError('Unsupported controls');
  const only = (value, keys) => Object.keys(value).every(key => keys.includes(key));
  if (!only(schema, ['schema_version', 'contract_status', 'tenant_id', 'project_id', 'brief_id', 'expected_versions', 'controls', 'follow_up_questions', 'submit_intent', 'approval', 'purchase'])) throw new TypeError('Unsupported controls');
  const seen = new Set();
  for (const c of schema.controls) {
    const d = definitions.find(d => d.id === c.id);
    if (!only(c, ['id', 'label', 'kind', 'value_type', 'field', 'route', 'options', 'default_value', 'locked', 'asset_id']) ||
        c.options.some(o => !isRecord(o) || !only(o, ['value', 'label'])) || !d || seen.has(c.id) || c.kind !== 'select' || c.value_type !== 'string' || c.field !== d.field || c.route !== d.route ||
        c.label !== d.label || typeof c.locked !== 'boolean' || !Array.isArray(c.options) || !c.options.length ||
        c.options.some(o => !d.options.includes(o.value) || typeof o.label !== 'string' || o.label.length > 80) ||
        !c.options.some(o => o.value === c.default_value) || new Set(c.options.map(o => o.value)).size !== c.options.length ||
        c.options.some(o => o.label !== o.value[0].toUpperCase() + o.value.slice(1)) ||
        (c.field === 'logo_position' ? !validId(c.asset_id) : c.asset_id !== undefined)) throw new TypeError('Unsupported controls');
    seen.add(c.id);
  }
  for (const q of schema.follow_up_questions) {
    if (!only(q, ['id', 'label', 'field', 'route', 'when', 'required', 'locked', 'options', 'default_value']) ||
        !only(q.when, ['control_id', 'value']) || q.options.some(o => !isRecord(o) || !only(o, ['value', 'label'])) || q.id !== 'q01' || q.label !== 'Stacked layout emphasis' || q.when?.control_id !== 'c02' || q.when.value !== 'stacked' ||
        q.field !== 'layout_emphasis' || q.route !== 'composition.update' || typeof q.locked !== 'boolean' ||
        !['balanced', 'name'].includes(q.default_value) || q.required !== true || !Array.isArray(q.options) || q.options.length !== 2 ||
        new Set(q.options.map(o => o.value)).size !== 2 || q.options.some(o => !['balanced', 'name'].includes(o.value) || typeof o.label !== 'string' || o.label !== o.value[0].toUpperCase() + o.value.slice(1))) {
      throw new TypeError('Unsupported question');
    }
  }
  return schema;
}
