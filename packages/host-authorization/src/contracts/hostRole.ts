import { Brand, Schema } from "effect";
import {
  hasUniqueCanonicalPermissions,
  hasUniqueValues,
} from "../internal/hostAccessSchemaChecks.js";
import { HostPermission } from "./hostPermission.js";

/**
 * Stable application identity for one Host role.
 *
 * The runtime value is a canonical UUID string. Package-owned roles use
 * deterministic UUIDv5 values while future custom roles use generated UUIDv4 values;
 * both cross stores, APIs, and assignments through this one identity. The
 * brand prevents an ordinary string or Control Plane role ID from being used
 * accidentally where a Host role ID is required.
 *
 * A platform must preserve a unique one-to-one mapping for this value but may
 * store it as text, native UUID data, or 16 RFC-ordered bytes. It may also keep
 * an unrelated surrogate row primary key privately.
 */
export const HostRoleId = Schema.String.pipe(
  Schema.check(Schema.isUUID()),
  Schema.check(Schema.isLowercased()),
  Schema.brand("HostRoleId"),
);
export type HostRoleId = Schema.Schema.Type<typeof HostRoleId>;

/**
 * Runs only when a `HostRole` is constructed or decoded — not when rows are
 * written. Prefer storing permissions in `HostPermission` catalog order; if
 * not, canonicalize before `HostRole.make` / decode (do not rely on auto-sort).
 */
const canonicalRolePermissions = Schema.makeFilter(
  ({ permissions }: { readonly permissions: ReadonlyArray<HostPermission> }) =>
    hasUniqueCanonicalPermissions(permissions),
  { expected: "unique permissions in HostPermission catalog order" },
);

/**
 * Platform-neutral Host role returned by stores and role APIs.
 *
 * `roleId` is the immutable application UUID used by assignments and catalog
 * migrations; it does not prescribe the database primary key. `name` is only a
 * renameable display label, and authorization evaluates `permissions` rather
 * than either identity or label. Branding rejects same-shaped plain objects,
 * while schema checks prevent adapters from publishing malformed state.
 */
export class HostRole extends Schema.Class<HostRole, Brand.Brand<"HostRole">>(
  "HostRole",
)(
  Schema.Struct({
    roleId: HostRoleId,
    name: Schema.NonEmptyString,
    permissions: Schema.NonEmptyArray(HostPermission),
  }).pipe(Schema.check(canonicalRolePermissions)),
) {}

const uniqueHostRoleIds = Schema.makeFilter(
  (values: ReadonlyArray<HostRoleId>) => hasUniqueValues(values),
  { expected: "unique host role IDs" },
);

/** Complete non-empty unique Host-role selection for a membership write. */
export const HostRoleIdSelection = Schema.NonEmptyArray(HostRoleId).pipe(
  Schema.check(uniqueHostRoleIds),
);
export type HostRoleIdSelection = Schema.Schema.Type<
  typeof HostRoleIdSelection
>;
