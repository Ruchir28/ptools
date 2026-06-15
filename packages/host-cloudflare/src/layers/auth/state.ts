import { AuthCoordinator, CredentialsStore } from "@ptools/auth";
import { Layer } from "effect";
import {
  CodeModeObjectIdentity,
  CodeModeObjectRequestOrigin,
  CodeModeObjectStorage,
} from "../platform.js";
import { AuthCoordinatorLayer } from "./authCoordinatorLayer.js";
import { DurableObjectAuthCoreLayer } from "./durableObjectAuthCoreLayer.js";
import { CloudflareOAuthFlow } from "./oauthFlow.js";
import { CloudflareOAuthFlowLayer } from "./oauthFlowLayer.js";

/**
 * Durable Object auth composition.
 *
 * Provides:
 * - AuthCoordinator for shared MCP registry/connector code.
 * - CloudflareOAuthFlow for Worker/DO browser OAuth routes.
 *
 * Requires:
 * - CredentialsStore
 * - CodeModeObjectStorage
 * - CodeModeObjectIdentity
 * - CodeModeObjectRequestOrigin
 */
export const DurableObjectAuthLayer: Layer.Layer<
  AuthCoordinator | CloudflareOAuthFlow,
  never,
  | CredentialsStore
  | CodeModeObjectStorage
  | CodeModeObjectIdentity
  | CodeModeObjectRequestOrigin
> = Layer.merge(AuthCoordinatorLayer, CloudflareOAuthFlowLayer).pipe(
  Layer.provide(DurableObjectAuthCoreLayer),
);
