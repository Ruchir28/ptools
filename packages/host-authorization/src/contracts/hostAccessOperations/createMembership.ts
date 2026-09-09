/**
 * Contract for `HostAccessStore.createMembership`.
 *
 * Input: the Principal/Host pair and complete initial role-UUID selection.
 * The platform resolves those logical IDs against its private representation
 * and atomically publishes membership plus assignments.
 */
import { Brand, Schema } from "effect";
import {
  HostAccessInvariantViolation,
  HostAccessStoreError,
  HostMembershipAlreadyExists,
  HostRolesNotFound,
  RegisteredHostNotFound,
} from "../hostAccessErrors.js";
import { HostRoleIdSelection } from "../hostRole.js";
import { PrincipalId } from "../principal.js";

/** Complete role selection for a new Principal membership on one Host. */
export class CreateHostMembershipInput extends Schema.Class<
  CreateHostMembershipInput,
  Brand.Brand<"CreateHostMembershipInput">
>("CreateHostMembershipInput")({
  hostId: Schema.NonEmptyString,
  principalId: PrincipalId,
  roleIds: HostRoleIdSelection,
}) {}

/** Failures published by `HostAccessStore.createMembership`. */
export type CreateHostMembershipError =
  | RegisteredHostNotFound
  | HostRolesNotFound
  | HostMembershipAlreadyExists
  | HostAccessInvariantViolation
  | HostAccessStoreError;
