/**
 * Ptools secret value map contract.
 *
 * Hosts receive this DTO when callers bootstrap the concrete secret values used
 * to resolve `${env:NAME}` placeholders in ptools config. Runtime lookup remains
 * owned by the `SecretResolver` Effect service; this contract only describes
 * the batch payload shape at setup boundaries.
 */
import { Schema } from "effect";

/** Map of secret names to resolved string values supplied to a host. */
export const PtoolsSecretValues = Schema.Record({
  key: Schema.String,
  value: Schema.String,
});
export type PtoolsSecretValues = typeof PtoolsSecretValues.Type;
