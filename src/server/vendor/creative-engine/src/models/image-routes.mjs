// Dependency-free allowlist of native image provider routes. The runtime, the concepts
// contract, and the version store use it instead of hard-coding one provider name and
// endpoint. An entry is an exact allow decision for one provider name, its exact HTTPS
// endpoints, and the operation kind recorded in the dispatch target binding. Nothing here
// grants access, selects a model, or implies entitlement.

export const IMAGE_PROVIDER_ROUTES = Object.freeze({
  openai: Object.freeze({
    name: "openai",
    generation_endpoint: "https://api.openai.com/v1/images/generations",
    edit_endpoint: "https://api.openai.com/v1/images/edits",
    concept_mapping_ref: "creative-engine/concepts-to-openai-images-edit/1",
    /** Direct masked/parent image edit. */
    edit_binding_operation_kind: "image_edit",
  }),
  openrouter: Object.freeze({
    name: "openrouter",
    generation_endpoint: "https://openrouter.ai/api/v1/images",
    edit_endpoint: "https://openrouter.ai/api/v1/images",
    concept_mapping_ref: "creative-engine/concepts-to-openrouter-images-reference-edit/1",
    /** Reference-guided image-to-image: there is no mask and no documented parent preservation. */
    edit_binding_operation_kind: "image_reference_edit",
  }),
});

/** Own-property lookup so prototype names such as "constructor" never match. */
export function imageProviderRoute(name) {
  return typeof name === "string" && Object.hasOwn(IMAGE_PROVIDER_ROUTES, name) ? IMAGE_PROVIDER_ROUTES[name] : undefined;
}
