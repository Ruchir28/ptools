import { Schema } from "effect";
import { HostTokenId } from "./hostTokenIdentity.js";

/** Shared lifecycle operation attached to service-level diagnostics. */
export const HostTokenOperation = Schema.Literals(["issue", "verify", "revoke"]);
export type HostTokenOperation = Schema.Schema.Type<typeof HostTokenOperation>;

/** Exact persistence-port method attached to infrastructure diagnostics. */
export const HostTokenRecordStoreOperation = Schema.Literals([
  "create",
  "findByHash",
  "revoke",
]);
export type HostTokenRecordStoreOperation = Schema.Schema.Type<
  typeof HostTokenRecordStoreOperation
>;

/**
 * Deliberately indistinguishable authentication failure for malformed, unknown,
 * expired, or revoked bearer credentials. Keeping one public error prevents a
 * caller from probing token existence or lifecycle state; crypto, store, and
 * malformed-persisted-state failures must remain separate errors.
 */
export class HostTokenRejected extends Schema.TaggedErrorClass<HostTokenRejected>()(
  "HostTokenRejected",
  { message: Schema.NonEmptyString },
) {}

/**
 * Expected management failure when `(hostId, tokenId)` does not identify a
 * record. A token belonging to another host produces this same result, so revoke
 * cannot reveal or mutate a token merely because its UUID is known.
 */
export class HostTokenNotFound extends Schema.TaggedErrorClass<HostTokenNotFound>()(
  "HostTokenNotFound",
  {
    hostId: Schema.NonEmptyString,
    tokenId: HostTokenId,
    message: Schema.NonEmptyString,
  },
) {}

/**
 * Persistence rejected issuance because the generated token UUID or digest hit
 * a uniqueness constraint. The error intentionally omits both values—especially
 * the digest—while allowing the lifecycle caller to distinguish a collision
 * from infrastructure failure.
 */
export class HostTokenRecordAlreadyExists extends Schema.TaggedErrorClass<HostTokenRecordAlreadyExists>()(
  "HostTokenRecordAlreadyExists",
  { message: Schema.NonEmptyString },
) {}

/**
 * Signals that trusted persistence/crypto output contradicted a shared invariant,
 * such as a hash lookup returning a different digest. This is an implementation
 * or data-contract problem, not an invalid credential and not expected absence,
 * so authentication and management layers must not downgrade it to either.
 */
export class HostTokenInvariantViolation extends Schema.TaggedErrorClass<HostTokenInvariantViolation>()(
  "HostTokenInvariantViolation",
  { operation: HostTokenOperation, message: Schema.NonEmptyString },
) {}

/**
 * Wire-safe infrastructure failure from one `HostTokenRecordStore` operation.
 * Platform adapters create this after removing SQL, ORM, row, RPC, credential,
 * digest, and complete-Cause details. Consumers may report service unavailability
 * without misrepresenting it as token rejection or not-found.
 */
export class HostTokenStoreError extends Schema.TaggedErrorClass<HostTokenStoreError>()(
  "HostTokenStoreError",
  { operation: HostTokenRecordStoreOperation, message: Schema.NonEmptyString },
) {}

/**
 * Wire-safe failure of the platform-provided `Crypto.Crypto` capability during
 * random-secret generation, UUID generation, or SHA-256 hashing. It identifies
 * the lifecycle operation but carries no plaintext, digest, or complete Cause.
 */
export class HostTokenCryptoError extends Schema.TaggedErrorClass<HostTokenCryptoError>()(
  "HostTokenCryptoError",
  { operation: HostTokenOperation, message: Schema.NonEmptyString },
) {}

/**
 * Caller-correctable issuance failure raised before randomness or persistence
 * when the requested expiry is not strictly later than the service clock. This
 * prevents creating a credential that is already unusable at successful return.
 */
export class HostTokenExpirationInvalid extends Schema.TaggedErrorClass<HostTokenExpirationInvalid>()(
  "HostTokenExpirationInvalid",
  { message: Schema.NonEmptyString },
) {}
