/**
 * @file Node-owned authorization catalog lifecycle: initialization-only
 * package-authored role installation plus a startup-only health probe.
 *
 * Shared packages own role identities, names, permissions, and catalog
 * versions. Installation writes those exact values into SQLite inside the
 * caller's first-claim transaction; the startup probe later re-proves that a
 * claimed database still carries exactly this binary's catalog. Neither is an
 * Effect request-path service, and the probe must not run per request.
 */
import {
  BuiltInControlPlaneRoleDefinitionVersion,
  BuiltInControlPlaneRoles,
  BuiltInHostRoleDefinitionVersion,
  BuiltInHostRoles,
  ControlPlaneAccessInvariantViolation,
} from "@ptools/host-authorization";
import type {
  EffectSQLiteNodeQueryEffectHKT,
  EffectSQLiteNodeRunResult,
} from "drizzle-orm/effect-sqlite-node";
import type { EmptyRelations } from "drizzle-orm/relations";
import type { SQLiteEffectDatabase } from "drizzle-orm/sqlite-core/effect";
import { Data, Effect, Schema } from "effect";
import {
  AuthorizationCatalogStateRowSelectSchema,
  ControlPlaneRolePermissionRowSelectSchema,
  ControlPlaneRoleRowSelectSchema,
  HostRolePermissionRowSelectSchema,
  HostRoleRowSelectSchema,
} from "./nodeControlPlanePersistedSchemas.js";
import {
  authorizationCatalogStateTable,
  controlPlaneRolePermissionTable,
  controlPlaneRoleTable,
  hostRolePermissionTable,
  hostRoleTable,
} from "./nodeControlPlaneSqliteSchema.js";

type CatalogDatabase = SQLiteEffectDatabase<
  EffectSQLiteNodeQueryEffectHKT,
  EffectSQLiteNodeRunResult,
  EmptyRelations
>;

/** Internal contradiction between persisted and package-owned catalog state. */
export class NodeAuthorizationCatalogInvariant extends Data.TaggedError(
  "NodeAuthorizationCatalogInvariant",
)<{ readonly message: string }> {}

/**
 * Proves that claimed authority uses exactly the catalog versions and built-in
 * role definitions this binary understands. V1 has no transition runner, so
 * absent, older, newer, duplicate, or modified catalog state fails closed.
 */
export const requireCurrentAuthorizationCatalog = (database: CatalogDatabase) =>
  Effect.gen(function* () {
    const catalogState = yield* Schema.decodeUnknownEffect(
      Schema.Array(AuthorizationCatalogStateRowSelectSchema),
    )(yield* database.select().from(authorizationCatalogStateTable)).pipe(
      Effect.mapError(catalogDecodeFailure),
    );
    const controlPlaneRoles = yield* Schema.decodeUnknownEffect(
      Schema.Array(ControlPlaneRoleRowSelectSchema),
    )(yield* database.select().from(controlPlaneRoleTable)).pipe(
      Effect.mapError(catalogDecodeFailure),
    );
    const controlPlanePermissions = yield* Schema.decodeUnknownEffect(
      Schema.Array(ControlPlaneRolePermissionRowSelectSchema),
    )(yield* database.select().from(controlPlaneRolePermissionTable)).pipe(
      Effect.mapError(catalogDecodeFailure),
    );
    const hostRoles = yield* Schema.decodeUnknownEffect(
      Schema.Array(HostRoleRowSelectSchema),
    )(yield* database.select().from(hostRoleTable)).pipe(
      Effect.mapError(catalogDecodeFailure),
    );
    const hostPermissions = yield* Schema.decodeUnknownEffect(
      Schema.Array(HostRolePermissionRowSelectSchema),
    )(yield* database.select().from(hostRolePermissionTable)).pipe(
      Effect.mapError(catalogDecodeFailure),
    );

    if (
      catalogState.length !== 1 ||
      !catalogMatches(
        Object.values(BuiltInControlPlaneRoles),
        controlPlaneRoles,
        controlPlanePermissions,
      ) ||
      !catalogMatches(
        Object.values(BuiltInHostRoles),
        hostRoles,
        hostPermissions,
      )
    ) {
      return yield* new NodeAuthorizationCatalogInvariant({
        message: "authorization role catalog is unsupported or malformed",
      });
    }
  });

const catalogDecodeFailure = () =>
  new NodeAuthorizationCatalogInvariant({
    message: "authorization role catalog contains invalid values",
  });

/**
 * Verifies that every package-authored built-in role is present with its
 * exact identity and permission set.
 *
 * This is deliberately a subset check, not an equality check. Authorization
 * enforcement keys off stable built-in UUIDs, so the probe's job is to prove
 * those UUIDs still mean what this binary thinks they mean. Rows for other
 * role IDs — future custom roles — are ignored here: `replaceRoles` and
 * membership writes resolve selected UUIDs against the persisted catalog and
 * strictly decode their persisted permissions, so an unknown or malformed
 * grant fails the request that references it.
 */
const catalogMatches = (
  expectedRoles: ReadonlyArray<{
    readonly roleId: string;
    readonly name: string;
    readonly permissions: ReadonlyArray<string>;
  }>,
  storedRoles: ReadonlyArray<{
    readonly roleId: string;
    readonly name: string;
  }>,
  storedPermissions: ReadonlyArray<{
    readonly roleId: string;
    readonly permission: string;
  }>,
): boolean => {
  const roles = new Map(storedRoles.map((role) => [role.roleId, role.name]));
  const permissions = new Map<string, Set<string>>();
  for (const row of storedPermissions) {
    const current = permissions.get(row.roleId) ?? new Set<string>();
    current.add(row.permission);
    permissions.set(row.roleId, current);
  }
  return expectedRoles.every((expected) => {
    const actualPermissions = permissions.get(expected.roleId);
    return (
      roles.get(expected.roleId) === expected.name &&
      actualPermissions?.size === expected.permissions.length &&
      expected.permissions.every((permission) =>
        actualPermissions.has(permission),
      )
    );
  });
};

/**
 * Installs both V1 built-in role catalogs as part of initial claim.
 *
 * The caller owns the surrounding Drizzle transaction. Any pre-existing
 * catalog row is contradictory during a fresh claim and fails before inserts;
 * retries after a committed claim are rejected by claim state instead of
 * treating this helper as an upsert.
 */
export const installInitialAuthorizationCatalog = (database: CatalogDatabase) =>
  Effect.gen(function* () {
    // Keep transaction work sequential on the one SQLite connection. These
    // reads prove this is a genuinely fresh catalog rather than treating a
    // partial installation as an idempotent seed.
    const catalogState = yield* database
      .select({ catalogStateId: authorizationCatalogStateTable.catalogStateId })
      .from(authorizationCatalogStateTable)
      .limit(1);
    const controlPlaneRoles = yield* database
      .select({ roleId: controlPlaneRoleTable.roleId })
      .from(controlPlaneRoleTable)
      .limit(1);
    const hostRoles = yield* database
      .select({ roleId: hostRoleTable.roleId })
      .from(hostRoleTable)
      .limit(1);
    const controlPlanePermissions = yield* database
      .select({ roleId: controlPlaneRolePermissionTable.roleId })
      .from(controlPlaneRolePermissionTable)
      .limit(1);
    const hostPermissions = yield* database
      .select({ roleId: hostRolePermissionTable.roleId })
      .from(hostRolePermissionTable)
      .limit(1);
    if (
      catalogState.length !== 0 ||
      controlPlaneRoles.length !== 0 ||
      hostRoles.length !== 0 ||
      controlPlanePermissions.length !== 0 ||
      hostPermissions.length !== 0
    ) {
      return yield* new ControlPlaneAccessInvariantViolation({
        operation: "claimInitialAdministrator",
        message: "authorization catalog existed before initial claim",
      });
    }

    const controlPlaneCatalog = Object.values(BuiltInControlPlaneRoles);
    const hostCatalog = Object.values(BuiltInHostRoles);

    yield* database.insert(controlPlaneRoleTable).values(
      controlPlaneCatalog.map((role) => ({
        roleId: role.roleId,
        name: role.name,
      })),
    );
    yield* database.insert(controlPlaneRolePermissionTable).values(
      controlPlaneCatalog.flatMap((role) =>
        role.permissions.map((permission) => ({
          roleId: role.roleId,
          permission,
        })),
      ),
    );
    yield* database
      .insert(hostRoleTable)
      .values(
        hostCatalog.map((role) => ({ roleId: role.roleId, name: role.name })),
      );
    yield* database.insert(hostRolePermissionTable).values(
      hostCatalog.flatMap((role) =>
        role.permissions.map((permission) => ({
          roleId: role.roleId,
          permission,
        })),
      ),
    );
    yield* database.insert(authorizationCatalogStateTable).values({
      catalogStateId: 1,
      controlPlaneRoleVersion: BuiltInControlPlaneRoleDefinitionVersion,
      hostRoleVersion: BuiltInHostRoleDefinitionVersion,
    });
  });
