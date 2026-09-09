import { Option } from "effect";
import {
  HostToken,
  HostTokenRecord,
  VerifiedHostToken,
} from "./contracts/hostToken.js";
import { HostTokenCaller } from "./contracts/hostCaller.js";

/**
 * Crosses from the trusted persistence representation to the management-safe
 * representation returned by issue/revoke operations. The new `HostToken`
 * deliberately copies display, grant, expiry, and audit fields but has no
 * `tokenHash` field, so callers cannot accidentally disclose the lookup digest.
 * This does not mutate the stored record or recover the plaintext credential.
 */
export const projectSafeHostToken = (record: HostTokenRecord): HostToken =>
  HostToken.make({
    tokenId: record.tokenId,
    hostId: record.hostId,
    name: record.name,
    grantedPermissions: record.grantedPermissions,
    createdAtEpochMs: record.createdAtEpochMs,
    issuedByPrincipalId: record.issuedByPrincipalId,
    expiresAtEpochMs: record.expiresAtEpochMs,
    revokedAtEpochMs: record.revokedAtEpochMs,
    revokedByPrincipalId: record.revokedByPrincipalId,
  });

/**
 * Converts a successfully verified persistence record into the authority that
 * later request admission is allowed to consume. The principal carries only
 * the stable token ID and persisted host binding; `effectivePermissions` is the
 * immutable issuance-time grant snapshot. Hash, expiry, revocation, and issuer
 * metadata stay behind the authentication boundary and are not exposed.
 */
export const projectVerifiedHostToken = (
  record: HostTokenRecord,
): VerifiedHostToken =>
  VerifiedHostToken.make({
    principal: HostTokenCaller.make({
      tokenId: record.tokenId,
      hostId: record.hostId,
    }),
    effectivePermissions: record.grantedPermissions,
  });

/**
 * Applies the time-dependent checks that decide whether a found record may
 * authenticate now. Revocation always rejects, and expiry rejects at the exact
 * boundary (`now >= expiresAtEpochMs`). Format validation and hash lookup happen
 * before this helper; route-host authorization happens later, after verification.
 */
export const isHostTokenActiveAt = (
  record: HostTokenRecord,
  nowEpochMs: number,
): boolean =>
  Option.isNone(record.revokedAtEpochMs) &&
  (Option.isNone(record.expiresAtEpochMs) ||
    nowEpochMs < record.expiresAtEpochMs.value);
