/**
 * @file Shared operation handler installed inside one selected host runtime.
 *
 * Carriers reach this service through a platform-owned handle. The handler owns
 * operation semantics and response projection, while remaining unaware of RPC,
 * HTTP, Durable Objects, processes, or other communication mechanisms.
 */
import {
  AuthCoordinator,
  McpOAuthFlow,
  McpOAuthStateStore,
} from "@ptools/auth";
import { CodeModeServer } from "@ptools/code-mode-api/effect";
import {
  ConfiguredHostConfigStore,
  ConfiguredHostConfigStoreError,
  ConfiguredSecretStore,
  isAbsolutePortablePath,
  parsePtoolsConfigJson,
  ServerConfigError,
  type PtoolsConfig,
} from "@ptools/config";
import { UserPtoolsConfig } from "@ptools/config/contracts";
import { HostIdentity } from "@ptools/host-context";
import {
  CompleteHostMcpOAuthCallbackResponse,
  ConfigureHostResponse,
  ConfigureHostSecretsResponse,
  HostCodeModeResponse,
  HostMcpAuthStatusResponse,
  HostOperationProtocolFailureResponse,
  StartHostMcpAuthResponse,
  type HostOperationDispatchInput,
  type HostOperationResponse,
} from "@ptools/host-api";
import {
  Array as EffectArray,
  Context,
  Data,
  Effect,
  Layer,
  Option,
  Schema,
} from "effect";
import { ConfiguredHostContextRunner } from "./configuredHostContextRunner.js";

export interface HostInstanceHandlerOptions {
  readonly supportsStdioMcp: boolean;
}

export interface HostInstanceHandlerOperations {
  readonly handle: (
    input: HostOperationDispatchInput,
  ) => Effect.Effect<HostOperationResponse>;
}

type HostMcpAuthError = {
  readonly code:
    | "invalid_config"
    | "auth_unavailable"
    | "invalid_oauth_callback"
    | "oauth_failed";
  readonly message: string;
};

type ParsedOAuthCallback = Data.TaggedEnum<{
  Complete: { readonly response: OAuthBrowserResponse };
  Finish: { readonly serverName: string; readonly code: string };
}>;
const ParsedOAuthCallback = Data.taggedEnum<ParsedOAuthCallback>();

type OAuthBrowserResponse = {
  readonly status: number;
  readonly headers?: Record<string, string>;
  readonly body: string;
};

/**
 * Shared receiver-side behavior for one selected host instance.
 *
 * Platforms install `.layer(options)` in the stable, host-scoped runtime and
 * connect their local/RPC handle to `handle`. Its input is a trusted carrier:
 * credentialed routes have already completed shared authorization, while OAuth
 * callbacks prove their workflow authority from signed, single-use state here.
 * No public caller, credential, token, or permission set crosses this boundary.
 * The service owns operation interpretation and response projection, but knows
 * nothing about the carrier used to reach it. Construction captures stable
 * services once; configured services are entered through the context runner.
 */
export class HostInstanceHandler extends Context.Service<HostInstanceHandler>()(
  "@ptools/host-runtime/HostInstanceHandler",
  {
    make: (options: HostInstanceHandlerOptions) =>
      Effect.gen(function* () {
        // These values belong to the stable host runtime. Capturing them during
        // service construction ensures every operation uses the stores,
        // identity, OAuth state, and context cache owned by this host instance.
        const identity = yield* HostIdentity;
        const configStore = yield* ConfiguredHostConfigStore;
        const secretStore = yield* ConfiguredSecretStore;
        const configuredContextRunner = yield* ConfiguredHostContextRunner;
        const oauthStateStore = yield* McpOAuthStateStore;

        /**
         * Enter the cached config/origin-derived Context for one operation.
         *
         * `CodeModeServer`, `AuthCoordinator`, and `McpOAuthFlow` are not exposed
         * directly by the stable runtime: they depend on persisted config,
         * secrets, and public origin. Routing access through the runner preserves
         * its cache, scoped-resource leases, and invalidation behavior instead of
         * constructing another Layer or ManagedRuntime per request.
         */
        const runConfigured = <A, E>(
          origin: string,
          make: Effect.Effect<
            A,
            E,
            CodeModeServer | AuthCoordinator | McpOAuthFlow
          >,
        ) => configuredContextRunner.run({ origin }, make);

        /**
         * Handle one normalized operation after a platform has reached this
         * selected instance.
         *
         * The method verifies the receiver-side host binding, chooses stable
         * storage work versus configured-context work, and converts expected
         * domain failures into the public `HostOperationResponse` union. Carrier
         * failures remain the responsibility of the caller-side instance handle.
         */
        const handle = (
          input: HostOperationDispatchInput,
        ): Effect.Effect<HostOperationResponse> => {
          // The caller-side bound handle checks this too, but a remote receiver
          // independently protects its own host identity after the carrier seam.
          if (input.hostId !== identity.hostId) {
            return Effect.succeed(
              HostOperationProtocolFailureResponse.make({
                error: {
                  code: "host_unavailable",
                  message: `Selected host ${identity.hostId} cannot handle operation for ${input.hostId}.`,
                },
              }),
            );
          }

          const request = input.request;
          // This is the single shared operation interpreter. Platform shells do
          // not maintain parallel switches or operation-specific RPC methods.
          switch (request.operation) {
            case "code_mode":
              // Code Mode and its upstream MCP connections are derived from the
              // persisted config and the public origin, so this operation must
              // acquire the configured context rather than use stable services.
              return runConfigured(
                input.publicOrigin,
                Effect.flatMap(CodeModeServer, (server) =>
                  server.handle(request.input),
                ),
              ).pipe(
                Effect.map((response) =>
                  HostCodeModeResponse.make({
                    operation: "code_mode",
                    result: { ok: true, response },
                  }),
                ),
                Effect.catch((cause) =>
                  Effect.succeed(
                    HostCodeModeResponse.make({
                      operation: "code_mode",
                      result: {
                        ok: false,
                        error: {
                          code: hasTag(cause, "CodeModeInvalidRequestError")
                            ? "invalid_code_mode_request"
                            : "code_mode_server_failure",
                          message: safeMessage(cause),
                        },
                      },
                    }),
                  ),
                ),
              );

            case "configure":
              // The Host API has already decoded the authored DTO. Encoding
              // restores its JSON representation (including omitted Option
              // fields) so the canonical parser can normalize command/url
              // entries into the stored PtoolsConfig domain value.
              return Schema.encodeEffect(UserPtoolsConfig)(
                request.input.config,
              ).pipe(
                Effect.map((encoded) => JSON.stringify(encoded)),
                Effect.flatMap((json) =>
                  parsePtoolsConfigJson(json, `Host ${identity.hostId} config`),
                ),
                // Normalization is platform-neutral; this check enforces only
                // capabilities of the host that will execute the config.
                Effect.flatMap((config) =>
                  checkConfigCompatibility(config, options),
                ),
                Effect.flatMap((config) => configStore.replace({ config })),
                // The cached context may hold connections created from the
                // previous config. Clear it only after saving the new config.
                Effect.tap(() => configuredContextRunner.invalidateAll),
                Effect.map((result) =>
                  ConfigureHostResponse.make({
                    operation: "configure",
                    result: {
                      ok: true,
                      configured: true,
                      hostId: identity.hostId,
                      serverCount: result.serverCount,
                      updatedAt: result.updatedAt,
                    },
                  }),
                ),
                Effect.catch((cause) =>
                  Effect.succeed(
                    ConfigureHostResponse.make({
                      operation: "configure",
                      result: {
                        ok: false,
                        error: configureError(cause),
                      },
                    }),
                  ),
                ),
              );

            case "configure_secrets":
              // Secrets are stored separately from config. They can change the
              // resolved configuration used by an existing context, so use the
              // same post-write invalidation rule as configure.
              return secretStore
                .replaceAll({ secrets: request.input.secrets })
                .pipe(
                  Effect.tap(() => configuredContextRunner.invalidateAll),
                  Effect.map((result) =>
                    ConfigureHostSecretsResponse.make({
                      operation: "configure_secrets",
                      result: {
                        ok: true,
                        configured: true,
                        hostId: identity.hostId,
                        secretCount: result.secretCount,
                        updatedAt: result.updatedAt,
                      },
                    }),
                  ),
                  Effect.catch((cause) =>
                    Effect.succeed(
                      ConfigureHostSecretsResponse.make({
                        operation: "configure_secrets",
                        result: {
                          ok: false,
                          error: {
                            code: "secrets_storage_unavailable",
                            message: safeMessage(cause),
                          },
                        },
                      }),
                    ),
                  ),
                );

            case "mcp_auth_status":
              // Auth status is calculated from the configured upstream servers,
              // not merely stable host storage, so enter the configured context.
              return runConfigured(
                input.publicOrigin,
                Effect.flatMap(AuthCoordinator, (auth) => auth.status),
              ).pipe(
                Effect.map((status) =>
                  HostMcpAuthStatusResponse.make({
                    operation: "mcp_auth_status",
                    result: { ok: true, status },
                  }),
                ),
                Effect.catch((cause) =>
                  Effect.succeed(
                    HostMcpAuthStatusResponse.make({
                      operation: "mcp_auth_status",
                      result: { ok: false, error: authError(cause) },
                    }),
                  ),
                ),
              );

            case "start_mcp_auth":
              // Starting OAuth records state and builds a redirect URL using the
              // configured server and this request's public origin.
              return runConfigured(
                input.publicOrigin,
                Effect.flatMap(McpOAuthFlow, (flow) =>
                  flow.beginAuthorization({
                    serverName: request.input.serverName,
                    force: request.input.force === true,
                  }),
                ),
              ).pipe(
                Effect.map((authorizeUrl) =>
                  StartHostMcpAuthResponse.make({
                    operation: "start_mcp_auth",
                    result: { ok: true, authorizeUrl },
                  }),
                ),
                Effect.catch((cause) =>
                  Effect.succeed(
                    StartHostMcpAuthResponse.make({
                      operation: "start_mcp_auth",
                      result: { ok: false, error: authError(cause) },
                    }),
                  ),
                ),
              );

            case "complete_mcp_oauth_callback":
              // State verification is stable per host and must consume the
              // one-time state before exchanging a successful authorization
              // code in the configured context.
              return parseOAuthCallback({
                provider: request.input.provider,
                method: request.input.method,
                url: request.input.url,
                ...(request.input.bodyText === undefined
                  ? {}
                  : { bodyText: request.input.bodyText }),
                expectedHostId: identity.hostId,
                oauthStateStore,
              }).pipe(
                Effect.flatMap(
                  ParsedOAuthCallback.$match({
                    Complete: ({ response }) => Effect.succeed(response),
                    Finish: ({ serverName, code }) =>
                      runConfigured(
                        input.publicOrigin,
                        Effect.flatMap(McpOAuthFlow, (flow) =>
                          flow.finishAuthorization({ serverName, code }),
                        ),
                      ).pipe(
                        Effect.as({
                          status: 200,
                          headers: {
                            "content-type": "text/html; charset=utf-8",
                          },
                          body: renderOAuthMessage(
                            "Authorization complete",
                            `${serverName} is connected. You can return to your MCP client and retry.`,
                          ),
                        }),
                      ),
                  }),
                ),
                Effect.map((response) =>
                  CompleteHostMcpOAuthCallbackResponse.make({
                    operation: "complete_mcp_oauth_callback",
                    result: { ok: true, response },
                  }),
                ),
                Effect.catch((cause) =>
                  Effect.succeed(
                    CompleteHostMcpOAuthCallbackResponse.make({
                      operation: "complete_mcp_oauth_callback",
                      result: { ok: false, error: authError(cause) },
                    }),
                  ),
                ),
              );
          }
        };

        return { handle } satisfies HostInstanceHandlerOperations;
      }),
  },
) {
  static readonly layer = (options: HostInstanceHandlerOptions) =>
    Layer.effect(this, this.make(options));
}

class UnsupportedConfig extends Data.TaggedError("UnsupportedConfig")<{
  readonly message: string;
}> {}

class InvalidHostApiConfig extends Data.TaggedError("InvalidHostApiConfig")<{
  readonly message: string;
}> {}

/** Reject configuration that the selected host or Host API cannot execute. */
const checkConfigCompatibility = (
  config: PtoolsConfig,
  options: HostInstanceHandlerOptions,
): Effect.Effect<PtoolsConfig, UnsupportedConfig | InvalidHostApiConfig> => {
  const servers = Object.entries(config.mcpServers);

  const unsupportedStdio = options.supportsStdioMcp
    ? Option.none<UnsupportedConfig>()
    : EffectArray.findFirst(servers, ([serverName, server]) =>
        server.transport === "stdio"
          ? Option.some(
              new UnsupportedConfig({
                message: `MCP server "${serverName}" uses stdio, which is not supported by this host.`,
              }),
            )
          : Option.none(),
      );

  const compatibilityError = unsupportedStdio.pipe(
    Option.orElse(() =>
      EffectArray.findFirst(servers, ([serverName, server]) =>
        server.transport === "stdio"
          ? server.cwd.pipe(
              Option.filter((cwd) => !isAbsolutePortablePath(cwd)),
              Option.map(
                (cwd) =>
                  new InvalidHostApiConfig({
                    message: `MCP server "${serverName}" uses relative stdio cwd "${cwd}". Host API configuration has no source config file directory, so stdio cwd must be absolute or omitted.`,
                  }),
              ),
            )
          : Option.none(),
      ),
    ),
  );

  return Option.match(compatibilityError, {
    onNone: () => Effect.succeed(config),
    onSome: Effect.fail,
  });
};

/** Project configure failures into the public, operation-specific error union. */
const configureError = (cause: unknown) => ({
  code:
    cause instanceof UnsupportedConfig
      ? ("unsupported_config" as const)
      : cause instanceof ConfiguredHostConfigStoreError
        ? ("config_storage_unavailable" as const)
        : ("invalid_config" as const),
  message: safeMessage(cause),
});

/** Preserve known OAuth errors while classifying config and unexpected failures. */
const authError = (cause: unknown): HostMcpAuthError => {
  if (isAuthError(cause)) return cause;
  const config = findCause(
    cause,
    (value) => value instanceof ServerConfigError,
  );
  return config !== undefined
    ? { code: "invalid_config", message: safeMessage(config) }
    : { code: "auth_unavailable", message: safeMessage(cause) };
};

/**
 * Verify callback state and separate a provider-declined callback from one
 * whose authorization code still needs exchanging with the upstream server.
 */
const parseOAuthCallback = (input: {
  readonly provider: string;
  readonly method: string;
  readonly url: string;
  readonly bodyText?: string;
  readonly expectedHostId: string;
  readonly oauthStateStore: Context.Service.Shape<typeof McpOAuthStateStore>;
}): Effect.Effect<ParsedOAuthCallback, HostMcpAuthError> =>
  Effect.gen(function* () {
    const url = yield* Effect.try({
      try: () => new URL(input.url),
      catch: () => invalidCallback("Invalid OAuth callback URL"),
    });
    const params =
      input.method.toUpperCase() === "POST" && input.bodyText !== undefined
        ? new URLSearchParams(input.bodyText)
        : url.searchParams;
    const state = yield* requiredParam(params, "state");
    const payload = yield* input.oauthStateStore
      .verifyAndConsume({
        rawState: state,
        expectedHostId: input.expectedHostId,
        expectedProvider: input.provider,
      })
      .pipe(Effect.mapError((cause) => invalidCallback(cause.message)));
    const error = params.get("error");
    if (error !== null) {
      return ParsedOAuthCallback.Complete({
        response: {
          status: 400,
          headers: { "content-type": "text/html; charset=utf-8" },
          body: renderOAuthMessage("Authorization failed", error),
        },
      });
    }
    return ParsedOAuthCallback.Finish({
      serverName: payload.serverName,
      code: yield* requiredParam(params, "code"),
    });
  });

/** Read a required OAuth callback field without leaking nullable values inward. */
const requiredParam = (params: URLSearchParams, name: "state" | "code") => {
  const value = params.get(name);
  return value === null || value.trim() === ""
    ? Effect.fail(
        invalidCallback(
          name === "state"
            ? "Missing OAuth state"
            : "Missing OAuth authorization code",
        ),
      )
    : Effect.succeed(value);
};
const invalidCallback = (message: string): HostMcpAuthError => ({
  code: "invalid_oauth_callback",
  message,
});
const isAuthError = (value: unknown): value is HostMcpAuthError =>
  typeof value === "object" &&
  value !== null &&
  "code" in value &&
  "message" in value &&
  [
    "invalid_config",
    "auth_unavailable",
    "invalid_oauth_callback",
    "oauth_failed",
  ].includes(String(value.code));
const hasTag = (value: unknown, tag: string) =>
  findCause(
    value,
    (candidate) =>
      typeof candidate === "object" &&
      candidate !== null &&
      "_tag" in candidate &&
      candidate._tag === tag,
  ) !== undefined;
const findCause = (
  value: unknown,
  predicate: (value: unknown) => boolean,
): unknown | undefined => {
  if (predicate(value)) return value;
  return typeof value === "object" && value !== null && "cause" in value
    ? findCause(value.cause, predicate)
    : undefined;
};
const safeMessage = (value: unknown): string =>
  typeof value === "object" &&
  value !== null &&
  "message" in value &&
  typeof value.message === "string"
    ? value.message
    : String(value);
const renderOAuthMessage = (title: string, message: string): string =>
  `<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title></head>\n<body style="font-family: system-ui, sans-serif; padding: 32px;">\n<h1>${escapeHtml(title)}</h1>\n<p>${escapeHtml(message)}</p>\n</body>\n</html>`;
const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
