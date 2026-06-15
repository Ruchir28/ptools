import { AuthCoordinator, type McpAuthStatus } from "@ptools/auth";
import { ConfigSource, ServerConfigError } from "@ptools/config";
import { Data, Effect, Option } from "effect";
import {
  CloudflareOAuthFlow,
  CodeModeObjectIdentity,
  CodeModeObjectStorage,
  verifyAndConsumeOAuthState,
} from "../../layers/index.js";
import type {
  CodeModeObjectMcpAuthError,
  CompleteMcpOAuthCallbackResult,
} from "./rpc.js";

export type ParsedCompleteMcpOAuthCallback = Data.TaggedEnum<{
  Complete: {
    readonly result: CompleteMcpOAuthCallbackResult;
  };
  Finish: {
    readonly serverName: string;
    readonly code: string;
  };
}>;

export const ParsedCompleteMcpOAuthCallback =
  Data.taggedEnum<ParsedCompleteMcpOAuthCallback>();

export const getMcpAuthStatus = (): Effect.Effect<
  McpAuthStatus,
  CodeModeObjectMcpAuthError,
  AuthCoordinator
> =>
  Effect.gen(function* () {
    const auth = yield* AuthCoordinator;

    return yield* auth.status;
  });

export const startMcpAuth = (input: {
  readonly serverName: string;
  readonly force: boolean;
}): Effect.Effect<
  { readonly authorizeUrl: string },
  CodeModeObjectMcpAuthError,
  CloudflareOAuthFlow
> =>
  Effect.gen(function* () {
    const flow = yield* CloudflareOAuthFlow;
    const authorizeUrl = yield* flow.beginAuthorization(input).pipe(
      Effect.mapError((cause) => ({
        code: "auth_unavailable" as const,
        message: safeMessage(cause),
      })),
    );

    return { authorizeUrl };
  });

export const parseCompleteMcpOAuthCallback = (input: {
  readonly provider: string;
  readonly method: string;
  readonly url: string;
  readonly bodyText: Option.Option<string>;
}): Effect.Effect<
  ParsedCompleteMcpOAuthCallback,
  CodeModeObjectMcpAuthError,
  CodeModeObjectStorage | CodeModeObjectIdentity
> =>
  Effect.gen(function* () {
    const storage = yield* CodeModeObjectStorage;
    const identity = yield* CodeModeObjectIdentity;
    const url = yield* Effect.try({
      try: () => new URL(input.url),
      catch: () => invalidOAuthCallback("Invalid OAuth callback URL"),
    });
    const params = callbackParams(input.method, url, input.bodyText);
    const state = yield* requiredCallbackParameter(params, "state");

    const payload = yield* verifyAndConsumeOAuthState({
      storage,
      rawState: state,
      expectedHostId: identity.hostId,
      expectedProvider: input.provider,
    }).pipe(Effect.mapError((cause) => invalidOAuthCallback(cause.message)));

    return yield* Option.fromNullable(params.get("error")).pipe(
      Option.match({
        onSome: (error) =>
          Effect.succeed(
            ParsedCompleteMcpOAuthCallback.Complete({
              result: {
                status: 400,
                headers: { "content-type": "text/html; charset=utf-8" },
                body: renderOAuthMessage("Authorization failed", error),
              },
            }),
          ),
        onNone: () =>
          requiredCallbackParameter(params, "code").pipe(
            Effect.map((code) =>
              ParsedCompleteMcpOAuthCallback.Finish({
                serverName: payload.serverName,
                code,
              }),
            ),
          ),
      }),
    );
  });

export const finishMcpOAuthCallback = (input: {
  readonly serverName: string;
  readonly code: string;
}): Effect.Effect<void, CodeModeObjectMcpAuthError, CloudflareOAuthFlow> =>
  Effect.gen(function* () {
    const flow = yield* CloudflareOAuthFlow;

    yield* flow.finishAuthorization(input).pipe(
      Effect.mapError((cause) => ({
        code: "oauth_failed" as const,
        message: safeMessage(cause),
      })),
    );
  });

export const initializeConfiguredMcpAuth = (): Effect.Effect<
  void,
  ServerConfigError,
  AuthCoordinator | ConfigSource
> =>
  Effect.gen(function* () {
    const source = yield* ConfigSource;
    const auth = yield* AuthCoordinator;
    const config = yield* source.load;

    for (const [serverName, serverConfig] of Object.entries(
      config.mcpServers,
    )) {
      yield* auth.noteConfigured(serverName, serverName, serverConfig);
    }
  });

export const codeModeObjectMcpAuthErrorFromCause = (
  cause: unknown,
): CodeModeObjectMcpAuthError => {
  if (isCodeModeObjectMcpAuthError(cause)) {
    return cause;
  }

  if (cause instanceof ServerConfigError) {
    return {
      code: "invalid_config",
      message: cause.message,
    };
  }

  return {
    code: "auth_unavailable",
    message: safeMessage(cause),
  };
};

export const renderOAuthMessage = (title: string, message: string): string =>
  `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title></head>
<body style="font-family: system-ui, sans-serif; padding: 32px;">
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(message)}</p>
</body>
</html>`;

const requiredCallbackParameter = (
  params: URLSearchParams,
  name: "state" | "code",
): Effect.Effect<string, CodeModeObjectMcpAuthError> =>
  Option.fromNullable(params.get(name)).pipe(
    Option.filter((value) => value.trim().length > 0),
    Option.match({
      onNone: () =>
        Effect.fail(
          invalidOAuthCallback(
            name === "state"
              ? "Missing OAuth state"
              : "Missing OAuth authorization code",
          ),
        ),
      onSome: Effect.succeed,
    }),
  );

const invalidOAuthCallback = (message: string): CodeModeObjectMcpAuthError => ({
  code: "invalid_oauth_callback",
  message,
});

const isCodeModeObjectMcpAuthError = (
  cause: unknown,
): cause is CodeModeObjectMcpAuthError =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  "message" in cause &&
  (cause.code === "invalid_config" ||
    cause.code === "auth_unavailable" ||
    cause.code === "invalid_oauth_callback" ||
    cause.code === "oauth_failed") &&
  typeof cause.message === "string";

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const safeMessage = (cause: unknown): string => {
  if (
    typeof cause === "object" &&
    cause !== null &&
    "message" in cause &&
    typeof cause.message === "string"
  ) {
    return cause.message;
  }

  return String(cause);
};

const callbackParams = (
  method: string,
  url: URL,
  bodyText: Option.Option<string>,
): URLSearchParams =>
  Option.match(bodyText, {
    onNone: () => url.searchParams,
    onSome: (body) =>
      method.toUpperCase() === "POST"
        ? new URLSearchParams(body)
        : url.searchParams,
  });
