import { Brand, Schema } from "effect";
import type { RegisteredHostNotFound } from "../hostAccessErrors.js";
import {
  EpochMillis,
  HostTokenName,
  HostTokenPermissionSelection,
  type IssuedHostToken,
} from "../hostToken.js";
import type {
  HostTokenCryptoError,
  HostTokenExpirationInvalid,
  HostTokenInvariantViolation,
  HostTokenRecordAlreadyExists,
  HostTokenStoreError,
} from "../hostTokenErrors.js";

/**
 * Validated data a client is allowed to choose when requesting a token: target
 * host, display label, exact delegated grants, and optional expiry. Issuer
 * identity is deliberately absent because later trusted admission supplies the
 * authenticated `PrincipalCaller` separately to `HostTokenService.issue`.
 * This DTO therefore cannot forge creation audit fields or authorization context.
 */
export class IssueHostTokenInput extends Schema.Class<
  IssueHostTokenInput,
  Brand.Brand<"IssueHostTokenInput">
>("IssueHostTokenInput")({
  hostId: Schema.NonEmptyString,
  name: HostTokenName,
  grantedPermissions: HostTokenPermissionSelection,
  expiresAtEpochMs: Schema.OptionFromOptionalKey(EpochMillis),
}) {}

export type IssueHostTokenError =
  | HostTokenExpirationInvalid
  | HostTokenRecordAlreadyExists
  | HostTokenInvariantViolation
  | HostTokenStoreError
  | HostTokenCryptoError
  | RegisteredHostNotFound;

export type IssueHostTokenSuccess = IssuedHostToken;
