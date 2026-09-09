import { Schema } from "effect";
import { definePermissions } from "../internal/definePermissions.js";

const controlPlanePermissionDefinition = definePermissions(
  {
    hosts: ["create", "list", "administer"],
    access: ["manage"],
  } as const,
  { namespace: "control-plane" },
);

/**
 * Exhaustive wire and persistence schema for permissions that apply across the
 * entire ptools Control Plane rather than to one Host.
 *
 * Platform adapters decode stored or externally supplied permission strings
 * with this schema. Authorization services then work with the resulting closed
 * `ControlPlanePermission` union, so unknown permission names fail instead of
 * silently granting or discarding authority.
 */
export const ControlPlanePermission = Schema.Literals(
  controlPlanePermissionDefinition.values,
);
export type ControlPlanePermission = Schema.Schema.Type<
  typeof ControlPlanePermission
>;

/**
 * Canonical Control Plane permission values used to author roles and policies.
 *
 * This catalog and `ControlPlanePermission` are derived from the same private
 * declaration, just like `HostPermissions` and `HostPermission`. Consumers use
 * expressions such as `ControlPlanePermissions.hosts.create` instead of
 * repeating serialized strings. The catalog contains no runtime grants or
 * mutable Control Plane state; persisted role assignments determine authority.
 */
export const ControlPlanePermissions = controlPlanePermissionDefinition.catalog;
