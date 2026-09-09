import { deriveBuiltInRoleId } from "../internal/builtInRoleId.js";
import { HostPermissions, type HostPermission } from "./hostPermission.js";
import { HostRole, HostRoleId } from "./hostRole.js";

/**
 * Current version of the package-authored Host-role catalog.
 *
 * This number versions catalog contents, not the UUID syntax or UUIDv5
 * namespace. Platforms persist the applied version in migration metadata and
 * advance it atomically with every future catalog transition.
 */
export const BuiltInHostRoleDefinitionVersion = 1;

const makeBuiltInHostRole = (
  canonicalName: `host/${string}`,
  name: string,
  permissions: readonly [HostPermission, ...ReadonlyArray<HostPermission>],
): HostRole =>
  Object.freeze(
    HostRole.make({
      roleId: HostRoleId.make(deriveBuiltInRoleId(canonicalName)),
      name,
      permissions: Object.freeze([...permissions]) as readonly [
        HostPermission,
        ...ReadonlyArray<HostPermission>,
      ],
    }),
  );

/**
 * Package-owned Host roles installed by platform initialization.
 *
 * Each role is a complete shared `HostRole`. Its UUIDv5 `roleId` is derived
 * from the permanent ptools role namespace and the immutable canonical names
 * `host/member`, `host/admin`, and `host/owner`. Those canonical names are
 * identity material and must never be renamed or reused; the displayed `name`
 * may change independently.
 *
 * Platforms insert these exact logical IDs and may map them to any private row
 * representation. Memberships, default-Owner assignment, and future catalog
 * migrations use the role UUID directly, so no seed key, binding table, or
 * generated database-ID reference is required. The object keys below are only
 * typed source-code lookup conveniences and are not additional identities.
 */
export const BuiltInHostRoles = Object.freeze({
  member: makeBuiltInHostRole("host/member", "Member", [
    HostPermissions.host.read,
    HostPermissions.host.execute,
    HostPermissions.auth.read,
  ]),
  admin: makeBuiltInHostRole("host/admin", "Admin", [
    HostPermissions.host.read,
    HostPermissions.host.execute,
    HostPermissions.host.configure,
    HostPermissions.secrets.manage,
    HostPermissions.auth.read,
    HostPermissions.auth.manage,
    HostPermissions.tokens.manage,
  ]),
  owner: makeBuiltInHostRole("host/owner", "Owner", [
    HostPermissions.host.read,
    HostPermissions.host.execute,
    HostPermissions.host.configure,
    HostPermissions.host.delete,
    HostPermissions.secrets.manage,
    HostPermissions.auth.read,
    HostPermissions.auth.manage,
    HostPermissions.tokens.manage,
    HostPermissions.members.manage,
  ]),
});
