import type { CodeModeInvalidRequestError } from "@ptools/code-mode-api";
import type { ServerConfigError } from "@ptools/config";
import * as Data from "effect/Data";

export type HostCloudflareErrorCode =
  | "not_found"
  | "method_not_allowed"
  | "unauthorized"
  | "invalid_json"
  | "invalid_code_mode_request"
  | "invalid_config"
  | "invalid_secrets"
  | "invalid_oauth_callback"
  | "unsupported_config"
  | "code_mode_unavailable"
  | "misconfigured_worker";

export class HostCloudflareError extends Data.TaggedError(
  "HostCloudflareError",
)<{
  readonly code: HostCloudflareErrorCode;
  readonly status: number;
  readonly message: string;
  readonly headers?: Record<string, string>;
  readonly cause?: unknown;
}> {}

export const notFound = (): HostCloudflareError =>
  new HostCloudflareError({
    code: "not_found",
    status: 404,
    message: "Not found",
  });

export const methodNotAllowed = (
  allow: ReadonlyArray<string>,
): HostCloudflareError =>
  new HostCloudflareError({
    code: "method_not_allowed",
    status: 405,
    message: "Method not allowed",
    headers: { Allow: allow.join(", ") },
  });

export const unauthorized = (): HostCloudflareError =>
  new HostCloudflareError({
    code: "unauthorized",
    status: 401,
    message: "Unauthorized",
    headers: { "WWW-Authenticate": "Bearer" },
  });

export const invalidJson = (cause: unknown): HostCloudflareError =>
  new HostCloudflareError({
    code: "invalid_json",
    status: 400,
    message: "Invalid JSON body",
    cause,
  });

export const invalidCodeModeRequest = (
  cause: CodeModeInvalidRequestError,
): HostCloudflareError =>
  new HostCloudflareError({
    code: "invalid_code_mode_request",
    status: 400,
    message: "Invalid Code Mode request",
    cause,
  });

export const invalidConfig = (cause: ServerConfigError): HostCloudflareError =>
  new HostCloudflareError({
    code: "invalid_config",
    status: 400,
    message: "Invalid host config",
    cause,
  });

export const unsupportedConfig = (message: string): HostCloudflareError =>
  new HostCloudflareError({
    code: "unsupported_config",
    status: 400,
    message,
  });

export const codeModeUnavailable = (cause: unknown): HostCloudflareError =>
  new HostCloudflareError({
    code: "code_mode_unavailable",
    status: 502,
    message: "Code Mode host is unavailable",
    cause,
  });

export const misconfiguredWorker = (message: string): HostCloudflareError =>
  new HostCloudflareError({
    code: "misconfigured_worker",
    status: 500,
    message,
  });
