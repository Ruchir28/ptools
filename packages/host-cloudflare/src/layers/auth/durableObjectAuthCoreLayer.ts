import {
  AuthCoordinatorCore,
  McpOAuthCredentialStore,
  McpOAuthStateStore,
} from "@ptools/auth";
import { HostSecretStorage } from "@ptools/config";
import { Layer } from "effect";
import {
  CodeModeObjectIdentity,
  CodeModeObjectRequestOrigin,
} from "../platform.js";
import { CloudflareAuthPolicyLayer } from "./policy.js";
import { CloudflareAuthProviderFactoryLayer } from "./providerFactory.js";

/**
 * Cloudflare binding of the shared AuthCoordinatorCore.
 *
 * This composes the shared in-memory auth state machine with Cloudflare URL
 * policy and Cloudflare OAuth provider construction.
 *
 * Requires:
 * - HostSecretStorage
 * - McpOAuthStateStore
 * - CodeModeObjectIdentity
 * - CodeModeObjectRequestOrigin
 *
 * Provides:
 * - AuthCoordinatorCore
 */
export const DurableObjectAuthCoreLayer: Layer.Layer<
  AuthCoordinatorCore,
  never,
  | HostSecretStorage
  | McpOAuthStateStore
  | CodeModeObjectIdentity
  | CodeModeObjectRequestOrigin
> = AuthCoordinatorCore.Default.pipe(
  Layer.provide(
    CloudflareAuthProviderFactoryLayer.pipe(
      Layer.provide(McpOAuthCredentialStore.Default),
    ),
  ),
  Layer.provide(CloudflareAuthPolicyLayer),
);
