import type { CredentialsStore } from "@ptools/auth";
import { Schema } from "effect";
import type { Context } from "effect";
import type { CodeModeObjectStorageService } from "../platform.js";

export type CredentialsStoreService = Context.Tag.Service<
  typeof CredentialsStore
>;

/**
 * Signed, externally supplied OAuth callback state.
 *
 * Use `.make(...)` to construct application-owned values and
 * `Schema.decodeUnknown(...)` when loading external or stored values.
 */
export const CloudflareOAuthStatePayloadSchema = Schema.Struct({
  provider: Schema.NonEmptyString,
  hostId: Schema.NonEmptyString,
  serverName: Schema.NonEmptyString,
  nonce: Schema.NonEmptyString,
  redirectAfterAuth: Schema.optional(Schema.String),
  issuedAt: Schema.NonEmptyString,
  expiresAt: Schema.NonEmptyString,
});

export interface CloudflareOAuthPlatform {
  readonly storage: CodeModeObjectStorageService;
  readonly credentialsStore: CredentialsStoreService;
  readonly hostId: string;
  readonly origin: string;
}
