/**
 * Transport-agnostic host-api package surface.
 *
 * This package owns the shared HostApiRequest/HostApiResponse protocol and the
 * Promise HostClientHandle shape. Effect services/layers are exported from the
 * `/effect` subpath.
 */
export * from "./contracts/index.js";
export * from "./hostApiCodec.js";
export * from "./hostApiResponseHelpers.js";
export * from "./hostApiValidation.js";
export * from "./hostClient.js";
