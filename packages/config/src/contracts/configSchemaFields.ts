/**
 * Shared field schemas used by config DTO contracts.
 *
 * These are package-internal schema building blocks for authored, normalized,
 * and resolved config contracts. They are intentionally not re-exported from
 * `@ptools/config/contracts` as standalone DTO concepts.
 */
import { Schema } from "effect";

/** String-keyed record used for environment variables, headers, and secrets. */
export const StringRecord = Schema.Record(Schema.String, Schema.String);

/** Optional executor settings shared across authored, normalized, and resolved config. */
export const ExecutorConfig = Schema.Struct({
  defaultTimeoutMs: Schema.OptionFromOptionalKey(Schema.Number),
});

/** OAuth settings before host secret placeholders have been resolved. */
export const UnresolvedHttpMcpAuthConfig = Schema.Struct({
  type: Schema.tag("oauth"),
  scope: Schema.OptionFromOptionalKey(Schema.String),
  resourceMetadataUrl: Schema.OptionFromOptionalKey(Schema.String),
  clientId: Schema.OptionFromOptionalKey(Schema.String),
  clientSecret: Schema.OptionFromOptionalKey(Schema.String),
  clientMetadataUrl: Schema.OptionFromOptionalKey(Schema.String),
  /**
   * Override the OAuth redirect URI sent to the upstream IdP.
   *
   * By default, ptools uses its own origin to construct the callback URL
   * (discovered from the host runtime). Set this field when the upstream IdP
   * requires a specific redirect URI that differs from ptools' default.
   */
  redirectUri: Schema.OptionFromOptionalKey(Schema.String),
});

/** Decoded unresolved OAuth auth settings. */
export type UnresolvedHttpMcpAuthConfig =
  typeof UnresolvedHttpMcpAuthConfig.Type;
