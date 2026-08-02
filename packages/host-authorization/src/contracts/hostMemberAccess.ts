import { Brand, Schema } from "effect";
import { hasUniqueCanonicalPermissions } from "../internal/hostAccessSchemaChecks.js";
import { HostPermission } from "./hostPermission.js";

/**
 * Runs when `HostMemberAccess` is constructed/decoded. Platforms union role
 * permissions from private assignment data, then pass a catalog-ordered unique
 * list into `.make` / `.makeEffect`. Prefer materializing unions already in
 * catalog order at the platform edge.
 */
const canonicalEffectivePermissions = Schema.makeFilter(
  ({
    effectivePermissions,
  }: {
    readonly effectivePermissions: ReadonlyArray<
      Schema.Schema.Type<typeof HostPermission>
    >;
  }) => hasUniqueCanonicalPermissions(effectivePermissions),
  { expected: "unique permissions in HostPermission catalog order" },
);

/**
 * Current effective human permissions for one user on one registered host.
 *
 * This is the shared authorization aggregate: policies see permissions only,
 * not role names, assignment rows, or join tables. Branding forces construction
 * through the schema so a hand-built plain object from SQL/KV cannot typecheck
 * as `HostMemberAccess`.
 */
export class HostMemberAccess extends Schema.Class<
  HostMemberAccess,
  Brand.Brand<"HostMemberAccess">
>("HostMemberAccess")(
  Schema.Struct({
    hostId: Schema.NonEmptyString,
    userId: Schema.NonEmptyString,
    effectivePermissions: Schema.NonEmptyArray(HostPermission),
  }).pipe(Schema.check(canonicalEffectivePermissions)),
) {}
