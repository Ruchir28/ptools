/**
 * @file Node SQLite implementation of shared Control Plane authority storage.
 *
 * This adapter owns Principal registration, setup/claim state, global roles,
 * and assignments. Multi-step laws execute in Drizzle Effect transactions over
 * the single `NodeControlPlaneDrizzle` connection.
 */
import {
  BuiltInControlPlaneRoles,
  ClaimInitialAdministratorRecordInput,
  ControlPlaneAccessInvariantViolation,
  ControlPlaneAccessStoreError,
  ControlPlaneClaimRejected,
  ControlPlaneClaimStatus,
  ControlPlanePermission,
  ControlPlaneRoleId,
  ControlPlaneRolesNotFound,
  InitializeControlPlaneInput,
  LastControlPlaneAdministrator,
  Principal,
  PrincipalControlPlaneAccess,
  type ControlPlaneAccessOperation,
  type PrincipalId,
  type ReplacePrincipalControlPlaneRolesInput,
  type ResolvePrincipalControlPlaneAccessInput,
} from "@ptools/host-authorization";
import { ControlPlaneAccessStore } from "@ptools/host-authorization/effect";
import { eq, inArray } from "drizzle-orm";
import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core/errors";
import type { EffectSQLiteNodeDatabase } from "drizzle-orm/effect-sqlite-node";
import { Clock, Effect, Layer, Schema } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { NodeControlPlaneDrizzle } from "../../services/nodeControlPlaneDrizzle.js";
import { installInitialAuthorizationCatalog } from "../persistence/nodeAuthorizationCatalogPersistence.js";
import { ControlPlaneClaimRowSelectSchema } from "../persistence/nodeControlPlanePersistedSchemas.js";
import {
  controlPlaneClaimTable,
  controlPlaneRolePermissionTable,
  controlPlaneRoleTable,
  principalControlPlaneRoleTable,
  principalTable,
} from "../persistence/nodeControlPlaneSqliteSchema.js";

/**
 * Durable Node implementation of the shared `ControlPlaneAccessStore` port.
 * The control-plane composition constructs it after acquiring deployment
 * ownership and supplies the one scoped `NodeControlPlaneDrizzle`; shared
 * bootstrap, administration, and authorization services consume only the port.
 * Setup plaintext and request credentials never cross this persistence layer.
 *
 * Catalog health is proven once at startup by
 * `NodeAuthorizationCatalogStartupProbeLive`, not on the request path: these
 * operations strictly decode the rows they use, and the probe owns the full
 * dormant-row equality check.
 */
export const NodeControlPlaneAccessStoreLive: Layer.Layer<
  ControlPlaneAccessStore,
  never,
  NodeControlPlaneDrizzle
> = Layer.effect(
  ControlPlaneAccessStore,
  Effect.gen(function* () {
    const { database } = yield* NodeControlPlaneDrizzle;

    return ControlPlaneAccessStore.of({
      initialize: (input) => initialize(database, input),
      ensurePrincipal: (principal) => ensurePrincipal(database, principal),
      getClaimStatus: () => getClaimStatus(database),
      claimInitialAdministrator: (input) =>
        claimInitialAdministrator(database, input),
      resolvePermissions: (input) => resolvePermissions(database, input),
      replaceRoles: (input) => replaceRoles(database, input),
    });
  }),
);

const initialize = (
  database: EffectSQLiteNodeDatabase,
  input: InitializeControlPlaneInput,
) =>
  database
    .transaction((tx) =>
      Effect.gen(function* () {
        const existing = yield* tx.select().from(controlPlaneClaimTable);
        if (existing.length > 1) {
          return yield* invariant("initialize", "multiple claim rows exist");
        }
        if (existing.length === 1) {
          yield* oneClaimRow(tx, "initialize");
          return false;
        }
        yield* tx.insert(controlPlaneClaimTable).values({
          claimId: 1,
          setupCapabilityHash: input.setupCapabilityHash,
        });
        return true;
      }),
    )
    .pipe(mapStoreError("initialize"));

const ensurePrincipal = (
  database: EffectSQLiteNodeDatabase,
  principal: Principal,
) =>
  Effect.gen(function* () {
    yield* oneClaimRow(database, "ensurePrincipal");
    const createdAtEpochMs = yield* Clock.currentTimeMillis;
    yield* database
      .insert(principalTable)
      .values({
        principalId: principal.principalId,
        createdAtEpochMs,
      })
      .onConflictDoNothing({ target: principalTable.principalId });
    return Principal.make({ principalId: principal.principalId });
  }).pipe(mapStoreError("ensurePrincipal"));

const getClaimStatus = (database: EffectSQLiteNodeDatabase) =>
  Effect.gen(function* () {
    const row = yield* oneClaimRow(database, "getClaimStatus");
    if (
      row.initialAdministratorId === null &&
      row.claimedAtEpochMs === null &&
      row.setupCapabilityHash !== null
    ) {
      return ControlPlaneClaimStatus.make({ _tag: "Unclaimed" });
    }
    if (
      row.initialAdministratorId !== null &&
      row.claimedAtEpochMs !== null &&
      row.setupCapabilityHash === null
    ) {
      return yield* Schema.decodeUnknownEffect(ControlPlaneClaimStatus)({
        _tag: "Claimed",
        initialAdministratorId: row.initialAdministratorId,
        claimedAtEpochMs: row.claimedAtEpochMs,
      }).pipe(
        Effect.mapError(() =>
          invariant(
            "getClaimStatus",
            "claim row contains invalid identity or time",
          ),
        ),
      );
    }
    return yield* invariant(
      "getClaimStatus",
      "claim row contains contradictory lifecycle fields",
    );
  }).pipe(mapStoreError("getClaimStatus"));

const claimInitialAdministrator = (
  database: EffectSQLiteNodeDatabase,
  input: ClaimInitialAdministratorRecordInput,
) =>
  database
    .transaction((tx) =>
      Effect.gen(function* () {
        const row = yield* oneClaimRow(tx, "claimInitialAdministrator");
        if (
          row.initialAdministratorId !== null ||
          row.claimedAtEpochMs !== null ||
          row.setupCapabilityHash !== input.setupCapabilityHash
        ) {
          return yield* new ControlPlaneClaimRejected({
            message: "Control Plane setup capability was rejected",
          });
        }

        yield* tx
          .insert(principalTable)
          .values({
            principalId: input.principalId,
            createdAtEpochMs: input.claimedAtEpochMs,
          })
          .onConflictDoNothing({ target: principalTable.principalId });
        yield* installInitialAuthorizationCatalog(tx);
        yield* tx.insert(principalControlPlaneRoleTable).values({
          principalId: input.principalId,
          roleId: BuiltInControlPlaneRoles.administrator.roleId,
        });
        yield* tx
          .update(controlPlaneClaimTable)
          .set({
            setupCapabilityHash: null,
            initialAdministratorId: input.principalId,
            claimedAtEpochMs: input.claimedAtEpochMs,
          })
          .where(eq(controlPlaneClaimTable.claimId, 1));

        return PrincipalControlPlaneAccess.make({
          principalId: input.principalId,
          effectivePermissions: [
            ...BuiltInControlPlaneRoles.administrator.permissions,
          ],
        });
      }),
    )
    .pipe(mapStoreError("claimInitialAdministrator"));

const resolvePermissions = (
  database: EffectSQLiteNodeDatabase,
  input: ResolvePrincipalControlPlaneAccessInput,
) =>
  resolvePermissionsFor(database, input.principalId, "resolvePermissions").pipe(
    mapStoreError("resolvePermissions"),
  );

const replaceRoles = (
  database: EffectSQLiteNodeDatabase,
  input: ReplacePrincipalControlPlaneRolesInput,
) =>
  database
    .transaction((tx) =>
      Effect.gen(function* () {
        const claim = yield* oneClaimRow(tx, "replaceRoles");
        if (claim.initialAdministratorId === null) {
          return yield* invariant(
            "replaceRoles",
            "Control Plane is not claimed",
          );
        }

        if (input.roleIds.length > 0) {
          const existingRoles = yield* tx
            .select({ roleId: controlPlaneRoleTable.roleId })
            .from(controlPlaneRoleTable)
            .where(inArray(controlPlaneRoleTable.roleId, input.roleIds));
          const found = new Set(existingRoles.map(({ roleId }) => roleId));
          const missing = input.roleIds.filter((roleId) => !found.has(roleId));
          if (missing.length > 0) {
            return yield* new ControlPlaneRolesNotFound({
              roleIds: missing,
              message: "one or more Control Plane roles do not exist",
            });
          }
        }

        const createdAtEpochMs = yield* Clock.currentTimeMillis;
        yield* tx
          .insert(principalTable)
          .values({
            principalId: input.principalId,
            createdAtEpochMs,
          })
          .onConflictDoNothing({ target: principalTable.principalId });
        yield* tx
          .delete(principalControlPlaneRoleTable)
          .where(
            eq(principalControlPlaneRoleTable.principalId, input.principalId),
          );
        if (input.roleIds.length > 0) {
          yield* tx.insert(principalControlPlaneRoleTable).values(
            input.roleIds.map((roleId) => ({
              principalId: input.principalId,
              roleId,
            })),
          );
        }

        const administrators = yield* tx
          .select({ principalId: principalControlPlaneRoleTable.principalId })
          .from(principalControlPlaneRoleTable)
          .where(
            eq(
              principalControlPlaneRoleTable.roleId,
              BuiltInControlPlaneRoles.administrator.roleId,
            ),
          )
          .limit(1);
        if (administrators.length === 0) {
          return yield* new LastControlPlaneAdministrator({
            message: "at least one Control Plane Administrator must remain",
          });
        }
        return yield* resolvePermissionsFor(
          tx,
          input.principalId,
          "replaceRoles",
        );
      }),
    )
    .pipe(mapStoreError("replaceRoles"));

const resolvePermissionsFor = (
  database: EffectSQLiteNodeDatabase,
  principalId: PrincipalId,
  operation: ControlPlaneAccessOperation,
) =>
  Effect.gen(function* () {
    const claim = yield* oneClaimRow(database, operation);
    if (claim.initialAdministratorId === null) {
      return PrincipalControlPlaneAccess.make({
        principalId,
        effectivePermissions: [],
      });
    }
    const rows = yield* database
      .select({
        roleId: principalControlPlaneRoleTable.roleId,
        permission: controlPlaneRolePermissionTable.permission,
      })
      .from(principalControlPlaneRoleTable)
      .leftJoin(
        controlPlaneRolePermissionTable,
        eq(
          principalControlPlaneRoleTable.roleId,
          controlPlaneRolePermissionTable.roleId,
        ),
      )
      .where(eq(principalControlPlaneRoleTable.principalId, principalId));
    const decoded = yield* Effect.forEach(rows, ({ roleId, permission }) =>
      permission === null
        ? Effect.fail(
            invariant(
              operation,
              "stored Control Plane role has no permissions",
            ),
          )
        : Effect.all([
            Schema.decodeUnknownEffect(ControlPlaneRoleId)(roleId),
            Schema.decodeUnknownEffect(ControlPlanePermission)(permission),
          ]).pipe(
            Effect.mapError(() =>
              invariant(operation, "stored role or permission is invalid"),
            ),
            Effect.map(([, decodedPermission]) => decodedPermission),
          ),
    );
    const present = new Set(decoded);
    return PrincipalControlPlaneAccess.make({
      principalId,
      effectivePermissions: ControlPlanePermission.literals.filter(
        (permission) => present.has(permission),
      ),
    });
  });

/**
 * `NodeAuthorizationCatalogStartupProbeLive` (defined in
 * `nodeAuthorizationStores.ts`) performs the one full-catalog scan at
 * control-plane startup. It is re-exported here so composition owns exactly
 * one startup-probe construction site.
 */
export { NodeAuthorizationCatalogStartupProbeLive } from "./nodeAuthorizationStores.js";

const oneClaimRow = (
  database: EffectSQLiteNodeDatabase,
  operation: ControlPlaneAccessOperation,
) =>
  Effect.gen(function* () {
    const rows = yield* database
      .select()
      .from(controlPlaneClaimTable)
      .where(eq(controlPlaneClaimTable.claimId, 1));
    if (rows.length !== 1) {
      return yield* invariant(operation, "Control Plane is not initialized");
    }
    const row = yield* Schema.decodeUnknownEffect(
      ControlPlaneClaimRowSelectSchema,
    )(rows[0]).pipe(
      Effect.mapError(() =>
        invariant(operation, "stored Control Plane claim row is invalid"),
      ),
    );
    const unclaimed =
      row.initialAdministratorId === null &&
      row.claimedAtEpochMs === null &&
      row.setupCapabilityHash !== null;
    const claimed =
      row.initialAdministratorId !== null &&
      row.claimedAtEpochMs !== null &&
      row.setupCapabilityHash === null;
    if (!unclaimed && !claimed) {
      return yield* invariant(
        operation,
        "stored Control Plane claim lifecycle is contradictory",
      );
    }
    return row;
  });

const invariant = (operation: ControlPlaneAccessOperation, message: string) =>
  new ControlPlaneAccessInvariantViolation({ operation, message });

const mapStoreError =
  (operation: ControlPlaneAccessOperation) =>
  <A, E extends { readonly _tag: string }, R>(
    effect: Effect.Effect<A, E | SqlError | EffectDrizzleQueryError, R>,
  ) => {
    const storeFailure = () =>
      Effect.fail(
        new ControlPlaneAccessStoreError({
          operation,
          message: "Control Plane persistence operation failed",
        }),
      );
    const withoutSqlError = Effect.catchTag(effect, "SqlError", storeFailure);
    return Effect.catchTag(
      withoutSqlError,
      "EffectDrizzleQueryError",
      storeFailure,
    );
  };
