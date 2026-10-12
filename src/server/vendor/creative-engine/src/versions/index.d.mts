import type { CreativeCompositionVersionStoreMethods, CreativeConceptVersionStoreMethods } from "../api/v1.mjs";

declare module "./store.mjs" {
  interface CreativeVersionStore extends CreativeConceptVersionStoreMethods {}
  interface CreativeVersionStore extends CreativeCompositionVersionStoreMethods {}
}

export { createCreativeVersionApiPorts } from "./api-ports.mjs";
export type {
  CreateCreativeVersionApiPortsOptions,
  CreativeVersionApiPorts,
  CreativeVersionRuntimeJobs,
  CreativeVersionRuntimePlanning,
  CreativeVersionRuntimePorts,
  CreativeVersionRuntimeStorage,
} from "./api-ports.mjs";
export {
  CreativeVersionStore,
  VersionStoreError,
} from "./store.mjs";
export type {
  BriefActionResult,
  PreparedVersion,
  SavedVersion,
  StaleVersion,
  VersionScope,
  VersionSelectionInput,
  VersionStoreErrorCode,
  VersionWriteInput,
  VersionWriteResult,
} from "./store.mjs";
