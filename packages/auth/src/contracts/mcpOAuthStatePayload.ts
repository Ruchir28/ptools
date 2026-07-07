/**
 * Signed MCP OAuth callback state payload.
 *
 * The payload is encoded into the browser-visible OAuth `state` parameter and
 * also stored as an issued nonce record. Runtime signing, verification, and
 * single-use consumption are owned by `McpOAuthStateStore`.
 */
import { Schema } from "effect";

export const McpOAuthStatePayload = Schema.Struct({
  provider: Schema.NonEmptyString,
  hostId: Schema.NonEmptyString,
  serverName: Schema.NonEmptyString,
  nonce: Schema.NonEmptyString,
  redirectAfterAuth: Schema.optional(Schema.String),
  issuedAt: Schema.NonEmptyString,
  expiresAt: Schema.NonEmptyString,
});
export type McpOAuthStatePayload = typeof McpOAuthStatePayload.Type;
