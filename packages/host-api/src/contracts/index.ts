/**
 * Public host-api DTO contract surface.
 *
 * This module re-exports the transport-agnostic request/response schemas owned
 * by `@ptools/host-api`. Platform packages should import shared host protocol
 * DTOs from `@ptools/host-api/contracts` when they do not need codecs,
 * validation helpers, Promise handles, or Effect service tags.
 */
export * from "./configureHost.js";
export * from "./controlPlaneHttp.js";
export * from "./hostOperationEnvelope.js";
export * from "./hostOperationDispatch.js";
export * from "./hostCodeMode.js";
export * from "./hostMcpAuth.js";
export * from "./hostSecrets.js";
