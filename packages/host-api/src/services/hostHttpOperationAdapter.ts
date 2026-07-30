/**
 * Shared adapter from typed Host HTTP endpoint contexts to host operations.
 *
 * Handlers stay thin: they pass their HttpApi context here. This service builds
 * the decoded host operation request and resolves a platform-owned instance
 * handle. It owns no Cloudflare, Node, Hono, or Durable Object behavior.
 */
import type { CodeModeRequest } from "@ptools/code-mode-api/contracts";
import type {
  ConfigureHostInput,
  ConfigureHostResponse,
  ConfigureHostSecretsInput,
  ConfigureHostSecretsResponse,
  CompleteHostMcpOAuthCallbackResponse,
  HostOperationProtocolFailureResponse,
  HostOperationRequest,
  HostOperationResponse,
  HostOperationDispatchInput,
  HostCodeModeResponse,
  HostMcpAuthStatusResponse,
  StartHostMcpAuthResponse,
} from "../contracts/index.js";
import { Context, Effect, Layer, Option } from "effect";
import { HostOperationDispatchError } from "./hostOperationDispatchError.js";
import { HostInstanceDiscovery } from "./hostInstanceDiscovery.js";
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
  readonly params: { readonly hostId: string };
  readonly payload: CodeModeRequest;
}

export interface ConfigureHttpContext {
  readonly params: { readonly hostId: string };
  readonly payload: ConfigureHostInput;
}

export interface ConfigureSecretsHttpContext {
  readonly params: { readonly hostId: string };
  readonly payload: ConfigureHostSecretsInput;
}

export interface McpAuthStatusHttpContext {
  readonly params: { readonly hostId: string };
}

export interface StartMcpAuthHttpContext {
  readonly params: { readonly hostId: string; readonly serverName: string };
  readonly payload: { readonly force?: boolean | undefined };
}

export interface CompleteMcpOAuthCallbackHttpContext {
  readonly params: { readonly hostId: string; readonly provider: string };
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
export class HostHttpOperationAdapter extends Context.Service<
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
>()("@ptools/HostHttpOperationAdapter") {}

/** Live adapter that resolves and dispatches through a selected host handle. */
export const HostHttpOperationAdapterLive: Layer.Layer<
  HostHttpOperationAdapter,
  never,
  HostInstanceDiscovery
> = Layer.effect(
  HostHttpOperationAdapter,
  Effect.gen(function* () {
    const discovery = yield* HostInstanceDiscovery;

    const dispatchExpected = <
      Operation extends HostOperationRequest["operation"],
    >(
      operation: Operation,
      input: Omit<HostOperationDispatchInput, "request"> & {
        readonly request: Extract<
          HostOperationRequest,
          { readonly operation: Operation }
        >;
      },
    ) =>
      discovery.resolve(input.hostId).pipe(
        Effect.flatMap((handle) => handle.dispatch(input)),
        Effect.mapError(toHostHttpError),
        Effect.flatMap((response) =>
          unwrapExpectedResponse(operation, response),
        ),
      );

    const credentialed = <A>(
      use: (input: {
        readonly ingress: Context.Service.Shape<typeof HostHttpIngress>;
        readonly auth: Context.Service.Shape<typeof VerifiedHostApiCaller>;
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
            hostId: ctx.params.hostId,
            publicOrigin: ingress.publicOrigin,
            caller: Option.some(auth.caller),
            request: { operation: "code_mode", input: ctx.payload },
          }),
        ),

      configure: (ctx) =>
        credentialed(({ ingress, auth }) =>
          dispatchExpected("configure", {
            hostId: ctx.params.hostId,
            publicOrigin: ingress.publicOrigin,
            caller: Option.some(auth.caller),
            request: { operation: "configure", input: ctx.payload },
          }),
        ),

      configureSecrets: (ctx) =>
        credentialed(({ ingress, auth }) =>
          dispatchExpected("configure_secrets", {
            hostId: ctx.params.hostId,
            publicOrigin: ingress.publicOrigin,
            caller: Option.some(auth.caller),
            request: { operation: "configure_secrets", input: ctx.payload },
          }),
        ),

      mcpAuthStatus: (ctx) =>
        credentialed(({ ingress, auth }) =>
          dispatchExpected("mcp_auth_status", {
            hostId: ctx.params.hostId,
            publicOrigin: ingress.publicOrigin,
            caller: Option.some(auth.caller),
            request: {
              operation: "mcp_auth_status",
            },
          }),
        ),

      startMcpAuth: (ctx) =>
        credentialed(({ ingress, auth }) =>
          dispatchExpected("start_mcp_auth", {
            hostId: ctx.params.hostId,
            publicOrigin: ingress.publicOrigin,
            caller: Option.some(auth.caller),
            request: {
              operation: "start_mcp_auth",
              input: {
                serverName: ctx.params.serverName,
                force: ctx.payload.force === true,
              },
            },
          }),
        ),

      completeMcpOAuthCallback: (ctx) =>
        Effect.gen(function* () {
          const ingress = yield* HostHttpIngress;
          return yield* dispatchExpected("complete_mcp_oauth_callback", {
            hostId: ctx.params.hostId,
            publicOrigin: ingress.publicOrigin,
            caller: Option.none(),
            request: {
              operation: "complete_mcp_oauth_callback",
              input: {
                origin: ingress.publicOrigin,
                provider: ctx.params.provider,
                method: ctx.request.method,
                url: new URL(ctx.request.url, ingress.publicOrigin).toString(),
                bodyText: Option.getOrUndefined(ctx.bodyText),
              },
            },
          });
        }),
    };
  }),
);

const unwrapExpectedResponse = <
  Operation extends HostOperationRequest["operation"],
>(
  operation: Operation,
  response: HostOperationResponse,
): Effect.Effect<
  Extract<HostOperationResponse, { readonly operation: Operation }>,
  HostHttpError
> => {
  if ("_tag" in response) {
    return Effect.fail(protocolFailureToHostHttpError(response));
  }

  if (response.operation !== operation) {
    return Effect.fail(
      new HostHttpInternalError({
        message: `Host instance returned ${response.operation} for ${operation}.`,
      }),
    );
  }

  return Effect.succeed(
    response as Extract<
      HostOperationResponse,
      { readonly operation: Operation }
    >,
  );
};

const protocolFailureToHostHttpError = (
  response: HostOperationProtocolFailureResponse,
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
