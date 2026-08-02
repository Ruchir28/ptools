/**
 * Contract for `HostAccessStore.replaceMembershipRoles`.
 *
 * Input: one existing membership and its complete replacement role-key set.
 * Success: the matching replacement `HostMemberAccess` directly. This is not a
 * patch: either the previous or complete replacement assignments are visible,
 * never an empty or partial intermediate state.
 */
import { Brand, Schema } from "effect";
import {
  HostAccessInvariantViolation,
  HostAccessStoreError,
  HostMembershipNotFound,
  HostRolesNotFound,
  RegisteredHostNotFound,
} from "../hostAccessErrors.js";
import { HostRoleKeySelection } from "../hostRole.js";

/** Complete replacement role selection for one existing membership. */
export class ReplaceMembershipRolesInput extends Schema.Class<
  ReplaceMembershipRolesInput,
  Brand.Brand<"ReplaceMembershipRolesInput">
>("ReplaceMembershipRolesInput")({
  hostId: Schema.NonEmptyString,
  userId: Schema.NonEmptyString,
  roleKeys: HostRoleKeySelection,
}) {}

/** Failures published by `HostAccessStore.replaceMembershipRoles`. */
export type ReplaceMembershipRolesError =
  | RegisteredHostNotFound
  | HostRolesNotFound
  | HostMembershipNotFound
  | HostAccessInvariantViolation
  | HostAccessStoreError;
