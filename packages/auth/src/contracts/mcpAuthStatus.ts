/**
 * Schema-backed MCP authentication status DTOs owned by `@ptools/auth`.
 *
 * This contract file is intentionally schema-only so protocol packages can
 * import `@ptools/auth/contracts` without loading the auth coordinator, OAuth
 * handlers, or MCP SDK runtime modules.
 */
import { Schema } from "effect";

/** Canonical public status values for upstream MCP authentication. */
export const McpAuthStatusValue = Schema.Literals([
  "connected",
  "requires_auth",
  "auth_in_progress",
  "auth_failed",
  "needs_config",
  "static_credentials",
  "unsupported_auth",
  "disabled",
]);
export type McpAuthStatusValue = Schema.Schema.Type<typeof McpAuthStatusValue>;

/** Per-server MCP authentication status exposed at host and Code Mode boundaries. */
export const McpAuthServerStatus = Schema.Struct({
  serverName: Schema.String,
  jsServerName: Schema.String,
  transport: Schema.Literals(["http", "stdio"]),
  status: McpAuthStatusValue,
  authUrl: Schema.optional(Schema.String),
  authorizeUrl: Schema.optional(Schema.String),
  reauthorizeUrl: Schema.optional(Schema.String),
  setupUrl: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
  lastError: Schema.optional(Schema.String),
});
export type McpAuthServerStatus = Schema.Schema.Type<
  typeof McpAuthServerStatus
>;

/** Complete MCP authentication status payload for a host origin. */
export const McpAuthStatus = Schema.Struct({
  authUrl: Schema.String,
  servers: Schema.Array(McpAuthServerStatus),
});
export type McpAuthStatus = Schema.Schema.Type<typeof McpAuthStatus>;
