/**
 * Wire-safe host-access failures for the store boundary and trusted RPC.
 *
 * Keep domain absence (not-found), programmer/platform contract breaks
 * (invariant), and infrastructure failures (store error) distinct so middleware
 * never treats a DB outage as authorization denial.
 */
import { Schema } from "effect";
import { HostRoleKey, HostRoleKeySelection } from "./hostRole.js";

/** Exact operation discriminators used by shared store diagnostics. */
export const HostAccessStoreOperation = Schema.Literals([
  "getRegisteredHost",
  "createOwnedHost",
  "listUserHosts",
  "resolveUserHostAccess",
  "createMembership",
  "replaceMembershipRoles",
  "getHostRole",
  "listHostRoles",
]);
export type HostAccessStoreOperation = Schema.Schema.Type<
  typeof HostAccessStoreOperation
>;

/** The requested host is not present in the central registration catalog. */
export class RegisteredHostNotFound extends Schema.TaggedErrorClass<RegisteredHostNotFound>()(
  "RegisteredHostNotFound",
  { hostId: Schema.NonEmptyString, message: Schema.NonEmptyString },
) {}

/** Creation cannot proceed because the registered host already exists. */
export class RegisteredHostAlreadyExists extends Schema.TaggedErrorClass<RegisteredHostAlreadyExists>()(
  "RegisteredHostAlreadyExists",
  { hostId: Schema.NonEmptyString, message: Schema.NonEmptyString },
) {}

/** No current role exists for the requested stable application key. */
export class HostRoleNotFound extends Schema.TaggedErrorClass<HostRoleNotFound>()(
  "HostRoleNotFound",
  {
    roleKey: HostRoleKey,
    message: Schema.NonEmptyString,
  },
) {}

/** One or more requested membership role keys do not currently exist. */
export class HostRolesNotFound extends Schema.TaggedErrorClass<HostRolesNotFound>()(
  "HostRolesNotFound",
  {
    roleKeys: HostRoleKeySelection,
    message: Schema.NonEmptyString,
  },
) {}

/** The user has no current membership on the existing registered host. */
export class HostMembershipNotFound extends Schema.TaggedErrorClass<HostMembershipNotFound>()(
  "HostMembershipNotFound",
  {
    hostId: Schema.NonEmptyString,
    userId: Schema.NonEmptyString,
    message: Schema.NonEmptyString,
  },
) {}

/** Membership creation cannot replace an already-existing membership. */
export class HostMembershipAlreadyExists extends Schema.TaggedErrorClass<HostMembershipAlreadyExists>()(
  "HostMembershipAlreadyExists",
  {
    hostId: Schema.NonEmptyString,
    userId: Schema.NonEmptyString,
    message: Schema.NonEmptyString,
  },
) {}

/** Decoded state or a platform result violated the shared operation contract. */
export class HostAccessInvariantViolation extends Schema.TaggedErrorClass<HostAccessInvariantViolation>()(
  "HostAccessInvariantViolation",
  {
    operation: HostAccessStoreOperation,
    message: Schema.NonEmptyString,
  },
) {}

/** Safe projection of a persistence or remote-service infrastructure failure. */
export class HostAccessStoreError extends Schema.TaggedErrorClass<HostAccessStoreError>()(
  "HostAccessStoreError",
  {
    operation: HostAccessStoreOperation,
    message: Schema.NonEmptyString,
  },
) {}
