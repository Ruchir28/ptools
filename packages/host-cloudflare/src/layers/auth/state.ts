import { AuthCoordinator, McpOAuthStateStore } from "@ptools/auth";
import { HostSecretStorage } from "@ptools/config";
import { Layer } from "effect";
import {
  CodeModeObjectIdentity,
  CodeModeObjectRequestOrigin,
} from "../platform.js";
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
 * - HostSecretStorage
 * - McpOAuthStateStore
 * - CodeModeObjectIdentity
 * - CodeModeObjectRequestOrigin
 */
export const DurableObjectAuthLayer: Layer.Layer<
  AuthCoordinator | CloudflareOAuthFlow,
  never,
  | HostSecretStorage
  | McpOAuthStateStore
  | CodeModeObjectIdentity
  | CodeModeObjectRequestOrigin
> = Layer.merge(AuthCoordinator.Default, CloudflareOAuthFlowLayer).pipe(
  Layer.provide(DurableObjectAuthCoreLayer),
);
