/**
 * Cloudflare operation dispatcher for the shared Host HttpApi path.
 *
 * Shared HTTP handlers decode routes, payloads, auth, and request origin before
 * calling `HostOperationDispatcher`. This module owns the final Cloudflare step:
 * forwarding each decoded host operation to the selected CodeModeObject Durable
 * Object RPC method and mapping platform failures into operation envelopes.
 */
import { UserPtoolsConfig } from "@ptools/config/contracts";
import type { HostApiRequest, HostApiResponse } from "@ptools/host-api";
import { Effect, Schema } from "effect";
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

/** Inputs needed to dispatch a decoded host operation on Cloudflare. */
export interface CloudflareHostOperationDispatchOptions {
  /** Durable Object namespace that owns per-host runtime state. */
  readonly namespace: CodeModeObjectNamespace;
  /** Host ID selected from the Worker route. */
  readonly hostId: string;
  /** Public origin used by Code Mode and OAuth/auth operations. */
  readonly origin: string;
}

/** Dispatches one decoded host operation to the selected CodeModeObject RPC surface. */
export const handleCloudflareHostRequest = (
  options: CloudflareHostOperationDispatchOptions,
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
