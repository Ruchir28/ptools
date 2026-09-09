/** Shared Effect HttpApi handlers for the Host HTTP API. */
import { HttpServerResponse } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { HostPolicies } from "@ptools/host-authorization/effect";
import { Effect, Option } from "effect";
import { HostHttpApi } from "../api/hostHttpApi.js";
import {
  HostHttpBadRequest,
  HostHttpForbidden,
  HostHttpInternalError,
  type HostHttpError,
} from "../../contracts/hostHttpErrors.js";
import type { CompleteHostMcpOAuthCallbackResponse } from "../../contracts/hostMcpAuth.js";
import { withHostAuthorization } from "../../services/hostAuthorizationAdmission.js";
import { HostHttpOperationAdapter } from "../../services/hostHttpOperationAdapter.js";

/** Handlers for authenticated and Host-authorized JSON routes. */
export const CredentialedHostApiHandlers = HttpApiBuilder.group(
  HostHttpApi,
  "host.api",
  (handlers) =>
    handlers
      .handle("codeMode", (ctx) =>
        withHostAuthorization(
          { hostId: ctx.params.hostId, policy: HostPolicies.execute },
          () =>
            Effect.flatMap(HostHttpOperationAdapter, (adapter) =>
              adapter.codeMode(ctx),
            ),
        ).pipe(Effect.mapError(toHostAuthorizationHttpError)),
      )
      .handle("configure", (ctx) =>
        withHostAuthorization(
          { hostId: ctx.params.hostId, policy: HostPolicies.configure },
          () =>
            Effect.flatMap(HostHttpOperationAdapter, (adapter) =>
              adapter.configure(ctx),
            ),
        ).pipe(Effect.mapError(toHostAuthorizationHttpError)),
      )
      .handle("configureSecrets", (ctx) =>
        withHostAuthorization(
          { hostId: ctx.params.hostId, policy: HostPolicies.manageSecrets },
          () =>
            Effect.flatMap(HostHttpOperationAdapter, (adapter) =>
              adapter.configureSecrets(ctx),
            ),
        ).pipe(Effect.mapError(toHostAuthorizationHttpError)),
      )
      .handle("mcpAuthStatus", (ctx) =>
        withHostAuthorization(
          { hostId: ctx.params.hostId, policy: HostPolicies.readAuth },
          () =>
            Effect.flatMap(HostHttpOperationAdapter, (adapter) =>
              adapter.mcpAuthStatus(ctx),
            ),
        ).pipe(Effect.mapError(toHostAuthorizationHttpError)),
      )
      .handle("startMcpAuth", (ctx) =>
        withHostAuthorization(
          { hostId: ctx.params.hostId, policy: HostPolicies.manageAuth },
          () =>
            Effect.flatMap(HostHttpOperationAdapter, (adapter) =>
              adapter.startMcpAuth(ctx),
            ),
        ).pipe(Effect.mapError(toHostAuthorizationHttpError)),
      ),
);

/** Handlers for browser/provider OAuth callback routes. */
export const OAuthBrowserHandlers = HttpApiBuilder.group(
  HostHttpApi,
  "host.oauth",
  (handlers) =>
    handlers
      .handleRaw("completeOAuthCallbackGet", (ctx) =>
        Effect.gen(function* () {
          const adapter = yield* HostHttpOperationAdapter;
          const response = yield* adapter.completeMcpOAuthCallback({
            params: ctx.params,
            request: {
              method: ctx.request.method,
              url: ctx.request.url,
            },
            bodyText: Option.none(),
          });
          return yield* browserResponseToHttpServerResponse(response.result);
        }),
      )
      .handleRaw("completeOAuthCallbackPost", (ctx) =>
        Effect.gen(function* () {
          const adapter = yield* HostHttpOperationAdapter;
          const bodyText = yield* ctx.request.text.pipe(
            Effect.map(Option.some),
            Effect.mapError(
              (cause) =>
                new HostHttpBadRequest({
                  message: `Unable to read OAuth callback request body: ${String(cause)}`,
                }),
            ),
          );
          const response = yield* adapter.completeMcpOAuthCallback({
            params: ctx.params,
            request: {
              method: ctx.request.method,
              url: ctx.request.url,
            },
            bodyText,
          });
          return yield* browserResponseToHttpServerResponse(response.result);
        }),
      ),
);

/**
 * Preserve operation-adapter HTTP failures while projecting authorization
 * failures without exposing persistence or invariant details.
 */
const toHostAuthorizationHttpError = (error: {
  readonly _tag?: string;
}): HostHttpError | HostHttpForbidden => {
  switch (error._tag) {
    case "HostHttpBadRequest":
    case "HostHttpUnauthorized":
    case "HostHttpHostUnavailable":
    case "HostHttpInternalError":
      return error as HostHttpError;
    case "HostAuthorizationDenied":
    case "HostTokenRouteMismatch":
      return new HostHttpForbidden({ message: "operation was not permitted" });
    default:
      return new HostHttpInternalError({
        message: "Host authorization failed",
      });
  }
};

const browserResponseToHttpServerResponse = (
  result: CompleteHostMcpOAuthCallbackResponse["result"],
) => {
  if (!result.ok) {
    return Effect.fail(
      new HostHttpBadRequest({
        message: result.error.message,
      }),
    );
  }

  return Effect.succeed(
    HttpServerResponse.text(result.response.body, {
      status: result.response.status,
      headers: result.response.headers,
    }),
  );
};
