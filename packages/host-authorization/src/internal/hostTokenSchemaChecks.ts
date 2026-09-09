import { Encoding, Option, Result, Schema } from "effect";
import type { HostPermission } from "../contracts/hostPermission.js";
import { hasUniqueCanonicalPermissions } from "./hostAccessSchemaChecks.js";

/**
 * Rejects alternate textual encodings of the same bytes by decoding and then
 * requiring an exact unpadded base64url round trip. The byte-length check makes
 * this usable for both the 32-byte random secret and 32-byte SHA-256 digest.
 */
export const isCanonicalBase64UrlBytes = (
  value: string,
  expectedBytes: number,
): boolean => {
  const decoded = Encoding.decodeBase64Url(value);
  return (
    Result.isSuccess(decoded) &&
    decoded.success.length === expectedBytes &&
    Encoding.encodeBase64Url(decoded.success) === value
  );
};

/** Validates the complete V1 prefix and canonical 256-bit secret encoding. */
export const exactV1HostTokenFormat = Schema.makeFilter(
  (value: string) => {
    const prefix = "ptools_host_v1_";
    return (
      value.startsWith(prefix) &&
      isCanonicalBase64UrlBytes(value.slice(prefix.length), 32)
    );
  },
  { expected: "ptools_host_v1_ followed by a canonical 32-byte base64url secret" },
);

/** Ensures persisted hash keys are canonical, fixed-length SHA-256 values. */
export const sha256Base64UrlFormat = Schema.makeFilter(
  (value: string) => isCanonicalBase64UrlBytes(value, 32),
  { expected: "a canonical 32-byte SHA-256 base64url digest" },
);

/** Prevents empty, duplicate, unknown-order, or reordered delegated grants. */
export const canonicalPermissionSelection = Schema.makeFilter(
  (values: ReadonlyArray<HostPermission>) =>
    values.length > 0 && hasUniqueCanonicalPermissions(values),
  { expected: "non-empty unique permissions in HostPermission catalog order" },
);

/**
 * Compares lifecycle fields that cannot be validated independently: expiry must
 * follow creation, revocation time and revoker must appear together, and a
 * revocation cannot predate creation. Effect Schema invokes this predicate when
 * constructing or decoding both `HostToken` and `HostTokenRecord`; the inline
 * parameter shape is only the subset of fields this check needs, not a DTO.
 */
export const validHostTokenLifecycle = Schema.makeFilter(
  (value: {
    readonly createdAtEpochMs: number;
    readonly expiresAtEpochMs: Option.Option<number>;
    readonly revokedAtEpochMs: Option.Option<number>;
    readonly revokedByPrincipalId: Option.Option<string>;
  }) => {
    const hasRevokedAt = Option.isSome(value.revokedAtEpochMs);
    const hasRevoker = Option.isSome(value.revokedByPrincipalId);
    return (
      (Option.isNone(value.expiresAtEpochMs) ||
        value.expiresAtEpochMs.value > value.createdAtEpochMs) &&
      hasRevokedAt === hasRevoker &&
      (Option.isNone(value.revokedAtEpochMs) ||
        value.revokedAtEpochMs.value >= value.createdAtEpochMs)
    );
  },
  { expected: "a consistent host-token lifecycle" },
);
