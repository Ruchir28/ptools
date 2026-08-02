import { Brand, Schema } from "effect";
import type { VerifiedHostToken } from "../hostToken.js";
import type {
  HostTokenCryptoError,
  HostTokenInvariantViolation,
  HostTokenRejected,
  HostTokenStoreError,
} from "../hostTokenErrors.js";

/**
 * Credential ingress value passed from authentication middleware to the shared
 * verifier. The schema checks only non-emptiness on purpose: malformed formats,
 * unsupported versions, missing records, expiry, and revocation must all reach
 * `HostTokenService.verify` and become the same `HostTokenRejected` failure,
 * rather than leaking format details as request-schema diagnostics.
 */
export class VerifyHostTokenInput extends Schema.Class<
  VerifyHostTokenInput,
  Brand.Brand<"VerifyHostTokenInput">
>("VerifyHostTokenInput")({
  plaintext: Schema.NonEmptyString,
}) {}

export type VerifyHostTokenError =
  | HostTokenRejected
  | HostTokenInvariantViolation
  | HostTokenStoreError
  | HostTokenCryptoError;

export type VerifyHostTokenSuccess = VerifiedHostToken;
