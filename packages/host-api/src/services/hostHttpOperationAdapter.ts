/**
 * Shared adapter from typed Host HTTP endpoint contexts to host operations.
 *
 * Handlers stay thin: they pass their HttpApi context here. This service builds
 * the decoded host operation request and calls the platform-owned
 * HostOperationDispatcher. It owns no Cloudflare, Node, Hono, or Durable Object
 * behavior.
 */
import type { CodeModeRequest } from "@ptools/code-mode-api/contracts";
import type {
  ConfigureHostInput,
  ConfigureHostResponse,
  ConfigureHostSecretsInput,
  ConfigureHostSecretsResponse,
  CompleteHostMcpOAuthCallbackResponse,
  HostApiProtocolFailureResponse,
  HostApiRequest,
  HostApiResponse,
  HostCodeModeResponse,
  HostMcpAuthStatusResponse,
  StartHostMcpAuthResponse,
} from "../contracts/index.js";
import {
  Context,
  Effect,
  Layer,
  Option,
} from "effect";
import {
  HostOperationDispatchError,
  HostOperationDispatcher,
  type HostOperationDispatchInput,
} from "./hostOperationDispatcher.js";
import {
  HostHttpBadRequest,
  type HostHttpError,
  HostHttpHostUnavailable,
  HostHttpInternalError,
  HostHttpUnauthorized,
} from "../contracts/hostHttpErrors.js";
import {
  HostHttpIngress,
  VerifiedHostApiCaller,
} from "./hostHttpMiddleware.js";

export interface CodeModeHttpContext {
  readonly path: { readonly hostId: string };
  readonly payload: CodeModeRequest;
}

export interface ConfigureHttpContext {
  readonly path: { readonly hostId: string };
  readonly payload: ConfigureHostInput;
}

export interface ConfigureSecretsHttpContext {
  readonly path: { readonly hostId: string };
  readonly payload: ConfigureHostSecretsInput;
}

export interface McpAuthStatusHttpContext {
  readonly path: { readonly hostId: string };
}

export interface StartMcpAuthHttpContext {
  readonly path: { readonly hostId: string; readonly serverName: string };
  readonly payload: { readonly force?: boolean | undefined };
}

export interface CompleteMcpOAuthCallbackHttpContext {
  readonly path: { readonly hostId: string; readonly provider: string };
  readonly request: { readonly method: string; readonly url: string };
  readonly bodyText: Option.Option<string>;
}

/**
 * Shared HTTP operation adapter consumed by HttpApi handlers.
 *
 * Method return effects intentionally keep `HostHttpIngress` and
 * `VerifiedHostApiCaller` on their `R` channel instead of sinking them into the
 * `HostHttpOperationAdapterLive` layer. Both are request-scoped services
 * provided per HTTP request by host-specific ingress/auth middleware
 * (`HostHttpIngress` from the origin policy and `VerifiedHostApiCaller` from
 * `RequireHostApiAccess`). Origin and verified caller vary per request, so they
 * do not exist at app layer-construction time.
 *
 * Resolving them inside `Layer.effect` would either fail because the app layer
 * has no request context, or force a platform to provide static values that
 * would be captured for the lifetime of the app. The method `R` channel is the
 * seam that defers resolution until the HttpApi handler is running with the
 * current request context.
 *
 * The `@effect-expect-leaking` directives below record that this forwarding is
 * intentional and silences the Effect Language Service `leakingRequirements`
 * diagnostic that would otherwise suggest providing them at layer build time.
 *
 * @effect-expect-leaking HostHttpIngress
 * @effect-expect-leaking VerifiedHostApiCaller
 */
export class HostHttpOperationAdapter extends Context.Tag(
  "@ptools/HostHttpOperationAdapter",
)<
  HostHttpOperationAdapter,
  {
    readonly codeMode: (
      ctx: CodeModeHttpContext,
    ) => Effect.Effect<
      HostCodeModeResponse,
      HostHttpError,
      HostHttpIngress | VerifiedHostApiCaller
    >;
    readonly configure: (
      ctx: ConfigureHttpContext,
    ) => Effect.Effect<
      ConfigureHostResponse,
      HostHttpError,
      HostHttpIngress | VerifiedHostApiCaller
    >;
    readonly configureSecrets: (
      ctx: ConfigureSecretsHttpContext,
    ) => Effect.Effect<
      ConfigureHostSecretsResponse,
      HostHttpError,
      HostHttpIngress | VerifiedHostApiCaller
    >;
    readonly mcpAuthStatus: (
      ctx: McpAuthStatusHttpContext,
    ) => Effect.Effect<
      HostMcpAuthStatusResponse,
      HostHttpError,
      HostHttpIngress | VerifiedHostApiCaller
    >;
    readonly startMcpAuth: (
      ctx: StartMcpAuthHttpContext,
    ) => Effect.Effect<
      StartHostMcpAuthResponse,
      HostHttpError,
      HostHttpIngress | VerifiedHostApiCaller
    >;
    readonly completeMcpOAuthCallback: (
      ctx: CompleteMcpOAuthCallbackHttpContext,
    ) => Effect.Effect<
      CompleteHostMcpOAuthCallbackResponse,
      HostHttpError,
      HostHttpIngress
    >;
  }
>() {}

/** Live adapter that delegates operation execution to HostOperationDispatcher. */
export const HostHttpOperationAdapterLive: Layer.Layer<
  HostHttpOperationAdapter,
  never,
  HostOperationDispatcher
> = Layer.effect(
  HostHttpOperationAdapter,
  Effect.gen(function* () {
    const dispatcher = yield* HostOperationDispatcher;

    const dispatchExpected = <Operation extends HostApiRequest["operation"]>(
      operation: Operation,
      input: Omit<HostOperationDispatchInput, "request"> & {
        readonly request: Extract<HostApiRequest, { readonly operation: Operation }>;
      },
    ) =>
      dispatcher.dispatch(input).pipe(
        Effect.mapError(toHostHttpError),
        Effect.flatMap((response) => unwrapExpectedResponse(operation, response)),
      );

    const credentialed = <A>(
      use: (input: {
        readonly ingress: Context.Tag.Service<typeof HostHttpIngress>;
        readonly auth: Context.Tag.Service<typeof VerifiedHostApiCaller>;
      }) => Effect.Effect<A, HostHttpError>,
    ) =>
      Effect.gen(function* () {
        const ingress = yield* HostHttpIngress;
        const auth = yield* VerifiedHostApiCaller;
        return yield* use({ ingress, auth });
      });

    return {
      codeMode: (ctx) =>
        credentialed(({ ingress, auth }) =>
          dispatchExpected("code_mode", {
            hostId: ctx.path.hostId,
            publicOrigin: ingress.publicOrigin,
            caller: Option.some(auth.caller),
            request: { operation: "code_mode", input: ctx.payload },
          }),
        ),

      configure: (ctx) =>
        credentialed(({ ingress, auth }) =>
          dispatchExpected("configure", {
            hostId: ctx.path.hostId,
            publicOrigin: ingress.publicOrigin,
            caller: Option.some(auth.caller),
            request: { operation: "configure", input: ctx.payload },
          }),
        ),

      configureSecrets: (ctx) =>
        credentialed(({ ingress, auth }) =>
          dispatchExpected("configure_secrets", {
            hostId: ctx.path.hostId,
            publicOrigin: ingress.publicOrigin,
            caller: Option.some(auth.caller),
            request: { operation: "configure_secrets", input: ctx.payload },
          }),
        ),

      mcpAuthStatus: (ctx) =>
        credentialed(({ ingress, auth }) =>
          dispatchExpected("mcp_auth_status", {
            hostId: ctx.path.hostId,
            publicOrigin: ingress.publicOrigin,
            caller: Option.some(auth.caller),
            request: {
              operation: "mcp_auth_status",
              input: { origin: ingress.publicOrigin },
            },
          }),
        ),

      startMcpAuth: (ctx) =>
        credentialed(({ ingress, auth }) =>
          dispatchExpected("start_mcp_auth", {
            hostId: ctx.path.hostId,
            publicOrigin: ingress.publicOrigin,
            caller: Option.some(auth.caller),
            request: {
              operation: "start_mcp_auth",
              input: {
                origin: ingress.publicOrigin,
                serverName: ctx.path.serverName,
                force: ctx.payload.force === true,
              },
            },
          }),
        ),

      completeMcpOAuthCallback: (ctx) =>
        Effect.gen(function* () {
          const ingress = yield* HostHttpIngress;
          return yield* dispatchExpected("complete_mcp_oauth_callback", {
            hostId: ctx.path.hostId,
            publicOrigin: ingress.publicOrigin,
            caller: Option.none(),
            request: {
              operation: "complete_mcp_oauth_callback",
              input: {
                origin: ingress.publicOrigin,
                provider: ctx.path.provider,
                method: ctx.request.method,
                url: ctx.request.url,
                bodyText: Option.getOrUndefined(ctx.bodyText),
              },
            },
          });
        }),
    };
  }),
);

const unwrapExpectedResponse = <Operation extends HostApiRequest["operation"]>(
  operation: Operation,
  response: HostApiResponse,
): Effect.Effect<
  Extract<HostApiResponse, { readonly operation: Operation }>,
  HostHttpError
> => {
  if ("_tag" in response) {
    return Effect.fail(protocolFailureToHostHttpError(response));
  }

  if (response.operation !== operation) {
    return Effect.fail(
      new HostHttpInternalError({
        message: `Host dispatcher returned ${response.operation} for ${operation}.`,
      }),
    );
  }

  return Effect.succeed(
    response as Extract<HostApiResponse, { readonly operation: Operation }>,
  );
};

const protocolFailureToHostHttpError = (
  response: HostApiProtocolFailureResponse,
): HostHttpError => {
  switch (response.error.code) {
    case "invalid_host_api_request":
    case "unknown_operation":
      return new HostHttpBadRequest({ message: response.error.message });
    case "unauthorized":
      return new HostHttpUnauthorized({ message: response.error.message });
    case "host_unavailable":
      return new HostHttpHostUnavailable({ message: response.error.message });
  }
};

const toHostHttpError = (cause: HostOperationDispatchError): HostHttpError =>
  new HostHttpInternalError({
    message: cause.message ?? "Host operation dispatch failed.",
  });
