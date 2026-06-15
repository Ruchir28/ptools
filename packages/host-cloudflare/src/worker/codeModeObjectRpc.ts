/**
 * Worker-side adapter for typed CodeModeObject Durable Object RPC.
 *
 * HTTP routes call these helpers instead of invoking
 * `env.PTOOLS_CODE_MODE.getByName(hostId)` directly. Each helper:
 * 1. resolves the DO stub typed as `CodeModeObjectRpc`
 * 2. calls the matching RPC method
 * 3. unwraps `{ ok, result | error }` into Effect success/failure
 * 4. maps DO error codes to `HostCloudflareError` for HTTP responses
 *
 * Wire types live in `objects/codeModeObject/rpc.ts`. Implementation lives
 * on `CodeModeObject`.
 */
import type { CodeModeRequest, CodeModeResponse } from "@ptools/code-mode-api";
import * as Effect from "effect/Effect";
import { HostCloudflareError, codeModeUnavailable } from "../errors.js";
import type {
  CodeModeObjectMcpAuthError,
  CodeModeObjectRpc,
  CompleteMcpOAuthCallbackResult,
  ConfigureCodeModeObjectError,
  ConfigureCodeModeObjectSecretsResult,
  ConfigureCodeModeObjectResult,
} from "../objects/codeModeObject/rpc.js";

/** Minimal namespace shape used by routes and tests without importing DO types. */
export interface CodeModeObjectNamespace {
  readonly getByName: (hostId: string) => CodeModeObjectRpc;
}

/**
 * `POST /hosts/:hostId/code-mode` — run a Code Mode API request on the host.
 * Unlike the other helpers, `call` returns the raw DO response and does not use
 * the `{ ok, result | error }` envelope.
 */
export const callCodeModeObject = (input: {
  readonly namespace: CodeModeObjectNamespace;
  readonly hostId: string;
  readonly request: CodeModeRequest;
}): Effect.Effect<CodeModeResponse, HostCloudflareError> =>
  Effect.tryPromise({
    try: () => input.namespace.getByName(input.hostId).call(input.request),
    catch: codeModeUnavailable,
  });

/** `PUT /hosts/:hostId/config` — validate and persist host MCP config. */
export const configureCodeModeObject = (input: {
  readonly namespace: CodeModeObjectNamespace;
  readonly hostId: string;
  readonly rawConfigJson: string;
}): Effect.Effect<ConfigureCodeModeObjectResult, HostCloudflareError> =>
  Effect.tryPromise({
    try: () =>
      input.namespace.getByName(input.hostId).configure({
        rawConfigJson: input.rawConfigJson,
      }),
    catch: codeModeUnavailable,
  }).pipe(
    Effect.flatMap((response) =>
      response.ok
        ? Effect.succeed(response.result)
        : Effect.fail(configureRpcError(response.error)),
    ),
  );

/** `PUT /hosts/:hostId/secrets` — validate and persist host secret values. */
export const configureCodeModeObjectSecrets = (input: {
  readonly namespace: CodeModeObjectNamespace;
  readonly hostId: string;
  readonly rawSecretsJson: string;
}): Effect.Effect<ConfigureCodeModeObjectSecretsResult, HostCloudflareError> =>
  Effect.tryPromise({
    try: () =>
      input.namespace.getByName(input.hostId).configureSecrets({
        rawSecretsJson: input.rawSecretsJson,
      }),
    catch: codeModeUnavailable,
  }).pipe(
    Effect.flatMap((response) =>
      response.ok
        ? Effect.succeed(response.result)
        : Effect.fail(configureRpcError(response.error)),
    ),
  );

/** `GET /hosts/:hostId/auth/status` — list MCP auth state for configured servers. */
export const callCodeModeObjectMcpAuthStatus = (input: {
  readonly namespace: CodeModeObjectNamespace;
  readonly hostId: string;
  readonly origin: string;
}) =>
  Effect.tryPromise({
    try: () =>
      input.namespace.getByName(input.hostId).mcpAuthStatus({
        origin: input.origin,
      }),
    catch: codeModeUnavailable,
  }).pipe(
    Effect.flatMap((response) =>
      response.ok
        ? Effect.succeed(response.result)
        : Effect.fail(mcpAuthRpcError(response.error)),
    ),
  );

/** `GET /hosts/:hostId/auth/:serverName` — begin OAuth and return authorize URL. */
export const callCodeModeObjectStartMcpAuth = (input: {
  readonly namespace: CodeModeObjectNamespace;
  readonly hostId: string;
  readonly origin: string;
  readonly serverName: string;
  readonly force: boolean;
}) =>
  Effect.tryPromise({
    try: () =>
      input.namespace.getByName(input.hostId).startMcpAuth({
        origin: input.origin,
        serverName: input.serverName,
        force: input.force,
      }),
    catch: codeModeUnavailable,
  }).pipe(
    Effect.flatMap((response) =>
      response.ok
        ? Effect.succeed(response.result)
        : Effect.fail(mcpAuthRpcError(response.error)),
    ),
  );

/**
 * `GET|POST /hosts/:hostId/oauth/callback/:provider` — finish the browser
 * OAuth redirect and return the HTML page shown to the user.
 */
export const callCodeModeObjectCompleteMcpOAuthCallback = (input: {
  readonly namespace: CodeModeObjectNamespace;
  readonly hostId: string;
  readonly origin: string;
  readonly provider: string;
  readonly method: string;
  readonly url: string;
  readonly bodyText?: string;
}): Effect.Effect<CompleteMcpOAuthCallbackResult, HostCloudflareError> =>
  Effect.tryPromise({
    try: () =>
      input.namespace.getByName(input.hostId).completeMcpOAuthCallback({
        origin: input.origin,
        provider: input.provider,
        method: input.method,
        url: input.url,
        ...(input.bodyText === undefined ? {} : { bodyText: input.bodyText }),
      }),
    catch: codeModeUnavailable,
  }).pipe(
    Effect.flatMap((response) =>
      response.ok
        ? Effect.succeed(response.result)
        : Effect.fail(mcpAuthRpcError(response.error)),
    ),
  );

/** Map configure/configureSecrets RPC errors to Worker HTTP errors. */
const configureRpcError = (
  error: ConfigureCodeModeObjectError,
): HostCloudflareError => {
  switch (error.code) {
    case "invalid_config":
      return new HostCloudflareError({
        code: "invalid_config",
        status: 400,
        message: "Invalid host config",
      });
    case "invalid_secrets":
      return new HostCloudflareError({
        code: "invalid_secrets",
        status: 400,
        message: "Invalid host secrets",
      });
    case "unsupported_config":
      return new HostCloudflareError({
        code: "unsupported_config",
        status: 400,
        message: error.message,
      });
    case "config_storage_unavailable":
      return codeModeUnavailable(error);
  }
};

/** Map MCP auth RPC errors to Worker HTTP errors. */
const mcpAuthRpcError = (
  error: CodeModeObjectMcpAuthError,
): HostCloudflareError => {
  switch (error.code) {
    case "invalid_config":
      return new HostCloudflareError({
        code: "invalid_config",
        status: 400,
        message: error.message,
      });
    case "invalid_oauth_callback":
      return new HostCloudflareError({
        code: "invalid_oauth_callback",
        status: 400,
        message: error.message,
      });
    case "auth_unavailable":
    case "oauth_failed":
      return codeModeUnavailable(error);
  }
};
