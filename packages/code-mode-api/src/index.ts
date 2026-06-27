/**
 * Default Code Mode API package surface.
 *
 * This entrypoint exposes transport-agnostic DTO contracts, validation helpers,
 * typed errors, and the Promise client handle. Effect service tags live under
 * `@ptools/code-mode-api/effect`; shared DTOs are also available from the
 * explicit `@ptools/code-mode-api/contracts` subpath.
 */
export * from "./contracts/index.js";
export * from "./validation/codeModeRequestValidation.js";
export * from "./validation/codeModeResponseValidation.js";
export * from "./codeModeClientHandle.js";
export * from "./codeModeErrors.js";
export type * from "./codeModeOperationTypes.js";
