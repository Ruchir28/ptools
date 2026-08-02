import { Brand, Schema } from "effect";
import {
  hasUniqueCanonicalPermissions,
  hasUniqueValues,
} from "../internal/hostAccessSchemaChecks.js";
import { HostPermission } from "./hostPermission.js";

/**
 * Stable application identity for a role; never a database primary key.
 *
 * Platforms may keep surrogate IDs privately. Anything crossing
 * `HostAccessStore` uses this application key (`member`, `admin`, …).
 */
export const HostRoleKey = Schema.NonEmptyString.pipe(
  Schema.brand("HostRoleKey"),
);
export type HostRoleKey = Schema.Schema.Type<typeof HostRoleKey>;

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
 * Platform-neutral role definition returned by stores and role APIs.
 *
 * Branding rejects same-shaped plain objects. Schema checks run at `.make` /
 * `.makeEffect` / decode time so callers cannot bypass validation by assembling
 * a structural object from DB fields.
 */
export class HostRole extends Schema.Class<HostRole, Brand.Brand<"HostRole">>(
  "HostRole",
)(
  Schema.Struct({
    roleKey: HostRoleKey,
    name: Schema.NonEmptyString,
    permissions: Schema.NonEmptyArray(HostPermission),
  }).pipe(Schema.check(canonicalRolePermissions)),
) {}

const uniqueHostRoleKeys = Schema.makeFilter(
  (values: ReadonlyArray<HostRoleKey>) => hasUniqueValues(values),
  { expected: "unique host role keys" },
);

/**
 * Complete non-empty unique role selection for a membership write.
 *
 * Rejects duplicate keys at input construction; does not silently dedupe.
 * Selection order has no authorization meaning.
 */
export const HostRoleKeySelection = Schema.NonEmptyArray(HostRoleKey).pipe(
  Schema.check(uniqueHostRoleKeys),
);
export type HostRoleKeySelection = Schema.Schema.Type<
  typeof HostRoleKeySelection
>;
