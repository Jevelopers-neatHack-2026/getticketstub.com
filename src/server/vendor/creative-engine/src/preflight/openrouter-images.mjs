import { createHash } from 'node:crypto';
import { AccessPreflightError } from './access.mjs';
import { canonicalHash } from '../contracts/validation.mjs';

// CE-A01 provider-metadata adapter for the OpenRouter Images target. It performs only the two documented
// non-billable reads through an injected fetch: GET /api/v1/key (authentication) and the public image-model
// endpoint catalog. Neither read is entitlement: operation permission and quota are always reported UNKNOWN and
// must come from the separately injected capability verifier. Nothing here reads the environment, selects a
// model, follows redirects, or retries. Billable dispatch is supplied by the trusted host composition.
//
// `model_listing: 'listed'` means only that the catalog lists the pinned provider tag for the pinned model. It is not a
// profile match: prices, supported parameters and capabilities may differ from what the owner approved. A host that
// wants that comparison pins `catalog_entry_sha256` in the target configuration (the hash this module computes over
// the live entry's provider_tag, supported_parameters and pricing); a differing live entry then reports 'unknown'.
//
// Billable path obligations. With a `dispatchPort`, this module resolves the credential itself (purpose
// authorized_billable_operation, bound to the grant and the exact target, valid through the operation deadline)
// before the port runs, and passes it as `credential`. The host port must still: send exactly one request using only
// that credential, enforce the pinned provider tag / no fallbacks / the pinned profile, honor the abort `signal`
// derived from the deadline, run the metering fence calls (recordTransportAttempt, authorizeTransport,
// assertTransportReady) in order, and never log or return the token. The credential is never placed in the
// prepared value the runner sees.
//
// Host verification obligations (this adapter delegates them; the direct OpenAI adapter does them itself through its
// prompt and asset ports). Before it sends the request the host port must verify that the rendered prompt hashes to
// `configuration.prompt_template_sha256` and, for an edit, that the asset bytes hash to `configuration.asset_sha256`
// with media type `configuration.asset_mime`; this module has no prompt or asset port and does not see those bytes.
// It also treats the clock as untrusted-after-construction: every read must be finite or the operation is refused.

export const OPENROUTER_PREFLIGHT_SERVICE = 'openrouter';
export const OPENROUTER_PREFLIGHT_IMAGES_ENDPOINT = 'https://openrouter.ai/api/v1/images';
export const OPENROUTER_PREFLIGHT_KEY_ENDPOINT = 'https://openrouter.ai/api/v1/key';
const CATALOG_PREFIX = 'https://openrouter.ai/api/v1/images/models/';
const MODEL_ID = /^([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})$/;
const PROVIDER_TAG = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/;
const HASH = /^sha256:[a-f0-9]{64}$/;
const hashString = (value) => typeof value === 'string' && HASH.test(value);
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,255}$/;
const MAX_METADATA_BYTES = 2 * 1024 * 1024;
const METADATA_TIMEOUT_MS = 15_000;

function error(code, message) {
  return new AccessPreflightError(code, message);
}

/**
 * Every clock read goes through this helper. A clock that stops returning a finite number after construction fails
 * closed (no credential, no fetch, no host port) instead of letting NaN comparisons evaluate false and pass.
 */
function readClock(now) {
  let value;
  try { value = now(); } catch { value = undefined; }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw error('adapter_unavailable', 'The clock option must return a finite number of milliseconds.');
  }
  return value;
}

function digest(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function targetBinding(target, scope) {
  return {
    service: target.service,
    endpoint: target.endpoint,
    model: target.model,
    sdk_name: target.sdk.name,
    sdk_version: target.sdk.version,
    configuration_sha256: target.configuration_sha256,
    account_ref: scope.account_ref,
    project_ref: scope.project_ref,
  };
}

/** The catalog URL for an explicit author/slug model id. Segments are encoded; nothing else is interpolated. */
export function openRouterCatalogEndpoint(modelId) {
  const match = typeof modelId === 'string' ? MODEL_ID.exec(modelId) : null;
  if (!match) throw error('unsupported_image_configuration', 'OpenRouter model id must be an explicit author/slug.');
  return `${CATALOG_PREFIX}${encodeURIComponent(match[1])}/${encodeURIComponent(match[2])}/endpoints`;
}

/**
 * Validate that a preflight target is an exact OpenRouter Images pin for one of the two image cells.
 * Generation and edit remain separate cells: edit alone carries the pinned source asset, and the pinned
 * profile hash is the owner-approved digest of the exact adapter profile (model, provider tag, capabilities,
 * descriptors, configuration). Nothing is defaulted.
 */
export function validateOpenRouterImageTarget(cellId, target) {
  if (cellId !== 'image_generation' && cellId !== 'image_edit') {
    throw error('unsupported_image_configuration', 'OpenRouter image targets exist only for the two image cells.');
  }
  if (!target || target.service !== OPENROUTER_PREFLIGHT_SERVICE || target.sdk?.name !== 'native-fetch'
    || target.sdk?.version !== process.versions.node) {
    throw error('unsupported_image_configuration', 'OpenRouter image preflight requires service openrouter and the actual pinned Node native-fetch runtime version.');
  }
  if (target.endpoint !== OPENROUTER_PREFLIGHT_IMAGES_ENDPOINT || typeof target.model !== 'string' || !MODEL_ID.test(target.model)) {
    throw error('unsupported_image_configuration', 'OpenRouter endpoint and explicit author/slug model must match the pin.');
  }
  const config = target.configuration;
  const required = ['prompt_template_ref', 'prompt_template_sha256', 'provider_tag', 'profile_sha256',
    ...(cellId === 'image_edit' ? ['asset_ref', 'asset_sha256', 'asset_mime'] : [])];
  // Optional pin of the expected live catalog entry (see the header). It is part of the configuration, so the
  // target's canonical configuration hash binds it.
  const allowed = [...required, 'catalog_entry_sha256'];
  if (!config || typeof config !== 'object' || Array.isArray(config)
    || Object.keys(config).some((key) => !allowed.includes(key)) || required.some((key) => !Object.hasOwn(config, key))
    || typeof config.prompt_template_ref !== 'string' || !ID.test(config.prompt_template_ref)
    || !hashString(config.prompt_template_sha256) || !hashString(config.profile_sha256)
    || (Object.hasOwn(config, 'catalog_entry_sha256') && !hashString(config.catalog_entry_sha256))
    || typeof config.provider_tag !== 'string' || !PROVIDER_TAG.test(config.provider_tag)) {
    throw error('unsupported_image_configuration', 'OpenRouter configuration must pin the prompt, provider tag, and profile hash for exactly this cell.');
  }
  if (cellId === 'image_edit' && (typeof config.asset_ref !== 'string' || !ID.test(config.asset_ref)
    || !hashString(config.asset_sha256) || !['image/png', 'image/jpeg', 'image/webp'].includes(config.asset_mime))) {
    throw error('unsupported_image_configuration', 'Edit requires a pinned reference asset reference, digest, and image media type.');
  }
}

/**
 * Re-validates a target and returns a canonical digest over exactly the fields the binding uses (the target's
 * identity is compared by reference at dispatch, so its content must be pinned separately). Fields the validator and
 * the binding never read are not hashed; anything that cannot be validated or hashed fails closed.
 */
function targetContentDigest(cellId, target) {
  try {
    validateOpenRouterImageTarget(cellId, target);
    return canonicalHash({ service: target.service, endpoint: target.endpoint, model: target.model,
      sdk: { name: target.sdk.name, version: target.sdk.version }, configuration: target.configuration,
      configuration_sha256: target.configuration_sha256 });
  } catch {
    throw error('unsupported_image_configuration', 'The OpenRouter image target changed or cannot be canonically hashed.');
  }
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Reflect.ownKeys(value)) deepFreeze(value[key]);
  }
  return value;
}

/**
 * The host never receives the caller's live target: it gets a deep-frozen structured clone, so a caller mutating its
 * object while the host awaits (and restoring it before the digest check) cannot change what the host acts on. The
 * clone keeps non-JSON extra fields (Date, NaN, undefined); a target holding something structuredClone cannot copy
 * (a function, a symbol value) fails closed, and so does a clone whose binding digest differs from the original's.
 */
function freezeTargetCopy(cellId, target, digestOfTarget) {
  let copy;
  try {
    copy = deepFreeze(structuredClone(target));
    if (targetContentDigest(cellId, copy) !== digestOfTarget) throw new TypeError('target copy');
  } catch {
    throw error('unsupported_image_configuration', 'The OpenRouter image target cannot be copied for the host port.');
  }
  return copy;
}

function safeCredentialEvidence(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.ref !== 'string' || !SAFE_REF.test(value.ref)
    || typeof value.sha256 !== 'string' || !HASH.test(value.sha256)
    || typeof value.pinned_revision !== 'string' || !SAFE_REF.test(value.pinned_revision)
    || !value.independent_review || typeof value.independent_review.ref !== 'string'
    || !SAFE_REF.test(value.independent_review.ref) || typeof value.independent_review.sha256 !== 'string'
    || !HASH.test(value.independent_review.sha256)) {
    throw error('credential_unavailable', 'Credential identity evidence is not independently pinned.');
  }
}

async function resolveCredential(credentialPort, { purpose = 'read_only_account_check', scope, target, grantRef, deadlineAt, now }) {
  try {
    if (!SAFE_REF.test(scope.account_ref) || !SAFE_REF.test(scope.project_ref)) {
      throw error('credential_unavailable', 'Provider account and project references must be safe opaque IDs.');
    }
    const binding = targetBinding(target, scope);
    const resolved = await credentialPort.resolveCredential({
      service: OPENROUTER_PREFLIGHT_SERVICE,
      purpose,
      account_ref: scope.account_ref,
      project_ref: scope.project_ref,
      target_binding: binding,
      ...(grantRef ? { grant_ref: grantRef } : {}),
    });
    const expectedBindingHash = digest(Buffer.from(JSON.stringify(binding), 'utf8'));
    if (!resolved || typeof resolved !== 'object' || Array.isArray(resolved)
      || resolved.decision !== 'resolved' || resolved.evidence_mode !== 'live') {
      throw error('credential_unavailable', 'Trusted credential resolver did not confirm this provider scope.');
    }
    const allowedBindingFields = ['service', 'account_ref', 'project_ref', 'target_binding_sha256', ...(grantRef ? ['grant_ref'] : [])];
    if (!resolved.binding || Object.keys(resolved.binding).some((key) => !allowedBindingFields.includes(key))
      || resolved.binding.service !== OPENROUTER_PREFLIGHT_SERVICE
      || resolved.binding.account_ref !== scope.account_ref || resolved.binding.project_ref !== scope.project_ref
      || resolved.binding.target_binding_sha256 !== expectedBindingHash
      || (grantRef && resolved.binding.grant_ref !== grantRef)) {
      throw error('credential_unavailable', 'Credential identity does not match the requested provider account and project.');
    }
    if (typeof resolved.token !== 'string' || resolved.token.trim().length === 0 || /[\r\n]/.test(resolved.token)) {
      throw error('credential_unavailable', 'Trusted credential resolver did not return a usable bearer token.');
    }
    safeCredentialEvidence(resolved.evidence);
    if (typeof resolved.expires_at !== 'string' || !Number.isFinite(Date.parse(resolved.expires_at))
      || Date.parse(resolved.expires_at) <= readClock(now)
      || (deadlineAt && Date.parse(resolved.expires_at) < Date.parse(deadlineAt))) {
      throw error('credential_unavailable', 'Scoped credential is expired or will not remain valid through the operation deadline.');
    }
    return resolved.token;
  } catch {
    throw error('credential_unavailable', 'Credential provider did not return a usable access token.');
  }
}

async function boundedJson(response) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > MAX_METADATA_BYTES) {
    try { await response.body?.cancel(); } catch { /* nothing provider-specific leaves the adapter */ }
    return undefined;
  }
  const reader = response.body?.getReader?.();
  if (!reader) return undefined;
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > MAX_METADATA_BYTES) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks, total).toString('utf8'));
  } catch {
    return undefined;
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Authentication result of the non-billable key read. Balance, limits and usage are never retained. */
function mapKeyStatus(status) {
  if (status === 200) return 'confirmed';
  if (status === 401) return 'denied';
  return 'unknown';
}

function catalogEntries(payload) {
  const data = payload?.data;
  if (Array.isArray(data)) return data;
  if (isRecord(data) && Array.isArray(data.endpoints)) return data.endpoints;
  if (Array.isArray(payload?.endpoints)) return payload.endpoints;
  return undefined;
}

async function metadataFetch(fetchImpl, url, headers) {
  return fetchImpl(url, {
    method: 'GET',
    headers,
    redirect: 'error',
    cache: 'no-store',
    signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
  });
}

/**
 * OpenRouter Images access adapter. `fetchImpl` is required (no global default) and `credentialPort` must be a
 * trusted account/project-bound resolver. `inspect` is the only built-in operation; `prepare` and `dispatch`
 * exist only if the host passes a trusted `dispatchPort` that performs the one authorized billable request, so
 * this module never sends a paid request by itself. The built-in catalog check is not entitlement.
 */
export function createOpenRouterImagesAdapter({ credentialPort, fetchImpl, dispatchPort, now = Date.now }) {
  if (typeof now !== 'function') throw error('adapter_unavailable', 'The clock option must be a function returning a finite number of milliseconds.');
  readClock(now);
  if (!credentialPort || credentialPort.evidence_mode !== 'live' || typeof credentialPort.resolveCredential !== 'function') {
    throw error('credential_unavailable', 'A trusted account/project-bound credential resolver is required.');
  }
  if (typeof fetchImpl !== 'function') {
    throw error('adapter_unavailable', 'An explicit fetch implementation is required; no global transport is used.');
  }
  if (dispatchPort !== undefined && (!dispatchPort || typeof dispatchPort.dispatch !== 'function'
    || (dispatchPort.prepare !== undefined && typeof dispatchPort.prepare !== 'function'))) {
    throw error('adapter_unavailable', 'The billable dispatch port must provide dispatch and optionally prepare.');
  }
  const adapter = {
    evidence_mode: 'live',

    async inspect({ run_id, cell_id, target, scope }) {
      validateOpenRouterImageTarget(cell_id, target);
      readClock(now);
      const token = await resolveCredential(credentialPort, { scope, target, now }).catch(() => {
        throw error('credential_unavailable', 'Read-only account authentication could not be checked.');
      });
      const catalogUrl = openRouterCatalogEndpoint(target.model);
      let keyStatus;
      let catalogStatus;
      let catalogPayload;
      try {
        const keyResponse = await metadataFetch(fetchImpl, OPENROUTER_PREFLIGHT_KEY_ENDPOINT,
          { authorization: `Bearer ${token}`, accept: 'application/json' });
        keyStatus = keyResponse.status;
        if (keyResponse.ok) {
          // Only the documented object shape is checked; limit, remaining credit, and usage are not retained.
          const keyPayload = await boundedJson(keyResponse);
          if (!isRecord(keyPayload?.data)) keyStatus = 0;
        } else {
          try { await keyResponse.body?.cancel(); } catch { /* ignore */ }
        }
        // The catalog is public: the bearer token is deliberately not sent to it.
        const catalogResponse = await metadataFetch(fetchImpl, catalogUrl, { accept: 'application/json' });
        catalogStatus = catalogResponse.status;
        if (catalogResponse.ok) catalogPayload = await boundedJson(catalogResponse);
        else { try { await catalogResponse.body?.cancel(); } catch { /* ignore */ } }
      } catch {
        throw error('access_probe_unavailable', 'Read-only provider access check failed.');
      }
      const authentication = mapKeyStatus(keyStatus);
      let modelListing = 'unknown';
      let catalogEntryDigest = null;
      let listingReason;
      if (catalogStatus === 200) {
        const entries = catalogEntries(catalogPayload);
        if (entries) {
          const entry = entries.find((candidate) => isRecord(candidate) && candidate.provider_tag === target.configuration.provider_tag);
          modelListing = entry ? 'listed' : 'not_listed';
          if (entry) {
            try {
              catalogEntryDigest = canonicalHash({ provider_tag: entry.provider_tag,
                supported_parameters: entry.supported_parameters ?? null, pricing: entry.pricing ?? null });
            } catch { catalogEntryDigest = null; }
            // A pinned entry hash upgrades 'listed' from tag presence to an exact comparison; any difference (or an
            // entry that cannot be hashed) fails closed as 'unknown', never as 'listed'.
            const expectedEntry = target.configuration.catalog_entry_sha256;
            if (expectedEntry !== undefined && catalogEntryDigest !== expectedEntry) {
              modelListing = 'unknown';
              listingReason = 'catalog_entry_mismatch';
            }
          }
        }
      } else if (catalogStatus === 404) {
        modelListing = 'not_listed';
      }
      const binding = targetBinding(target, scope);
      return {
        evidence_mode: 'live',
        target: binding,
        authentication,
        model_listing: modelListing,
        // Catalog presence and a valid key are not entitlement: only the capability verifier can establish these.
        operation_permission: 'unknown',
        quota: 'unknown',
        checked_at: new Date(readClock(now)).toISOString(),
        evidence: {
          ref: `${run_id}:${cell_id}:openrouter-key-and-catalog`,
          sha256: digest(Buffer.from(JSON.stringify({ key_status: keyStatus, catalog_status: catalogStatus,
            model_listing: modelListing, catalog_entry_sha256: catalogEntryDigest, cell_id, target: binding,
            ...(listingReason ? { listing_reason: listingReason } : {}) }), 'utf8')),
        },
      };
    },
  };
  if (dispatchPort) {
    // The runner passes `prepared` from prepare to dispatch. Only values this adapter minted are accepted, so a
    // dispatch cannot reach the host port without a credential that was resolved for this grant and deadline.
    const preparedState = new WeakMap();
    adapter.prepare = async (input) => {
      // Binding fields are snapshotted once, before any await. The host receives these values (scope as a frozen copy)
      // and nothing after the first await reads them from `input`, so neither the caller nor the host port can move
      // the binding to another project by mutating a live object. The target keeps identity semantics for dispatch,
      // so its content is pinned by a canonical digest instead and re-checked after each await.
      const { cell_id, target, grant_ref, deadline_at } = input;
      validateOpenRouterImageTarget(cell_id, target);
      if (typeof grant_ref !== 'string' || !SAFE_REF.test(grant_ref)
        || typeof deadline_at !== 'string' || !Number.isFinite(Date.parse(deadline_at))
        || Date.parse(deadline_at) <= readClock(now)) {
        throw error('credential_unavailable', 'A billable credential needs the authorized grant reference and an unexpired operation deadline.');
      }
      let scope;
      let hostScope;
      try {
        // Each ref is read exactly once; a throwing getter or a non-record scope fails closed.
        const liveScope = input.scope;
        if (!isRecord(liveScope)) throw new TypeError('scope');
        const account_ref = liveScope.account_ref;
        const project_ref = liveScope.project_ref;
        if (typeof account_ref !== 'string' || typeof project_ref !== 'string') throw new TypeError('scope refs');
        scope = Object.freeze({ account_ref, project_ref });
        // The host keeps seeing any other scope fields (tenant, budget) as before, but as a frozen copy.
        hostScope = Object.freeze({ ...liveScope, account_ref, project_ref });
      } catch {
        throw error('credential_unavailable', 'A billable credential needs a provider account and project scope.');
      }
      const targetDigest = targetContentDigest(cell_id, target);
      const hostTarget = freezeTargetCopy(cell_id, target, targetDigest);
      const assertTargetUnchanged = () => {
        if (targetContentDigest(cell_id, target) !== targetDigest) {
          throw error('unsupported_image_configuration', 'The OpenRouter image target changed after it was validated.');
        }
      };
      const token = await resolveCredential(credentialPort, { purpose: 'authorized_billable_operation', scope,
        target: hostTarget, grantRef: grant_ref, deadlineAt: deadline_at, now });
      const credential = Object.freeze({ token });
      assertTargetUnchanged();
      // The credential await may outlast the deadline (or the clock may fault), so re-check before the host prepare.
      if (Date.parse(deadline_at) <= readClock(now)) {
        throw error('preflight_deadline_passed', 'The approved operation deadline passed while the credential was resolved.');
      }
      const hostPrepared = dispatchPort.prepare
        ? await dispatchPort.prepare({ ...input, cell_id, target: hostTarget, configuration: hostTarget.configuration, grant_ref, deadline_at,
          scope: hostScope, credential }) : undefined;
      assertTargetUnchanged();
      const prepared = Object.freeze({ prepared: true });
      preparedState.set(prepared, { cell_id, target, hostTarget, targetDigest, grant_ref, scope, hostScope, deadline_at, credential, hostPrepared });
      return prepared;
    };
    adapter.dispatch = async (input) => {
      // One snapshot of the caller's input: each own enumerable property is read exactly once (so a getter cannot
      // answer differently for the checks and for the host), and only `args` is used from here on.
      let args;
      try {
        if (!isRecord(input)) throw new TypeError('input');
        args = { ...input };
      } catch {
        throw error('credential_unavailable', 'The dispatch input could not be read.');
      }
      validateOpenRouterImageTarget(args.cell_id, args.target);
      const state = isRecord(args.prepared) ? preparedState.get(args.prepared) : undefined;
      let accountRef;
      let projectRef;
      try {
        if (isRecord(args.scope)) { accountRef = args.scope.account_ref; projectRef = args.scope.project_ref; }
      } catch { accountRef = undefined; projectRef = undefined; }
      if (!state || state.cell_id !== args.cell_id || state.target !== args.target
        || state.grant_ref !== args.grant_ref || state.deadline_at !== args.deadline_at
        || !isRecord(args.scope) || accountRef !== state.scope.account_ref || projectRef !== state.scope.project_ref) {
        throw error('credential_unavailable', 'Prepared credentials are not bound to this grant, deadline, scope, and target.');
      }
      // A prepared value is single use: it is consumed before the host port can run, so a replay is refused. That
      // includes a refusal below: a target whose content moved since prepare consumes the value and fails closed.
      preparedState.delete(args.prepared);
      const remaining = Date.parse(state.deadline_at) - readClock(now);
      if (!Number.isFinite(remaining) || remaining <= 0) throw error('preflight_deadline_passed', 'The approved operation deadline has passed.');
      // The runner passes its cancellation signal (operator abort combined with the operation deadline) as
      // `metering.signal`. The host port gets that signal combined with this adapter's own deadline timeout.
      const callerSignal = args.metering?.signal;
      if (callerSignal !== undefined && !(callerSignal instanceof AbortSignal)) {
        throw error('adapter_unavailable', 'The runner cancellation signal must be a native AbortSignal.');
      }
      const timeout = AbortSignal.timeout(Math.min(remaining, 120_000));
      // The bound fields come from the prepared state after the spread, as in prepare: the host sees the values that
      // were checked and bound, never a re-read of the caller's input. The host gets the frozen target copy made at prepare.
      const hostArgs = { ...args, cell_id: state.cell_id, target: state.hostTarget, configuration: state.hostTarget.configuration,
        grant_ref: state.grant_ref, deadline_at: state.deadline_at, scope: state.hostScope,
        prepared: state.hostPrepared, credential: state.credential,
        signal: callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout };
      // The target content check runs last, immediately before the host port. It confirms the caller's target object
      // still matches what was validated; the host only ever receives the frozen copy, never that live object.
      if (targetContentDigest(state.cell_id, state.target) !== state.targetDigest) {
        throw error('unsupported_image_configuration', 'The OpenRouter image target changed after it was prepared.');
      }
      return dispatchPort.dispatch(hostArgs);
    };
  } else {
    adapter.dispatch = async () => {
      throw error('adapter_unavailable', 'No trusted OpenRouter billable dispatch port was composed.');
    };
  }
  return Object.freeze(adapter);
}
