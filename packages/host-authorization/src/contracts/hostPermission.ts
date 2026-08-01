import { Schema } from "effect";
import { definePermissions } from "../internal/definePermissions.js";

const hostPermissionDefinition = definePermissions({
  host: ["read", "execute", "configure", "delete"],
  secrets: ["manage"],
  auth: ["read", "manage"],
  tokens: ["manage"],
  members: ["manage"],
} as const);

/** Complete schema for permission identifiers understood by host policies. */
export const HostPermission = Schema.Literals(
  hostPermissionDefinition.values,
);
export type HostPermission = Schema.Schema.Type<typeof HostPermission>;

/** Typed permission values used by policies and later role definitions. */
export const HostPermissions = hostPermissionDefinition.catalog;
