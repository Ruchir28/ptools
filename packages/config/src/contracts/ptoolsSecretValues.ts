/**
 * Ptools secret value map contract.
 *
 * Hosts receive this DTO when callers bootstrap the concrete secret values used
 * to resolve `${env:NAME}` placeholders in ptools config. Runtime lookup and
 * replacement are owned by the `ConfiguredSecretStore` Effect service; this
 * contract only describes the batch payload shape at setup boundaries.
 */
import { Schema } from "effect";

/** Map of secret names to resolved string values supplied to a host. */
export const PtoolsSecretValues = Schema.Record(Schema.String, Schema.String);
export type PtoolsSecretValues = typeof PtoolsSecretValues.Type;
