/**
 * Cloudflare Worker-side HostServer implementation.
 *
 * The Worker HostServer owns dispatching already-decoded host-api requests to
 * the per-host Durable Object RPC surface. HTTP routes own carrier concerns
 * such as auth, body parsing, and operation/path validation before calling this
 * service.
 */
import { UserPtoolsConfig } from "@ptools/config/contracts";
import { HostServer } from "@ptools/host-api/effect";
import type { HostApiRequest, HostApiResponse } from "@ptools/host-api";
import { Context, Effect, Layer, Schema } from "effect";
import type { HostCloudflareError } from "../errors.js";
import {
  callCodeModeObject,
  callCodeModeObjectCompleteMcpOAuthCallback,
  callCodeModeObjectMcpAuthStatus,
  callCodeModeObjectStartMcpAuth,
  configureCodeModeObject,
  configureCodeModeObjectSecrets,
  type CodeModeObjectNamespace,
} from "./codeModeObjectRpc.js";

/** Request-scoped inputs needed to dispatch host-api operations on Cloudflare. */
export interface CloudflareHostServerOptions {
  /** Durable Object namespace that owns per-host runtime state. */
  readonly namespace: CodeModeObjectNamespace;
  /** Host ID selected from the Worker route. */
  readonly hostId: string;
  /** Public origin used by Code Mode and OAuth/auth operations. */
  readonly origin: string;
}

/**
 * Creates a request-scoped Cloudflare HostServer service value.
 *
 * This intentionally only closes over route/request context (`namespace`,
 * `hostId`, and `origin`). It does not acquire resources, build a runtime, load
 * config, or create the Code Mode server. The expensive configured runtime is
 * owned and cached by `CodeModeObject`; this Worker-side value is just a small
 * forwarding closure. If this service later starts acquiring resources or
 * building expensive state, revisit this per-request construction and introduce
 * an owning cache/runtime at the correct lifecycle boundary.
 */
export const makeCloudflareHostServer = (
  options: CloudflareHostServerOptions,
): Context.Tag.Service<typeof HostServer> => ({
  handle: (request) => handleCloudflareHostRequest(options, request),
});

/** Provides HostServer by adapting host-api operations to CodeModeObject RPC. */
export const CloudflareHostServerLive = (
  options: CloudflareHostServerOptions,
): Layer.Layer<HostServer> =>
  Layer.succeed(HostServer, makeCloudflareHostServer(options));

export const handleCloudflareHostRequest = (
  options: CloudflareHostServerOptions,
  request: HostApiRequest,
): Effect.Effect<HostApiResponse> => {
  switch (request.operation) {
    case "code_mode":
      return callCodeModeObject({
        namespace: options.namespace,
        hostId: options.hostId,
        origin: options.origin,
        request: request.input,
      }).pipe(
        Effect.map(
          (response): HostApiResponse => ({
            operation: "code_mode",
            result: { ok: true, response },
          }),
        ),
        Effect.catchTag("HostCloudflareError", (error) =>
          Effect.succeed({
            operation: "code_mode" as const,
            result: {
              ok: false as const,
              error: toHostCodeModeError(error),
            },
          }),
        ),
      );

    case "configure":
      return Schema.encode(UserPtoolsConfig)(request.input.config).pipe(
        Effect.map((encoded) => JSON.stringify(encoded)),
        Effect.mapError(
          (cause) =>
            ({
              code: "invalid_config",
              message: `Failed to encode host config: ${String(cause)}`,
            }) as HostCloudflareErrorLike,
        ),
        Effect.flatMap((rawConfigJson) =>
          configureCodeModeObject({
            namespace: options.namespace,
            hostId: options.hostId,
            rawConfigJson,
          }),
        ),
        Effect.map(
          (result): HostApiResponse => ({
            operation: "configure",
            result: {
              ok: true,
              configured: true,
              hostId: result.hostId,
              serverCount: result.serverCount,
              updatedAt: result.updatedAt,
            },
          }),
        ),
        Effect.catchAll((error) =>
          Effect.succeed({
            operation: "configure" as const,
            result: {
              ok: false as const,
              error: toConfigureHostError(error),
            },
          }),
        ),
      );

    case "configure_secrets":
      return configureCodeModeObjectSecrets({
        namespace: options.namespace,
        hostId: options.hostId,
        rawSecretsJson: JSON.stringify(request.input.secrets),
      }).pipe(
        Effect.map(
          (result): HostApiResponse => ({
            operation: "configure_secrets",
            result: {
              ok: true,
              configured: true,
              hostId: result.hostId,
              secretCount: result.secretCount,
              updatedAt: result.updatedAt,
            },
          }),
        ),
        Effect.catchTag("HostCloudflareError", (error) =>
          Effect.succeed({
            operation: "configure_secrets" as const,
            result: {
              ok: false as const,
              error: toConfigureHostSecretsError(error),
            },
          }),
        ),
      );

    case "mcp_auth_status":
      return callCodeModeObjectMcpAuthStatus({
        namespace: options.namespace,
        hostId: options.hostId,
        origin: request.input.origin,
      }).pipe(
        Effect.map(
          (status): HostApiResponse => ({
            operation: "mcp_auth_status",
            result: { ok: true, status },
          }),
        ),
        Effect.catchTag("HostCloudflareError", (error) =>
          Effect.succeed({
            operation: "mcp_auth_status" as const,
            result: { ok: false as const, error: toHostMcpAuthError(error) },
          }),
        ),
      );

    case "start_mcp_auth":
      return callCodeModeObjectStartMcpAuth({
        namespace: options.namespace,
        hostId: options.hostId,
        origin: request.input.origin,
        serverName: request.input.serverName,
        force: request.input.force === true,
      }).pipe(
        Effect.map(
          (result): HostApiResponse => ({
            operation: "start_mcp_auth",
            result: { ok: true, authorizeUrl: result.authorizeUrl },
          }),
        ),
        Effect.catchTag("HostCloudflareError", (error) =>
          Effect.succeed({
            operation: "start_mcp_auth" as const,
            result: { ok: false as const, error: toHostMcpAuthError(error) },
          }),
        ),
      );

    case "complete_mcp_oauth_callback":
      return callCodeModeObjectCompleteMcpOAuthCallback({
        namespace: options.namespace,
        hostId: options.hostId,
        origin: request.input.origin,
        provider: request.input.provider,
        method: request.input.method,
        url: request.input.url,
        ...(request.input.bodyText === undefined
          ? {}
          : { bodyText: request.input.bodyText }),
      }).pipe(
        Effect.map(
          (response): HostApiResponse => ({
            operation: "complete_mcp_oauth_callback",
            result: { ok: true, response },
          }),
        ),
        Effect.catchTag("HostCloudflareError", (error) =>
          Effect.succeed({
            operation: "complete_mcp_oauth_callback" as const,
            result: { ok: false as const, error: toHostMcpAuthError(error) },
          }),
        ),
      );
  }
};

type HostCloudflareErrorLike = Pick<HostCloudflareError, "code" | "message">;

const toHostCodeModeError = (
  error: HostCloudflareError,
): {
  readonly code: "invalid_code_mode_request" | "code_mode_server_failure";
  readonly message: string;
} => ({
  code:
    error.code === "invalid_code_mode_request"
      ? "invalid_code_mode_request"
      : "code_mode_server_failure",
  message: error.message,
});

const toConfigureHostError = (
  error: HostCloudflareErrorLike,
): {
  readonly code:
    | "invalid_config"
    | "unsupported_config"
    | "config_storage_unavailable";
  readonly message: string;
} => {
  switch (error.code) {
    case "invalid_config":
      return { code: "invalid_config", message: error.message };
    case "unsupported_config":
      return { code: "unsupported_config", message: error.message };
    default:
      return { code: "config_storage_unavailable", message: error.message };
  }
};

const toConfigureHostSecretsError = (
  error: HostCloudflareError,
): {
  readonly code: "invalid_secrets" | "secrets_storage_unavailable";
  readonly message: string;
} =>
  error.code === "invalid_secrets"
    ? { code: "invalid_secrets", message: error.message }
    : { code: "secrets_storage_unavailable", message: error.message };

const toHostMcpAuthError = (
  error: HostCloudflareError,
): {
  readonly code:
    | "invalid_config"
    | "auth_unavailable"
    | "invalid_oauth_callback"
    | "oauth_failed";
  readonly message: string;
} => {
  switch (error.code) {
    case "invalid_config":
      return { code: "invalid_config", message: error.message };
    case "invalid_oauth_callback":
      return { code: "invalid_oauth_callback", message: error.message };
    case "code_mode_unavailable":
    default:
      return { code: "auth_unavailable", message: error.message };
  }
};
