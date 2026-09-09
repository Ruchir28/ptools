import { Brand, Schema } from "effect";
import {
  ControlPlanePermission,
  type ControlPlanePermission as ControlPlanePermissionValue,
} from "./controlPlanePermission.js";
import { PrincipalId } from "./principal.js";

/**
 * Stable application identity for one Control Plane role.
 *
 * The runtime value is a canonical UUID string. Package-owned roles use
 * deterministic UUIDv5 values while future custom roles use generated UUIDv4 values;
 * assignments and administration operations use this identity regardless of
 * the platform's physical schema. The brand prevents an ordinary string or
 * Host role ID from being passed accidentally at this boundary.
 *
 * Platforms must preserve uniqueness but may store this value as text, native
 * UUID data, or 16 RFC-ordered bytes and may retain a separate private row PK.
 */
export const ControlPlaneRoleId = Schema.String.pipe(
  Schema.check(Schema.isUUID()),
  Schema.check(Schema.isLowercased()),
  Schema.brand("@ptools/ControlPlaneRoleId"),
);
export type ControlPlaneRoleId = Schema.Schema.Type<typeof ControlPlaneRoleId>;

/**
 * Complete, duplicate-free role selection used when replacing a Principal's
 * Control Plane assignments.
 *
 * An empty selection is valid at this contract boundary because removing all
 * roles from an ordinary Principal is supported. The owning store must perform
 * the mutation atomically and reject any replacement that would remove the
 * final Administrator.
 */
export const ControlPlaneRoleIdSelection = Schema.Array(
  ControlPlaneRoleId,
).pipe(
  Schema.check(
    Schema.makeFilter(
      (ids: ReadonlyArray<ControlPlaneRoleId>) =>
        new Set(ids).size === ids.length,
      { expected: "unique Control Plane role IDs" },
    ),
  ),
);
export type ControlPlaneRoleIdSelection = Schema.Schema.Type<
  typeof ControlPlaneRoleIdSelection
>;

/**
 * Rejects duplicate or reordered permission snapshots at construction and
 * persistence boundaries. Catalog order gives every role and resolved-access
 * projection one stable representation for equality, storage, and transport.
 * Callers must canonicalize first; decoding never silently sorts bad data.
 */
const canonicalPermissions = Schema.makeFilter(
  (permissions: ReadonlyArray<ControlPlanePermissionValue>) => {
    const indexes = permissions.map((permission) =>
      ControlPlanePermission.literals.indexOf(permission),
    );
    return (
      new Set(permissions).size === permissions.length &&
      indexes.every((index, position) =>
        position === 0 ? true : index > (indexes[position - 1] ?? -1),
      )
    );
  },
  { expected: "unique Control Plane permissions in catalog order" },
);

/**
 * Platform-neutral representation of one Control Plane role.
 *
 * Shared bootstrap, administration, and authorization services consume this
 * validated value. `roleId` is the immutable application UUID, independent of
 * any database row key; `name` is only a renameable label; and `permissions`
 * is a non-empty canonical snapshot. Authorization never infers authority from
 * the role UUID itself. Branding prevents an unvalidated same-shaped object
 * from being mistaken for a role.
 */
export class ControlPlaneRole extends Schema.Class<
  ControlPlaneRole,
  Brand.Brand<"ControlPlaneRole">
>("ControlPlaneRole")({
  roleId: ControlPlaneRoleId,
  name: Schema.NonEmptyString,
  permissions: Schema.NonEmptyArray(ControlPlanePermission).pipe(
    Schema.check(canonicalPermissions),
  ),
}) {}

/**
 * Current effective Control Plane authority resolved for one durable
 * Principal.
 *
 * The Control Plane access store produces this projection from the Principal's
 * persisted role assignments, including the Administrator role when assigned.
 * `Authorization`, request admission, and Control Plane policies consume
 * `effectivePermissions`; callers must not treat
 * this value as a role assignment or write it back to storage. An empty array
 * means the Principal currently has no Control Plane authority.
 */
export class PrincipalControlPlaneAccess extends Schema.Class<
  PrincipalControlPlaneAccess,
  Brand.Brand<"PrincipalControlPlaneAccess">
>("PrincipalControlPlaneAccess")({
  principalId: PrincipalId,
  effectivePermissions: Schema.Array(ControlPlanePermission).pipe(
    Schema.check(canonicalPermissions),
  ),
}) {}
