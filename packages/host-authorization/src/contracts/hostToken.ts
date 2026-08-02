import { Brand, Effect, Schema } from "effect";
import {
  canonicalPermissionSelection,
  exactV1HostTokenFormat,
  sha256Base64UrlFormat,
  validHostTokenLifecycle,
} from "../internal/hostTokenSchemaChecks.js";
import { HostTokenCaller } from "./hostCallerPrincipal.js";
import { HostPermission } from "./hostPermission.js";
import { HostTokenId } from "./hostTokenIdentity.js";

/**
 * Shared representation for persisted token lifecycle times. Values are
 * non-negative integral Unix-epoch milliseconds so Node, Workers, RPC, and
 * storage adapters use one unambiguous unit at every boundary.
 */
export const EpochMillis = Schema.Number.pipe(
  Schema.check(Schema.isInt()),
  Schema.check(Schema.isGreaterThanOrEqualTo(0)),
);
export type EpochMillis = Schema.Schema.Type<typeof EpochMillis>;

/**
 * User-authored label shown when managing a token, such as "OpenCode laptop".
 * It is trimmed and bounded for safe display, but is intentionally non-unique:
 * lookup and authorization always use `HostTokenId` and persisted grants.
 */
export const HostTokenName = Schema.String.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(100)),
  Schema.brand("HostTokenName"),
);
export type HostTokenName = Schema.Schema.Type<typeof HostTokenName>;

/**
 * Exact permissions delegated to a token at issuance time. The selection must
 * be non-empty, unique, and in `HostPermission.literals` order so every platform
 * persists and compares the same canonical snapshot. Verification returns this
 * snapshot unchanged; later membership changes do not rewrite token authority.
 */
export const HostTokenPermissionSelection = Schema.NonEmptyArray(
  HostPermission,
).pipe(Schema.check(canonicalPermissionSelection));
export type HostTokenPermissionSelection = Schema.Schema.Type<
  typeof HostTokenPermissionSelection
>;

/**
 * Complete bearer credential handed to the user exactly once after issuance.
 * The brand proves the `ptools_host_v1_<32-byte-base64url-secret>` syntax, not
 * that the credential exists in storage. Persistence must receive only its
 * `HostTokenHash`; this value must never be logged or placed in token metadata.
 */
export const HostTokenPlaintext = Schema.String.pipe(
  Schema.check(exactV1HostTokenFormat),
  Schema.brand("HostTokenPlaintext"),
);
export type HostTokenPlaintext = Schema.Schema.Type<typeof HostTokenPlaintext>;

/**
 * Fixed-length lookup key produced by SHA-256 hashing the complete prefixed
 * plaintext credential. Platform stores index this value and never store the
 * plaintext. It is trusted persistence data, not a management/API response field.
 */
export const HostTokenHash = Schema.String.pipe(
  Schema.check(sha256Base64UrlFormat),
  Schema.brand("HostTokenHash"),
);
export type HostTokenHash = Schema.Schema.Type<typeof HostTokenHash>;

// One field set intentionally backs both disclosure-safe metadata and the
// trusted persistence record. The classes below differ only at the security
// boundary: HostTokenRecord adds a version and hash; HostToken never can.
const safeTokenFields = {
  tokenId: HostTokenId,
  hostId: Schema.NonEmptyString,
  name: HostTokenName,
  grantedPermissions: HostTokenPermissionSelection,
  createdAtEpochMs: EpochMillis,
  issuedByUserId: Schema.NonEmptyString,
  expiresAtEpochMs: Schema.OptionFromOptionalKey(EpochMillis),
  revokedAtEpochMs: Schema.OptionFromOptionalKey(EpochMillis),
  revokedByUserId: Schema.OptionFromOptionalKey(Schema.NonEmptyString),
} as const;

/**
 * Management-safe view returned after issue or revoke. It contains the token's
 * identity, host binding, grants, and lifecycle audit facts, but structurally
 * cannot contain either the bearer plaintext or its lookup hash. Public Host API
 * responses should expose this class rather than `HostTokenRecord`.
 */
export class HostToken extends Schema.Class<HostToken, Brand.Brand<"HostToken">>(
  "HostToken",
)(Schema.Struct(safeTokenFields).pipe(Schema.check(validHostTokenLifecycle))) {}

/**
 * Complete platform-neutral record exchanged with `HostTokenRecordStore`.
 * It contains the digest needed for authentication lookup plus safe metadata,
 * but never the bearer plaintext. Database/D1 adapters own physical rows and
 * must strictly decode them into this class before returning to shared logic.
 */
export class HostTokenRecord extends Schema.Class<
  HostTokenRecord,
  Brand.Brand<"HostTokenRecord">
>("HostTokenRecord")(
  Schema.Struct({
    credentialVersion: Schema.Literal(1).pipe(
      Schema.withConstructorDefault(Effect.succeed(1 as const)),
    ),
    tokenHash: HostTokenHash,
    ...safeTokenFields,
  }).pipe(Schema.check(validHostTokenLifecycle)),
) {}

/**
 * Successful issuance result returned only after `HostTokenRecordStore.create`
 * has persisted the complete hash-only record. `plaintext` is the sole delivery
 * of the bearer secret; `token` is the safe metadata clients may retain for
 * management. There is intentionally no operation that reconstructs this result.
 */
export class IssuedHostToken extends Schema.Class<
  IssuedHostToken,
  Brand.Brand<"IssuedHostToken">
>("IssuedHostToken")({
  plaintext: HostTokenPlaintext,
  token: HostToken,
}) {}

/**
 * Request-scoped authority produced after strict parsing, digest lookup, and
 * active-lifecycle checks succeed. It exposes the machine principal's persisted
 * host binding and immutable grants, but no credential or persistence details.
 * Later host admission still must compare the principal host with the route host.
 */
export class VerifiedHostToken extends Schema.Class<
  VerifiedHostToken,
  Brand.Brand<"VerifiedHostToken">
>("VerifiedHostToken")({
  principal: HostTokenCaller,
  effectivePermissions: HostTokenPermissionSelection,
}) {}
