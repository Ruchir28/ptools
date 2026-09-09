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
} from "../contracts/hostHttpErrors.js";
import { HostHttpIngress } from "./hostHttpMiddleware.js";

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
 * Method return effects intentionally keep request-scoped `HostHttpIngress` on
 * their `R` channel instead of capturing it in the long-lived adapter Layer.
 * Credentialed methods receive no caller identity: shared handlers complete
 * authorization before acquiring this adapter, and trusted actor dispatch
 * carries only Host, ingress, and operation facts.
 *
 * @effect-expect-leaking HostHttpIngress
 */
export class HostHttpOperationAdapter extends Context.Service<
  HostHttpOperationAdapter,
  {
    readonly codeMode: (
      ctx: CodeModeHttpContext,
    ) => Effect.Effect<HostCodeModeResponse, HostHttpError, HostHttpIngress>;
    readonly configure: (
      ctx: ConfigureHttpContext,
    ) => Effect.Effect<ConfigureHostResponse, HostHttpError, HostHttpIngress>;
    readonly configureSecrets: (
      ctx: ConfigureSecretsHttpContext,
    ) => Effect.Effect<
      ConfigureHostSecretsResponse,
      HostHttpError,
      HostHttpIngress
    >;
    readonly mcpAuthStatus: (
      ctx: McpAuthStatusHttpContext,
    ) => Effect.Effect<
      HostMcpAuthStatusResponse,
      HostHttpError,
      HostHttpIngress
    >;
    readonly startMcpAuth: (
      ctx: StartMcpAuthHttpContext,
    ) => Effect.Effect<
      StartHostMcpAuthResponse,
      HostHttpError,
      HostHttpIngress
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

    const withIngress = <A>(
      use: (
        ingress: Context.Service.Shape<typeof HostHttpIngress>,
      ) => Effect.Effect<A, HostHttpError>,
    ) => Effect.flatMap(HostHttpIngress, use);

    return {
      codeMode: (ctx) =>
        withIngress((ingress) =>
          dispatchExpected("code_mode", {
            hostId: ctx.params.hostId,
            publicOrigin: ingress.publicOrigin,
            request: { operation: "code_mode", input: ctx.payload },
          }),
        ),

      configure: (ctx) =>
        withIngress((ingress) =>
          dispatchExpected("configure", {
            hostId: ctx.params.hostId,
            publicOrigin: ingress.publicOrigin,
            request: { operation: "configure", input: ctx.payload },
          }),
        ),

      configureSecrets: (ctx) =>
        withIngress((ingress) =>
          dispatchExpected("configure_secrets", {
            hostId: ctx.params.hostId,
            publicOrigin: ingress.publicOrigin,
            request: { operation: "configure_secrets", input: ctx.payload },
          }),
        ),

      mcpAuthStatus: (ctx) =>
        withIngress((ingress) =>
          dispatchExpected("mcp_auth_status", {
            hostId: ctx.params.hostId,
            publicOrigin: ingress.publicOrigin,
            request: {
              operation: "mcp_auth_status",
            },
          }),
        ),

      startMcpAuth: (ctx) =>
        withIngress((ingress) =>
          dispatchExpected("start_mcp_auth", {
            hostId: ctx.params.hostId,
            publicOrigin: ingress.publicOrigin,
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
    case "host_unavailable":
      return new HostHttpHostUnavailable({ message: response.error.message });
  }
};

const toHostHttpError = (cause: HostOperationDispatchError): HostHttpError =>
  new HostHttpInternalError({
    message: cause.message ?? "Host operation dispatch failed.",
  });
