import {
  AuthCoordinatorCore,
  AuthCoordinatorCoreLayer,
  CredentialsStore,
} from "@ptools/auth";
import { Layer } from "effect";
import {
  CodeModeObjectIdentity,
  CodeModeObjectRequestOrigin,
  CodeModeObjectStorage,
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
 * - CredentialsStore
 * - CodeModeObjectStorage
 * - CodeModeObjectIdentity
 * - CodeModeObjectRequestOrigin
 *
 * Provides:
 * - AuthCoordinatorCore
 */
export const DurableObjectAuthCoreLayer: Layer.Layer<
  AuthCoordinatorCore,
  never,
  | CredentialsStore
  | CodeModeObjectStorage
  | CodeModeObjectIdentity
  | CodeModeObjectRequestOrigin
> = AuthCoordinatorCoreLayer.pipe(
  Layer.provide(CloudflareAuthProviderFactoryLayer),
  Layer.provide(CloudflareAuthPolicyLayer),
);
