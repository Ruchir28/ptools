import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { Effect, Option } from "effect";
import {
  AuthCoordinatorCore,
  type AuthCoordinatorCoreService,
} from "../coordinatorCore.js";
import {
  AuthError,
  CredentialError,
  isDynamicClientRegistrationUnsupported,
  safeErrorMessage,
} from "../authErrors.js";
import type { HttpMcpConfig } from "../authTypes.js";

export interface McpOAuthFlowService {
  /** Start browser authorization for one configured HTTP MCP server. */
  readonly beginAuthorization: (input: {
    readonly serverName: string;
    readonly force: boolean;
  }) => Effect.Effect<string, AuthError | CredentialError>;
  /** Finish browser authorization after the provider redirects back with a code. */
  readonly finishAuthorization: (input: {
    readonly serverName: string;
    readonly code: string;
  }) => Effect.Effect<void, AuthError | CredentialError>;
}

/**
 * Shared route-facing MCP OAuth flow.
 *
 * Host route/RPC code calls this service to begin or finish browser OAuth. The
 * service delegates provider creation and status transitions to
 * `AuthCoordinatorCore`; it does not know about Cloudflare, Node, or HTTP
 * routing.
 */
export class McpOAuthFlow extends Effect.Service<McpOAuthFlow>()(
  "@ptools/McpOAuthFlow",
  {
    effect: Effect.gen(function* () {
      const core = yield* AuthCoordinatorCore;

      return {
        beginAuthorization: (input) =>
          beginMcpOAuthAuthorization({
            core,
            serverName: input.serverName,
            force: input.force,
          }),
        finishAuthorization: (input) =>
          finishMcpOAuthAuthorization({
            core,
            serverName: input.serverName,
            code: input.code,
          }),
      } satisfies McpOAuthFlowService;
    }),
  },
) {}

const beginMcpOAuthAuthorization = (input: {
  readonly core: AuthCoordinatorCoreService;
  readonly serverName: string;
  readonly force: boolean;
}): Effect.Effect<string, AuthError | CredentialError> =>
  Effect.gen(function* () {
    const config = yield* input.core.httpConfigFor(input.serverName);
    const provider = yield* input.core.providerFor(input.serverName, config);

    if (input.force === true && provider.invalidateCredentials !== undefined) {
      yield* Effect.tryPromise({
        try: () => provider.invalidateCredentials?.("all") ?? Promise.resolve(),
        catch: (cause) =>
          new CredentialError({
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

    if (result === "AUTHORIZED") {
      yield* input.core.markAuthorized(input.serverName);
      const status = yield* input.core.status;
      return status.authUrl;
    }

    yield* input.core.markAuthorizationInProgress(input.serverName);
    return yield* input.core.authorizationUrlFor(input.serverName);
  });

const finishMcpOAuthAuthorization = (input: {
  readonly core: AuthCoordinatorCoreService;
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
    Option.flatMap(config.auth, (authConfig) => authConfig.scope),
    {
      onNone: () => ({}),
      onSome: (scope) => ({ scope }),
    },
  ),
  ...Option.match(
    Option.flatMap(config.auth, (authConfig) => authConfig.resourceMetadataUrl),
    {
      onNone: () => ({}),
      onSome: (resourceMetadataUrl) => ({
        resourceMetadataUrl: new URL(resourceMetadataUrl),
      }),
    },
  ),
});

const handleAuthStartError = (
  core: AuthCoordinatorCoreService,
  serverName: string,
  cause: unknown,
): Effect.Effect<void, AuthError> =>
  isDynamicClientRegistrationUnsupported(cause)
    ? core.noteConnectionError(serverName, cause)
    : core.noteConnectionError(serverName, new Error(safeErrorMessage(cause)));
