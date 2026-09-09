import { deriveBuiltInRoleId } from "../internal/builtInRoleId.js";
import {
  ControlPlanePermission,
  type ControlPlanePermission as ControlPlanePermissionValue,
} from "./controlPlanePermission.js";
import { ControlPlaneRole, ControlPlaneRoleId } from "./controlPlaneRole.js";

/**
 * Current version of the package-authored Control Plane role catalog.
 *
 * This number versions catalog contents, not the UUID syntax or UUIDv5
 * namespace. Platforms persist the applied version in migration metadata and
 * advance it atomically with every future catalog transition.
 */
export const BuiltInControlPlaneRoleDefinitionVersion = 1;

/**
 * Package-owned Control Plane roles installed during initial claim.
 *
 * The Administrator `roleId` is a UUIDv5 derived from the permanent ptools role
 * namespace and the immutable canonical name
 * `control-plane/administrator`. That canonical name is identity material and
 * must never be renamed or reused; the displayed `name` may change without
 * changing assignments or last-Administrator checks.
 *
 * Platforms insert this exact logical ID and may map it to any private row
 * representation. Assignments and future catalog migrations use the UUID
 * directly, so no seed key, binding table, or generated database-ID reference
 * is required. The object key is only a source-code lookup convenience.
 */
export const BuiltInControlPlaneRoles = Object.freeze({
  administrator: Object.freeze(
    ControlPlaneRole.make({
      roleId: ControlPlaneRoleId.make(
        deriveBuiltInRoleId("control-plane/administrator"),
      ),
      name: "Administrator",
      permissions: Object.freeze([
        ...ControlPlanePermission.literals,
      ]) as readonly [
        ControlPlanePermissionValue,
        ...ReadonlyArray<ControlPlanePermissionValue>,
      ],
    }),
  ),
});
