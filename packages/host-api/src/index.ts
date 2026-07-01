/**
 * Transport-agnostic host-api package surface.
 *
 * This package owns the shared HostOperationRequest/HostOperationResponse
 * protocol and the Promise HostClientHandle shape. Effect services/layers are
 * exported from the `/effect` subpath.
 */
export * from "./contracts/index.js";
export * from "./hostOperationCodec.js";
export * from "./hostOperationResponseHelpers.js";
export * from "./hostOperationValidation.js";
export * from "./hostClient.js";
