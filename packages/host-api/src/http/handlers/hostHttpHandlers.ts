/** Shared Effect HttpApi handlers for the Host HTTP API. */
import { HttpApiBuilder, HttpServerResponse } from "@effect/platform";
import { Effect, Option } from "effect";
import { HostHttpApi } from "../api/hostHttpApi.js";
import { HostHttpBadRequest } from "../../contracts/hostHttpErrors.js";
import type { CompleteHostMcpOAuthCallbackResponse } from "../../contracts/hostMcpAuth.js";
import { HostHttpOperationAdapter } from "../../services/hostHttpOperationAdapter.js";

/** Handlers for bearer-protected Host API JSON routes. */
export const CredentialedHostApiHandlers = HttpApiBuilder.group(
  HostHttpApi,
  "host.api",
  (handlers) =>
    handlers
      .handle("codeMode", (ctx) =>
        Effect.gen(function* () {
          const adapter = yield* HostHttpOperationAdapter;
          return yield* adapter.codeMode(ctx);
        }),
      )
      .handle("configure", (ctx) =>
        Effect.gen(function* () {
          const adapter = yield* HostHttpOperationAdapter;
          return yield* adapter.configure(ctx);
        }),
      )
      .handle("configureSecrets", (ctx) =>
        Effect.gen(function* () {
          const adapter = yield* HostHttpOperationAdapter;
          return yield* adapter.configureSecrets(ctx);
        }),
      )
      .handle("mcpAuthStatus", (ctx) =>
        Effect.gen(function* () {
          const adapter = yield* HostHttpOperationAdapter;
          return yield* adapter.mcpAuthStatus(ctx);
        }),
      )
      .handle("startMcpAuth", (ctx) =>
        Effect.gen(function* () {
          const adapter = yield* HostHttpOperationAdapter;
          return yield* adapter.startMcpAuth(ctx);
        }),
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
            path: ctx.path,
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
            path: ctx.path,
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
