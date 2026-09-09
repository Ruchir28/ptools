import { Schema } from "effect";
import { ControlPlaneRoleId } from "./controlPlaneRole.js";

export const ControlPlaneAccessOperation = Schema.Literals([
  "initialize",
  "ensurePrincipal",
  "getClaimStatus",
  "claimInitialAdministrator",
  "resolvePermissions",
  "replaceRoles",
]);
export type ControlPlaneAccessOperation = Schema.Schema.Type<
  typeof ControlPlaneAccessOperation
>;

/** Presented setup authority is invalid, consumed, or the Control Plane is claimed. */
export class ControlPlaneClaimRejected extends Schema.TaggedErrorClass<ControlPlaneClaimRejected>()(
  "ControlPlaneClaimRejected",
  { message: Schema.NonEmptyString },
) {}

/** One or more requested Control Plane role UUIDs do not exist. */
export class ControlPlaneRolesNotFound extends Schema.TaggedErrorClass<ControlPlaneRolesNotFound>()(
  "ControlPlaneRolesNotFound",
  { roleIds: Schema.Array(ControlPlaneRoleId), message: Schema.NonEmptyString },
) {}

/** A role mutation attempted to leave the Control Plane without an Administrator. */
export class LastControlPlaneAdministrator extends Schema.TaggedErrorClass<LastControlPlaneAdministrator>()(
  "LastControlPlaneAdministrator",
  { message: Schema.NonEmptyString },
) {}

/** Persisted state or an adapter result violated a shared contract. */
export class ControlPlaneAccessInvariantViolation extends Schema.TaggedErrorClass<ControlPlaneAccessInvariantViolation>()(
  "ControlPlaneAccessInvariantViolation",
  { operation: ControlPlaneAccessOperation, message: Schema.NonEmptyString },
) {}

/** Safe projection of persistence or remote-service failure. */
export class ControlPlaneAccessStoreError extends Schema.TaggedErrorClass<ControlPlaneAccessStoreError>()(
  "ControlPlaneAccessStoreError",
  { operation: ControlPlaneAccessOperation, message: Schema.NonEmptyString },
) {}

/** Secure randomness, UUID, or digest capability failed. */
export class ControlPlaneBootstrapCryptoError extends Schema.TaggedErrorClass<ControlPlaneBootstrapCryptoError>()(
  "ControlPlaneBootstrapCryptoError",
  { message: Schema.NonEmptyString },
) {}
