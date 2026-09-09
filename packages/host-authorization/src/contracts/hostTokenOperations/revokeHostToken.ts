import { Brand, Schema } from "effect";
import { EpochMillis, type HostToken } from "../hostToken.js";
import type {
  HostTokenInvariantViolation,
  HostTokenNotFound,
  HostTokenStoreError,
} from "../hostTokenErrors.js";
import { HostTokenId } from "../hostTokenIdentity.js";
import { PrincipalId } from "../principal.js";

/**
 * Public management selection identifying which token to revoke under which
 * host. Requiring both values prevents token-ID-only cross-host mutation. The
 * authenticated revoker is not caller-authored; admission passes an exact
 * `PrincipalCaller` separately to `HostTokenService.revoke` for audit.
 */
export class RevokeHostTokenInput extends Schema.Class<
  RevokeHostTokenInput,
  Brand.Brand<"RevokeHostTokenInput">
>("RevokeHostTokenInput")({
  hostId: Schema.NonEmptyString,
  tokenId: HostTokenId,
}) {}

/**
 * Trusted mutation command created inside `HostTokenService` after admission.
 * It combines the public host/token selection with the service clock timestamp
 * and admitted revoker Principal ID. `HostTokenRecordStore.revoke` owns the atomic,
 * idempotent compare/set: first use writes these facts; repeats return the
 * original record without replacing its first revocation audit values.
 */
export class RevokeHostTokenRecordInput extends Schema.Class<
  RevokeHostTokenRecordInput,
  Brand.Brand<"RevokeHostTokenRecordInput">
>("RevokeHostTokenRecordInput")({
  hostId: Schema.NonEmptyString,
  tokenId: HostTokenId,
  revokedAtEpochMs: EpochMillis,
  revokedByPrincipalId: PrincipalId,
}) {}

export type RevokeHostTokenError =
  | HostTokenNotFound
  | HostTokenInvariantViolation
  | HostTokenStoreError;

export type RevokeHostTokenSuccess = HostToken;
