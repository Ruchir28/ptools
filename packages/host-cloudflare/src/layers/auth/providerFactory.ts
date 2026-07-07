import {
  AuthProviderFactory,
  McpOAuthCredentialStore,
  McpOAuthStateStore,
} from "@ptools/auth";
import { Effect, Layer } from "effect";
import {
  CodeModeObjectIdentity,
  CodeModeObjectRequestOrigin,
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
 * - McpOAuthCredentialStore
 * - McpOAuthStateStore
 * - CodeModeObjectIdentity
 * - CodeModeObjectRequestOrigin
 *
 * Provides:
 * - AuthProviderFactory
 */
export const CloudflareAuthProviderFactoryLayer: Layer.Layer<
  AuthProviderFactory,
  never,
  | McpOAuthCredentialStore
  | McpOAuthStateStore
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
  | McpOAuthCredentialStore
  | McpOAuthStateStore
  | CodeModeObjectIdentity
  | CodeModeObjectRequestOrigin
> = Effect.gen(function* () {
  const oauthCredentials = yield* McpOAuthCredentialStore;
  const oauthStateStore = yield* McpOAuthStateStore;
  const identity = yield* CodeModeObjectIdentity;
  const requestOrigin = yield* CodeModeObjectRequestOrigin;

  return {
    oauthCredentials,
    oauthStateStore,
    hostId: identity.hostId,
    origin: requestOrigin.origin,
  };
});
