import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import {
  AuthCoordinatorCore,
  AuthError,
  isDynamicClientRegistrationUnsupported,
  safeErrorMessage,
  type HttpMcpConfig,
} from "@ptools/auth";
import { Effect, Layer, Option } from "effect";
import { CodeModeObjectIdentity, CodeModeObjectStorage } from "../platform.js";
import { CloudflareOAuthFlow } from "./oauthFlow.js";

/**
 * Cloudflare-only route-facing OAuth service for Worker/DO browser OAuth.
 *
 * Worker routes call typed CodeModeObject RPC methods. The Durable Object uses
 * this service to begin or finish OAuth while sharing AuthCoordinatorCore with
 * the MCP connector-facing AuthCoordinator.
 *
 * Requires:
 * - AuthCoordinatorCore
 * - CodeModeObjectStorage
 * - CodeModeObjectIdentity
 *
 * Provides:
 * - CloudflareOAuthFlow
 */
export const CloudflareOAuthFlowLayer: Layer.Layer<
  CloudflareOAuthFlow,
  never,
  AuthCoordinatorCore | CodeModeObjectStorage | CodeModeObjectIdentity
> = Layer.effect(
  CloudflareOAuthFlow,
  Effect.gen(function* () {
    const core = yield* AuthCoordinatorCore;

    return CloudflareOAuthFlow.of({
      beginAuthorization: (input) =>
        beginCloudflareOAuthAuthorization({
          core,
          serverName: input.serverName,
          force: input.force,
        }),
      finishAuthorization: (input) =>
        finishCloudflareOAuthAuthorization({
          core,
          serverName: input.serverName,
          code: input.code,
        }),
    });
  }),
);

/**
 * Begins an OAuth authorization flow for a specific MCP server.
 *
 * This function is designed to be called by a Cloudflare Worker redirect route.
 * It always returns a URL string that the Worker should use for a 302 Redirect.
 */
const beginCloudflareOAuthAuthorization = (input: {
  readonly core: AuthCoordinatorCore["Type"];
  readonly serverName: string;
  readonly force: boolean;
}): Effect.Effect<string, AuthError> =>
  Effect.gen(function* () {
    const config = yield* input.core.httpConfigFor(input.serverName);
    const provider = yield* input.core.providerFor(input.serverName, config);

    if (input.force === true && provider.invalidateCredentials !== undefined) {
      yield* Effect.tryPromise({
        try: () => provider.invalidateCredentials?.("all") ?? Promise.resolve(),
        catch: (cause) =>
          new AuthError({
            message: `Failed to clear OAuth credentials for ${input.serverName}.`,
            cause,
          }),
      });
    }

    const result = yield* Effect.tryPromise({
      try: () =>
        auth(provider, {
          serverUrl: config.url,
          ...oauthRequestOptions(config),
        }),
      catch: (cause) =>
        new AuthError({
          message: `Failed to start OAuth authorization for ${input.serverName}.`,
          cause,
        }),
    }).pipe(
      Effect.catchAll((error) =>
        handleAuthStartError(input.core, input.serverName, error.cause).pipe(
          Effect.flatMap(() => Effect.fail(error)),
        ),
      ),
    );

    // auth() returned AUTHORIZED without calling redirectToAuthorization — typically
    // because stored credentials were refreshed non-interactively. Return the Host
    // Auth Dashboard URL so the caller can send the user back to the auth center.
    if (result === "AUTHORIZED") {
      yield* input.core.markAuthorized(input.serverName);
      const status = yield* input.core.status;
      return status.authUrl;
    }

    // Standard case: Return the Identity Provider's authorization URL (e.g. GitHub login).
    yield* input.core.markAuthorizationInProgress(input.serverName);
    return yield* input.core.authorizationUrlFor(input.serverName);
  });

/**
 * Finishes an OAuth authorization flow after the user is redirected back from the IdP.
 *
 * It exchanges the authorization code for tokens and persists them via the provider.
 */
const finishCloudflareOAuthAuthorization = (input: {
  readonly core: AuthCoordinatorCore["Type"];
  readonly serverName: string;
  readonly code: string;
}): Effect.Effect<void, AuthError> =>
  Effect.gen(function* () {
    const config = yield* input.core.httpConfigFor(input.serverName);
    const provider = yield* input.core.providerFor(input.serverName, config);

    yield* Effect.tryPromise({
      try: () =>
        auth(provider, {
          serverUrl: config.url,
          authorizationCode: input.code,
          ...oauthRequestOptions(config),
        }),
      catch: (cause) =>
        new AuthError({
          message: `Failed to finish OAuth authorization for ${input.serverName}.`,
          cause,
        }),
    });

    yield* input.core.markAuthorized(input.serverName);
  });

const oauthRequestOptions = (config: HttpMcpConfig) => ({
  ...Option.match(
    Option.flatMap(config.auth, (auth) => auth.scope),
    {
      onNone: () => ({}),
      onSome: (scope) => ({ scope }),
    },
  ),
  ...Option.match(
    Option.flatMap(config.auth, (auth) => auth.resourceMetadataUrl),
    {
      onNone: () => ({}),
      onSome: (resourceMetadataUrl) => ({
        resourceMetadataUrl: new URL(resourceMetadataUrl),
      }),
    },
  ),
});

const handleAuthStartError = (
  core: AuthCoordinatorCore["Type"],
  serverName: string,
  cause: unknown,
): Effect.Effect<void, AuthError> =>
  isDynamicClientRegistrationUnsupported(cause)
    ? core.noteConnectionError(serverName, cause)
    : core.noteConnectionError(serverName, new Error(safeErrorMessage(cause)));
