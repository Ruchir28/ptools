/**
 * Machine-readable host MCP auth DTOs.
 *
 * This file owns host-api operations for auth status, starting OAuth, and
 * completing OAuth callbacks. Platform routes still own carrier extraction from
 * HTTP/browser requests and rendering the returned browser response payload.
 */
import { McpAuthStatus } from "@ptools/auth/contracts";
import { Schema } from "effect";

/** Host-api request envelope for MCP auth status. */
export const HostMcpAuthStatusRequest = Schema.Struct({
  operation: Schema.Literal("mcp_auth_status"),
});
export type HostMcpAuthStatusRequest = Schema.Schema.Type<
  typeof HostMcpAuthStatusRequest
>;

const HostMcpAuthError = Schema.Struct({
  code: Schema.Literal(
    "invalid_config",
    "auth_unavailable",
    "invalid_oauth_callback",
    "oauth_failed",
  ),
  message: Schema.String,
});

/** Operation-owned result for auth status. */
export const HostMcpAuthStatusResult = Schema.Union(
  Schema.Struct({ ok: Schema.Literal(true), status: McpAuthStatus }),
  Schema.Struct({ ok: Schema.Literal(false), error: HostMcpAuthError }),
);
export type HostMcpAuthStatusResult = Schema.Schema.Type<
  typeof HostMcpAuthStatusResult
>;

/** Response for a dispatched mcp_auth_status operation. */
export const HostMcpAuthStatusResponse = Schema.Struct({
  operation: Schema.Literal("mcp_auth_status"),
  result: HostMcpAuthStatusResult,
});
export type HostMcpAuthStatusResponse = Schema.Schema.Type<
  typeof HostMcpAuthStatusResponse
>;

/** Caller-owned input for starting OAuth for one MCP server. */
export const StartHostMcpAuthInput = Schema.Struct({
  serverName: Schema.String,
  force: Schema.optional(Schema.Boolean),
});
export type StartHostMcpAuthInput = Schema.Schema.Type<
  typeof StartHostMcpAuthInput
>;

/** Host-api request envelope for starting one server's MCP auth flow. */
export const StartHostMcpAuthRequest = Schema.Struct({
  operation: Schema.Literal("start_mcp_auth"),
  input: StartHostMcpAuthInput,
});
export type StartHostMcpAuthRequest = Schema.Schema.Type<
  typeof StartHostMcpAuthRequest
>;

/** Operation-owned result for starting MCP auth. */
export const StartHostMcpAuthResult = Schema.Union(
  Schema.Struct({
    ok: Schema.Literal(true),
    authorizeUrl: Schema.String,
  }),
  Schema.Struct({ ok: Schema.Literal(false), error: HostMcpAuthError }),
);
export type StartHostMcpAuthResult = Schema.Schema.Type<
  typeof StartHostMcpAuthResult
>;

/** Response for a dispatched start_mcp_auth operation. */
export const StartHostMcpAuthResponse = Schema.Struct({
  operation: Schema.Literal("start_mcp_auth"),
  result: StartHostMcpAuthResult,
});
export type StartHostMcpAuthResponse = Schema.Schema.Type<
  typeof StartHostMcpAuthResponse
>;

/** Input extracted by a platform route from an OAuth provider callback. */
export const CompleteHostMcpOAuthCallbackInput = Schema.Struct({
  origin: Schema.String,
  provider: Schema.String,
  method: Schema.String,
  url: Schema.String,
  bodyText: Schema.optional(Schema.String),
});
export type CompleteHostMcpOAuthCallbackInput = Schema.Schema.Type<
  typeof CompleteHostMcpOAuthCallbackInput
>;

/** Host-api request envelope for completing an MCP OAuth callback. */
export const CompleteHostMcpOAuthCallbackRequest = Schema.Struct({
  operation: Schema.Literal("complete_mcp_oauth_callback"),
  input: CompleteHostMcpOAuthCallbackInput,
});
export type CompleteHostMcpOAuthCallbackRequest = Schema.Schema.Type<
  typeof CompleteHostMcpOAuthCallbackRequest
>;

/** Browser response payload returned after the host completes OAuth. */
export const HostMcpOAuthCallbackBrowserResponse = Schema.Struct({
  status: Schema.Number,
  headers: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.String }),
  ),
  body: Schema.String,
});
export type HostMcpOAuthCallbackBrowserResponse = Schema.Schema.Type<
  typeof HostMcpOAuthCallbackBrowserResponse
>;

/** Operation-owned result for completing an MCP OAuth callback. */
export const CompleteHostMcpOAuthCallbackResult = Schema.Union(
  Schema.Struct({
    ok: Schema.Literal(true),
    response: HostMcpOAuthCallbackBrowserResponse,
  }),
  Schema.Struct({ ok: Schema.Literal(false), error: HostMcpAuthError }),
);
export type CompleteHostMcpOAuthCallbackResult = Schema.Schema.Type<
  typeof CompleteHostMcpOAuthCallbackResult
>;

/** Response for a dispatched complete_mcp_oauth_callback operation. */
export const CompleteHostMcpOAuthCallbackResponse = Schema.Struct({
  operation: Schema.Literal("complete_mcp_oauth_callback"),
  result: CompleteHostMcpOAuthCallbackResult,
});
export type CompleteHostMcpOAuthCallbackResponse = Schema.Schema.Type<
  typeof CompleteHostMcpOAuthCallbackResponse
>;
