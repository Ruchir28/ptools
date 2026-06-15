import { AuthProviderFactory, CredentialsStore } from "@ptools/auth";
import { Effect, Layer } from "effect";
import {
  CodeModeObjectIdentity,
  CodeModeObjectRequestOrigin,
  CodeModeObjectStorage,
} from "../platform.js";
import { CloudflareOAuthProvider } from "./provider.js";
import type { CloudflareOAuthPlatform } from "./types.js";

/**
 * Cloudflare OAuth provider factory.
 *
 * The shared auth core controls provider caching and status transitions. This
 * layer only constructs MCP SDK OAuth providers with Cloudflare Durable Object
 * platform dependencies.
 *
 * Requires:
 * - CredentialsStore
 * - CodeModeObjectStorage
 * - CodeModeObjectIdentity
 * - CodeModeObjectRequestOrigin
 *
 * Provides:
 * - AuthProviderFactory
 */
export const CloudflareAuthProviderFactoryLayer: Layer.Layer<
  AuthProviderFactory,
  never,
  | CredentialsStore
  | CodeModeObjectStorage
  | CodeModeObjectIdentity
  | CodeModeObjectRequestOrigin
> = Layer.effect(
  AuthProviderFactory,
  Effect.gen(function* () {
    const platform = yield* makeCloudflareOAuthPlatform;

    return AuthProviderFactory.of({
      makeProvider: (input) =>
        Effect.succeed(
          new CloudflareOAuthProvider({
            platform,
            serverName: input.serverName,
            config: input.config,
            onAuthorizationUrl: input.onAuthorizationUrl,
          }),
        ),
    });
  }),
);

const makeCloudflareOAuthPlatform: Effect.Effect<
  CloudflareOAuthPlatform,
  never,
  | CredentialsStore
  | CodeModeObjectStorage
  | CodeModeObjectIdentity
  | CodeModeObjectRequestOrigin
> = Effect.gen(function* () {
  const storage = yield* CodeModeObjectStorage;
  const identity = yield* CodeModeObjectIdentity;
  const requestOrigin = yield* CodeModeObjectRequestOrigin;
  const credentialsStore = yield* CredentialsStore;

  return {
    storage,
    credentialsStore,
    hostId: identity.hostId,
    origin: requestOrigin.origin,
  };
});
