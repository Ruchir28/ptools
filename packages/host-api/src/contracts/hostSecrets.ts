/**
 * Host secret setup DTOs.
 *
 * This file owns the host-api operation envelope for sending secret values
 * separately from ptools config. The secret map itself is owned by
 * `@ptools/config`; this file intentionally does not own config parsing,
 * runtime lookup, or secret storage implementation details.
 */
import { PtoolsSecretValues } from "@ptools/config/contracts";
import { Schema } from "effect";

/** Secret map supplied to the host for resolving `${env:NAME}` placeholders. */
export const ConfigureHostSecretsInput = Schema.Struct({
  secrets: PtoolsSecretValues,
});
export type ConfigureHostSecretsInput = Schema.Schema.Type<
  typeof ConfigureHostSecretsInput
>;

/** Host-api request envelope for replacing a host's configured secrets. */
export const ConfigureHostSecretsRequest = Schema.Struct({
  operation: Schema.Literal("configure_secrets"),
  input: ConfigureHostSecretsInput,
});
export type ConfigureHostSecretsRequest = Schema.Schema.Type<
  typeof ConfigureHostSecretsRequest
>;

/** Operation-owned result for host secret setup. */
export const ConfigureHostSecretsResult = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    configured: Schema.Literal(true),
    hostId: Schema.optional(Schema.String),
    secretCount: Schema.optional(Schema.Number),
    updatedAt: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    ok: Schema.Literal(false),
    error: Schema.Struct({
      // Structural invalidity is rejected while decoding HostOperationRequest,
      // before the typed HostInstanceHandler runs. Operation execution can fail
      // here only after a valid secret map reaches the backing store.
      code: Schema.Literal("secrets_storage_unavailable"),
      message: Schema.String,
    }),
  }),
]);
export type ConfigureHostSecretsResult = Schema.Schema.Type<
  typeof ConfigureHostSecretsResult
>;

/** Response for a dispatched configure_secrets operation. */
export const ConfigureHostSecretsResponse = Schema.Struct({
  operation: Schema.Literal("configure_secrets"),
  result: ConfigureHostSecretsResult,
});
export type ConfigureHostSecretsResponse = Schema.Schema.Type<
  typeof ConfigureHostSecretsResponse
>;
