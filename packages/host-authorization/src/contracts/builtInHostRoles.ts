import { HostPermissions, type HostPermission } from "./hostPermission.js";
import { HostRole, HostRoleKey } from "./hostRole.js";

/** Version consumed by platform-owned migrations of the built-in role catalog. */
export const BuiltInHostRoleDefinitionVersion = 1;

const makeBuiltInHostRole = (
  roleKey: string,
  name: string,
  permissions: readonly [HostPermission, ...ReadonlyArray<HostPermission>],
): HostRole =>
  Object.freeze(
    HostRole.make({
      roleKey: HostRoleKey.make(roleKey),
      name,
      permissions: Object.freeze([...permissions]) as readonly [
        HostPermission,
        ...ReadonlyArray<HostPermission>,
      ],
    }),
  );

/**
 * Package-authored roles installed by each platform's migration protocol.
 *
 * These are normal branded `HostRole` values (already schema-validated at
 * module load). Object keys only provide typed lookup. Platforms persist them
 * in any private representation; later `listHostRoles` / `getHostRole` must
 * return current decoded definitions, not necessarily these object identities.
 */
export const BuiltInHostRoles = Object.freeze({
  member: makeBuiltInHostRole("member", "Member", [
    HostPermissions.host.read,
    HostPermissions.host.execute,
    HostPermissions.auth.read,
  ]),
  admin: makeBuiltInHostRole("admin", "Admin", [
    HostPermissions.host.read,
    HostPermissions.host.execute,
    HostPermissions.host.configure,
    HostPermissions.secrets.manage,
    HostPermissions.auth.read,
    HostPermissions.auth.manage,
    HostPermissions.tokens.manage,
  ]),
  owner: makeBuiltInHostRole("owner", "Owner", [
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
