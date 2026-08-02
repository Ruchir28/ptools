/**
 * Contract for `HostAccessStore.createMembership`.
 *
 * Input: the user/host pair and complete initial application role-key
 * selection. Success: the newly visible matching `HostMemberAccess` directly.
 * The platform resolves role keys and publishes membership plus assignments
 * atomically before returning effective access.
 */
import { Brand, Schema } from "effect";
import {
  HostAccessInvariantViolation,
  HostAccessStoreError,
  HostMembershipAlreadyExists,
  HostRolesNotFound,
  RegisteredHostNotFound,
} from "../hostAccessErrors.js";
import { HostRoleKeySelection } from "../hostRole.js";

/** Complete role selection for a new user membership on one registered host. */
export class CreateHostMembershipInput extends Schema.Class<
  CreateHostMembershipInput,
  Brand.Brand<"CreateHostMembershipInput">
>("CreateHostMembershipInput")({
  hostId: Schema.NonEmptyString,
  userId: Schema.NonEmptyString,
  roleKeys: HostRoleKeySelection,
}) {}

/** Failures published by `HostAccessStore.createMembership`. */
export type CreateHostMembershipError =
  | RegisteredHostNotFound
  | HostRolesNotFound
  | HostMembershipAlreadyExists
  | HostAccessInvariantViolation
  | HostAccessStoreError;
