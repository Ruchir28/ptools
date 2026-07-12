import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import {
  AuthCoordinatorCore,
  AuthError,
  isDynamicClientRegistrationUnsupported,
  type HttpMcpConfig,
} from "@ptools/auth";
import type {
  CompleteHostMcpOAuthCallbackInput,
  HostMcpOAuthCallbackBrowserResponse,
} from "@ptools/host-api";
import { HostIdentity } from "@ptools/host-context";
import { Effect, Layer, Option } from "effect";
import { browserHtmlResponse, renderMessagePage } from "./browserHtml.js";
import { NodeHostSettings } from "../platform/index.js";
import { NodeMcpAuthFlow } from "./oauthFlow.js";
import { authStatusUrl, setupUrl } from "./policy.js";

type AuthCoordinatorCoreService = typeof AuthCoordinatorCore.Service;

/**
 * Builds the Node MCP OAuth behavior used after the shared Host API has already
 * decoded a route such as `/hosts/:hostId/auth/:serverName`.
 *
 * This layer is created inside one Node code-mode runtime. That runtime's
 * `HostIdentity.hostId` is the host id selected by the dispatcher for the
 * current request path, not a host id baked into the HTTP listener. The service
 * uses that host id plus the configured public origin to create callback/status
 * URLs, delegates auth state to `AuthCoordinatorCore`, and wraps the MCP SDK's
 * Promise-based `auth(...)` call only at the SDK boundary.
 */
export const NodeOAuthFlowLayer: Layer.Layer<
  NodeMcpAuthFlow,
  never,
  AuthCoordinatorCore | HostIdentity | NodeHostSettings
> = Layer.effect(
  NodeMcpAuthFlow,
  Effect.gen(function* () {
    const core = yield* AuthCoordinatorCore;
    const identity = yield* HostIdentity;
    const settings = yield* NodeHostSettings;

    return NodeMcpAuthFlow.of({
      beginAuthorization: (input) =>
        beginNodeOAuthAuthorization({
          core,
          origin: settings.publicOrigin,
          hostId: identity.hostId,
          serverName: input.serverName,
          force: input.force,
        }).pipe(Effect.map((authorizeUrl) => ({ authorizeUrl }))),
      completeCallback: (input) =>
        completeNodeOAuthCallback({
          core,
          origin: settings.publicOrigin,
          input,
        }),
    });
  }),
);

const beginNodeOAuthAuthorization = (input: {
  readonly core: AuthCoordinatorCoreService;
  readonly origin: string;
  readonly hostId: string;
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
      try: () => auth(provider, authOptions(config)),
      catch: (cause) =>
        new AuthError({
          message: `Failed to start MCP OAuth for ${input.serverName}.`,
          cause,
        }),
    }).pipe(
      Effect.catchAll((error) =>
        isDynamicClientRegistrationUnsupported(error.cause)
          ? input.core.noteConnectionError(input.serverName, error.cause).pipe(
              Effect.as(
                setupUrl({
                  origin: input.origin,
                  hostId: input.hostId,
                  serverName: input.serverName,
                }),
              ),
            )
          : Effect.fail(error),
      ),
    );

    if (result === "AUTHORIZED") {
      yield* input.core.markAuthorized(input.serverName);
      return authStatusUrl({ origin: input.origin, hostId: input.hostId });
    }

    yield* input.core.markAuthorizationInProgress(input.serverName);
    return yield* input.core.authorizationUrlFor(input.serverName);
  });

const finishNodeOAuthAuthorization = (input: {
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
          ...authOptions(config),
          authorizationCode: input.code,
        }),
      catch: (cause) =>
        new AuthError({
          message: `Failed to complete MCP OAuth for ${input.serverName}.`,
          cause,
        }),
    });

    yield* input.core.markAuthorized(input.serverName);
  });

const completeNodeOAuthCallback = (input: {
  readonly core: AuthCoordinatorCoreService;
  readonly origin: string;
  readonly input: CompleteHostMcpOAuthCallbackInput;
}): Effect.Effect<HostMcpOAuthCallbackBrowserResponse, AuthError> =>
  Effect.gen(function* () {
    const callback = input.input;
    const url = yield* Effect.try({
      try: () => new URL(callback.url, input.origin),
      catch: (cause) =>
        new AuthError({ message: "Invalid OAuth callback URL.", cause }),
    });
    const params = callbackParams(callback.method, url, callback.bodyText);
    const error = params.get("error");

    if (error !== null) {
      yield* input.core.noteConnectionError(
        callback.provider,
        new Error(error),
      );
      return browserHtmlResponse(
        400,
        renderMessagePage("Authorization failed", error),
      );
    }

    const code = params.get("code");
    if (code === null || code.trim().length === 0) {
      return yield* new AuthError({
        message: "Missing OAuth authorization code.",
      });
    }

    yield* finishNodeOAuthAuthorization({
      core: input.core,
      serverName: callback.provider,
      code,
    });

    return browserHtmlResponse(
      200,
      renderMessagePage(
        "Authorization complete",
        `${callback.provider} is connected. You can return to your MCP client and retry.`,
      ),
    );
  });

const authOptions = (config: HttpMcpConfig) => ({
  serverUrl: config.url,
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

const callbackParams = (
  method: string,
  url: URL,
  bodyText: string | undefined,
): URLSearchParams =>
  bodyText !== undefined && method.toUpperCase() === "POST"
    ? new URLSearchParams(bodyText)
    : url.searchParams;
