/**
 * @file Node SQLite implementation of registered-Host and membership storage.
 *
 * This adapter owns registration, membership, and Host-role assignment laws;
 * it neither discovers actor daemons nor decides authorization policy. Shared
 * authorization consumes its strictly decoded domain projections before any
 * platform discovery occurs.
 */
import {
  BuiltInHostRoles,
  CreatedOwnedHost,
  HostAccessInvariantViolation,
  HostAccessStoreError,
  HostMemberAccess,
  HostMembershipAlreadyExists,
  HostMembershipNotFound,
  HostPermission,
  HostRole,
  HostRoleId,
  HostRoleNotFound,
  HostRolePagination,
  HostRolesNotFound,
  RegisteredHost,
  RegisteredHostAlreadyExists,
  RegisteredHostNotFound,
  RegisteredHostPagination,
  type CreateHostMembershipInput,
  type CreateOwnedHostInput,
  type GetHostRoleInput,
  type GetRegisteredHostInput,
  type HostAccessStoreOperation,
  type ListHostRolesInput,
  type ListPrincipalHostsInput,
  type ListRegisteredHostsInput,
  type ReplaceMembershipRolesInput,
  type ResolvePrincipalHostAccessInput,
} from "@ptools/host-authorization";
import { HostAccessStore } from "@ptools/host-authorization/effect";
import { and, asc, eq, gt, inArray } from "drizzle-orm";
import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core/errors";
import type { EffectSQLiteNodeDatabase } from "drizzle-orm/effect-sqlite-node";
import { Clock, Effect, Layer, Option, Schema } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { NodeControlPlaneDrizzle } from "../../services/nodeControlPlaneDrizzle.js";
import {
  hostRolePermissionTable,
  hostRoleTable,
  principalHostMembershipTable,
  principalHostRoleTable,
  registeredHostTable,
} from "../persistence/nodeControlPlaneSqliteSchema.js";

/**
 * Durable Node implementation of the complete shared `HostAccessStore` port.
 * The control-plane owner supplies one scoped `NodeControlPlaneDrizzle`, and
 * shared authorization/admission code receives only this platform-neutral port.
 */
export const NodeHostAccessStoreLive: Layer.Layer<
  HostAccessStore,
  never,
  NodeControlPlaneDrizzle
> = Layer.effect(
  HostAccessStore,
  Effect.gen(function* () {
    const { database } = yield* NodeControlPlaneDrizzle;
    return HostAccessStore.of({
      getRegisteredHost: (input) => getRegisteredHost(database, input),
      createOwnedHost: (input) => createOwnedHost(database, input),
      listPrincipalHosts: (input) => listPrincipalHosts(database, input),
      listRegisteredHosts: (input) => listRegisteredHosts(database, input),
      resolvePrincipalHostAccess: (input) => resolveAccess(database, input),
      createMembership: (input) => createMembership(database, input),
      replaceMembershipRoles: (input) =>
        replaceMembershipRoles(database, input),
      getHostRole: (input) => getHostRole(database, input),
      listHostRoles: (input) => listHostRoles(database, input),
    });
  }),
);

const getRegisteredHost = (
  db: EffectSQLiteNodeDatabase,
  input: GetRegisteredHostInput,
) =>
  getRegisteredHostById(db, input.hostId, "getRegisteredHost").pipe(
    mapStoreError("getRegisteredHost"),
  );

const createOwnedHost = (
  db: EffectSQLiteNodeDatabase,
  input: CreateOwnedHostInput,
) =>
  db
    .transaction((tx) =>
      Effect.gen(function* () {
        const existing = yield* tx
          .select({ hostId: registeredHostTable.hostId })
          .from(registeredHostTable)
          .where(eq(registeredHostTable.hostId, input.requestedHostId));
        if (existing.length > 0) {
          return yield* new RegisteredHostAlreadyExists({
            hostId: input.requestedHostId,
            message: "registered Host already exists",
          });
        }
        yield* requireRoleIds(
          tx,
          [BuiltInHostRoles.owner.roleId],
          "createOwnedHost",
        ).pipe(
          Effect.catchTag("HostRolesNotFound", () =>
            Effect.fail(
              invariant(
                "createOwnedHost",
                "built-in Owner role is not installed",
              ),
            ),
          ),
        );
        const createdAtEpochMs = yield* Clock.currentTimeMillis;
        yield* tx.insert(registeredHostTable).values({
          hostId: input.requestedHostId,
          createdAtEpochMs,
        });
        yield* tx.insert(principalHostMembershipTable).values({
          hostId: input.requestedHostId,
          principalId: input.ownerPrincipalId,
          createdAtEpochMs,
        });
        yield* tx.insert(principalHostRoleTable).values({
          hostId: input.requestedHostId,
          principalId: input.ownerPrincipalId,
          roleId: BuiltInHostRoles.owner.roleId,
        });
        const ownerAccess = yield* resolveAccessFor(
          tx,
          input.requestedHostId,
          input.ownerPrincipalId,
          "createOwnedHost",
        ).pipe(
          Effect.catchTags({
            RegisteredHostNotFound: () =>
              Effect.fail(
                invariant(
                  "createOwnedHost",
                  "new Host was not visible inside its transaction",
                ),
              ),
            HostMembershipNotFound: () =>
              Effect.fail(
                invariant(
                  "createOwnedHost",
                  "new Owner membership was not visible inside its transaction",
                ),
              ),
          }),
        );
        return CreatedOwnedHost.make({
          host: RegisteredHost.make({
            hostId: input.requestedHostId,
            createdAtEpochMs,
          }),
          ownerAccess,
        });
      }),
    )
    .pipe(mapStoreError("createOwnedHost"));

const listPrincipalHosts = (
  db: EffectSQLiteNodeDatabase,
  input: ListPrincipalHostsInput,
) =>
  Effect.gen(function* () {
    const afterHostId = Option.getOrUndefined(
      Option.map(input.cursor, (cursor) =>
        RegisteredHostPagination.decodeCursor(cursor).hostId,
      ),
    );
    // Membership-driven sparse traversal: filter the caller's Principal
    // first, seek the (principalId, hostId) index with `hostId > :cursor`,
    // and join each membership row to its registered Host by primary key.
    // Inaccessible Hosts are never scanned or counted toward `limit + 1`;
    // the extra sentinel row only detects a continuation cursor.
    const rows = yield* db
      .select({
        hostId: registeredHostTable.hostId,
        createdAtEpochMs: registeredHostTable.createdAtEpochMs,
      })
      .from(principalHostMembershipTable)
      .innerJoin(
        registeredHostTable,
        eq(
          principalHostMembershipTable.hostId,
          registeredHostTable.hostId,
        ),
      )
      .where(
        and(
          eq(principalHostMembershipTable.principalId, input.principalId),
          afterHostId === undefined
            ? undefined
            : gt(principalHostMembershipTable.hostId, afterHostId),
        ),
      )
      .orderBy(asc(principalHostMembershipTable.hostId))
      .limit(input.limit + 1);
    return yield* makeRegisteredHostPage(
      rows,
      input.limit,
      "listPrincipalHosts",
    );
  }).pipe(mapStoreError("listPrincipalHosts"));

const listRegisteredHosts = (
  db: EffectSQLiteNodeDatabase,
  input: ListRegisteredHostsInput,
) =>
  Effect.gen(function* () {
    const afterHostId = Option.getOrUndefined(
      Option.map(input.cursor, (cursor) =>
        RegisteredHostPagination.decodeCursor(cursor).hostId,
      ),
    );
    // Global traversal orders by the unique `host_id` primary key and seeks
    // with `hostId > :cursor`, so the primary-key index serves the ordered
    // scan directly. `createdAtEpochMs` is decoded into each response item
    // but never participates in ordering or seeking.
    const rows = yield* db
      .select()
      .from(registeredHostTable)
      .where(
        afterHostId === undefined
          ? undefined
          : gt(registeredHostTable.hostId, afterHostId),
      )
      .orderBy(asc(registeredHostTable.hostId))
      .limit(input.limit + 1);
    return yield* makeRegisteredHostPage(
      rows,
      input.limit,
      "listRegisteredHosts",
    );
  }).pipe(mapStoreError("listRegisteredHosts"));

const resolveAccess = (
  db: EffectSQLiteNodeDatabase,
  input: ResolvePrincipalHostAccessInput,
) =>
  resolveAccessFor(
    db,
    input.hostId,
    input.principalId,
    "resolvePrincipalHostAccess",
  ).pipe(mapStoreError("resolvePrincipalHostAccess"));

const createMembership = (
  db: EffectSQLiteNodeDatabase,
  input: CreateHostMembershipInput,
) =>
  db
    .transaction((tx) =>
      Effect.gen(function* () {
        yield* getRegisteredHostById(tx, input.hostId, "createMembership");
        yield* requireRoleIds(tx, input.roleIds, "createMembership");
        const existing = yield* tx
          .select({ hostId: principalHostMembershipTable.hostId })
          .from(principalHostMembershipTable)
          .where(
            and(
              eq(principalHostMembershipTable.hostId, input.hostId),
              eq(principalHostMembershipTable.principalId, input.principalId),
            ),
          );
        if (existing.length > 0) {
          return yield* new HostMembershipAlreadyExists({
            hostId: input.hostId,
            principalId: input.principalId,
            message: "Host membership already exists",
          });
        }
        const createdAtEpochMs = yield* Clock.currentTimeMillis;
        yield* tx.insert(principalHostMembershipTable).values({
          hostId: input.hostId,
          principalId: input.principalId,
          createdAtEpochMs,
        });
        yield* tx.insert(principalHostRoleTable).values(
          input.roleIds.map((roleId) => ({
            hostId: input.hostId,
            principalId: input.principalId,
            roleId,
          })),
        );
        return yield* resolveAccessFor(
          tx,
          input.hostId,
          input.principalId,
          "createMembership",
        ).pipe(
          Effect.catchTag("HostMembershipNotFound", () =>
            Effect.fail(
              invariant(
                "createMembership",
                "new membership was not visible inside its transaction",
              ),
            ),
          ),
        );
      }),
    )
    .pipe(mapStoreError("createMembership"));

const replaceMembershipRoles = (
  db: EffectSQLiteNodeDatabase,
  input: ReplaceMembershipRolesInput,
) =>
  db
    .transaction((tx) =>
      Effect.gen(function* () {
        yield* getRegisteredHostById(
          tx,
          input.hostId,
          "replaceMembershipRoles",
        );
        yield* requireRoleIds(tx, input.roleIds, "replaceMembershipRoles");
        const membership = yield* tx
          .select({ hostId: principalHostMembershipTable.hostId })
          .from(principalHostMembershipTable)
          .where(
            and(
              eq(principalHostMembershipTable.hostId, input.hostId),
              eq(principalHostMembershipTable.principalId, input.principalId),
            ),
          );
        if (membership.length === 0) {
          return yield* new HostMembershipNotFound({
            hostId: input.hostId,
            principalId: input.principalId,
            message: "Host membership does not exist",
          });
        }
        yield* tx
          .delete(principalHostRoleTable)
          .where(
            and(
              eq(principalHostRoleTable.hostId, input.hostId),
              eq(principalHostRoleTable.principalId, input.principalId),
            ),
          );
        yield* tx.insert(principalHostRoleTable).values(
          input.roleIds.map((roleId) => ({
            hostId: input.hostId,
            principalId: input.principalId,
            roleId,
          })),
        );
        return yield* resolveAccessFor(
          tx,
          input.hostId,
          input.principalId,
          "replaceMembershipRoles",
        );
      }),
    )
    .pipe(mapStoreError("replaceMembershipRoles"));

const getHostRole = (db: EffectSQLiteNodeDatabase, input: GetHostRoleInput) =>
  Effect.gen(function* () {
    const roles = yield* loadRoles(db, "getHostRole", input.roleId);
    if (roles.length === 0) {
      return yield* new HostRoleNotFound({
        roleId: input.roleId,
        message: "Host role does not exist",
      });
    }
    if (roles.length !== 1) {
      return yield* invariant("getHostRole", "duplicate Host role identity");
    }
    return roles[0]!;
  }).pipe(mapStoreError("getHostRole"));

const listHostRoles = (
  db: EffectSQLiteNodeDatabase,
  input: ListHostRolesInput,
) =>
  Effect.gen(function* () {
    const cursor = Option.map(input.cursor, HostRolePagination.decodeCursor);
    const roles = yield* loadRoles(
      db,
      "listHostRoles",
      undefined,
      Option.getOrUndefined(Option.map(cursor, ({ roleId }) => roleId)),
      input.limit + 1,
    );
    const items = roles.slice(0, input.limit);
    const last = items.at(-1);
    return HostRolePagination.Page.make({
      items,
      nextCursor:
        roles.length > input.limit && last !== undefined
          ? Option.some(HostRolePagination.makeCursor(last.roleId))
          : Option.none(),
    });
  }).pipe(mapStoreError("listHostRoles"));

const getRegisteredHostById = (
  db: EffectSQLiteNodeDatabase,
  hostId: string,
  operation: HostAccessStoreOperation,
) =>
  Effect.gen(function* () {
    const rows = yield* db
      .select()
      .from(registeredHostTable)
      .where(eq(registeredHostTable.hostId, hostId));
    if (rows.length === 0) {
      return yield* new RegisteredHostNotFound({
        hostId,
        message: "registered Host does not exist",
      });
    }
    if (rows.length !== 1) {
      return yield* invariant(operation, "duplicate registered Host");
    }
    const decoded = yield* decodeHosts(rows, operation);
    return decoded[0]!;
  });

const resolveAccessFor = (
  db: EffectSQLiteNodeDatabase,
  hostId: string,
  principalId: CreateHostMembershipInput["principalId"],
  operation: HostAccessStoreOperation,
) =>
  Effect.gen(function* () {
    yield* getRegisteredHostById(db, hostId, operation);
    const rows = yield* db
      .select({
        roleId: principalHostRoleTable.roleId,
        permission: hostRolePermissionTable.permission,
      })
      .from(principalHostMembershipTable)
      .leftJoin(
        principalHostRoleTable,
        and(
          eq(
            principalHostMembershipTable.hostId,
            principalHostRoleTable.hostId,
          ),
          eq(
            principalHostMembershipTable.principalId,
            principalHostRoleTable.principalId,
          ),
        ),
      )
      .leftJoin(
        hostRolePermissionTable,
        eq(principalHostRoleTable.roleId, hostRolePermissionTable.roleId),
      )
      .where(
        and(
          eq(principalHostMembershipTable.hostId, hostId),
          eq(principalHostMembershipTable.principalId, principalId),
        ),
      );
    if (rows.length === 0) {
      return yield* new HostMembershipNotFound({
        hostId,
        principalId,
        message: "Host membership does not exist",
      });
    }
    const decoded = yield* Effect.forEach(rows, ({ roleId, permission }) =>
      roleId === null || permission === null
        ? Effect.fail(
            invariant(operation, "stored Host role has no permissions"),
          )
        : Effect.all([
            Schema.decodeUnknownEffect(HostRoleId)(roleId),
            Schema.decodeUnknownEffect(HostPermission)(permission),
          ]).pipe(
            Effect.mapError(() =>
              invariant(operation, "stored Host role or permission is invalid"),
            ),
            Effect.map(([, decodedPermission]) => decodedPermission),
          ),
    );
    const present = new Set(decoded);
    const effectivePermissions = HostPermission.literals.filter((permission) =>
      present.has(permission),
    );
    if (effectivePermissions.length === 0) {
      return yield* invariant(
        operation,
        "stored membership has no effective permissions",
      );
    }
    return yield* HostMemberAccess.makeEffect({
      hostId,
      principalId,
      effectivePermissions: [
        effectivePermissions[0]!,
        ...effectivePermissions.slice(1),
      ],
    }).pipe(
      Effect.mapError(() =>
        invariant(operation, "stored membership is invalid"),
      ),
    );
  });

const requireRoleIds = (
  db: EffectSQLiteNodeDatabase,
  roleIds: ReadonlyArray<Schema.Schema.Type<typeof HostRoleId>>,
  operation: HostAccessStoreOperation,
) =>
  Effect.gen(function* () {
    const rows = yield* db
      .select({ roleId: hostRoleTable.roleId })
      .from(hostRoleTable)
      .where(inArray(hostRoleTable.roleId, roleIds));
    const decoded = yield* Schema.decodeUnknownEffect(Schema.Array(HostRoleId))(
      rows.map(({ roleId }) => roleId),
    ).pipe(
      Effect.mapError(() =>
        invariant(operation, "stored Host role ID is invalid"),
      ),
    );
    const found = new Set(decoded);
    const missing = roleIds.filter((roleId) => !found.has(roleId));
    if (missing.length > 0) {
      return yield* new HostRolesNotFound({
        roleIds: [missing[0]!, ...missing.slice(1)],
        message: "one or more Host roles do not exist",
      });
    }
  });

/**
 * Shared row loader for Host roles that serves two mutually exclusive query
 * shapes, selected by which optional parameters the caller supplies:
 *
 * - Point read (`selectedRoleId` defined): fetch exactly one role by its
 *   primary key (`WHERE roleId = ?`). Used by `getHostRole`, which further
 *   treats 0 rows as `HostRoleNotFound` and multiple rows as a duplicate
 *   identity invariant failure. `afterRoleId`/`limit` are ignored in this
 *   mode.
 *
 * - Page scan (`selectedRoleId` undefined): list roles ordered by ascending
 *   `roleId`, optionally resuming strictly after `afterRoleId` — a keyset
 *   pagination cursor (`WHERE roleId > ?`, omitted entirely for the first
 *   page). Used by `listHostRoles`, which passes `input.limit + 1` so it can
 *   detect a next page from the extra sentinel row. `limit` must be supplied
 *   in this mode.
 *
 * The two parameters are never combined: `selectedRoleId` always wins, and
 * callers pass `undefined` for it when listing. Rows are decoded into
 * validated `HostRoleId`/`HostPermission` values, with corrupted stored data
 * surfacing as an invariant failure attributed to `operation`.
 *
 * @param selectedRoleId - Exact role ID for a point read; takes priority over
 *   the pagination parameters when defined.
 * @param afterRoleId - Exclusive lower bound for the next page during a page
 *   scan; `undefined` starts a fresh first page.
 * @param limit - Maximum rows to return during a page scan; required when
 *   `selectedRoleId` is undefined (callers overfetch by one for cursor
 *   detection).
 */
const loadRoles = (
  db: EffectSQLiteNodeDatabase,
  operation: "getHostRole" | "listHostRoles",
  selectedRoleId?: string,
  afterRoleId?: string,
  limit?: number,
) =>
  Effect.gen(function* () {
    const roleRows =
      selectedRoleId !== undefined
        ? yield* db
            .select()
            .from(hostRoleTable)
            .where(eq(hostRoleTable.roleId, selectedRoleId))
            .orderBy(asc(hostRoleTable.roleId))
        : yield* db
            .select()
            .from(hostRoleTable)
            .where(
              afterRoleId === undefined
                ? undefined
                : gt(hostRoleTable.roleId, afterRoleId),
            )
            .orderBy(asc(hostRoleTable.roleId))
            .limit(limit!);
    if (roleRows.length === 0) return [];

    const roleIds = yield* Schema.decodeUnknownEffect(Schema.Array(HostRoleId))(
      roleRows.map(({ roleId }) => roleId),
    ).pipe(
      Effect.mapError(() => invariant(operation, "stored role ID is invalid")),
    );
    const permissionRows = yield* db
      .select({
        roleId: hostRolePermissionTable.roleId,
        permission: hostRolePermissionTable.permission,
      })
      .from(hostRolePermissionTable)
      .where(inArray(hostRolePermissionTable.roleId, roleIds));
    const permissionsByRole = new Map<string, Array<HostPermission>>();
    for (const row of permissionRows) {
      const roleId = yield* Schema.decodeUnknownEffect(HostRoleId)(
        row.roleId,
      ).pipe(
        Effect.mapError(() =>
          invariant(operation, "stored permission role ID is invalid"),
        ),
      );
      const permission = yield* Schema.decodeUnknownEffect(HostPermission)(
        row.permission,
      ).pipe(
        Effect.mapError(() =>
          invariant(operation, "stored role permission is invalid"),
        ),
      );
      const current = permissionsByRole.get(roleId) ?? [];
      current.push(permission);
      permissionsByRole.set(roleId, current);
    }

    return yield* Effect.forEach(roleRows, (row, index) => {
      const roleId = roleIds[index]!;
      const present = new Set(permissionsByRole.get(roleId) ?? []);
      const canonicalPermissions = HostPermission.literals.filter(
        (permission) => present.has(permission),
      );
      if (canonicalPermissions.length === 0) {
        return Effect.fail(
          invariant(operation, "stored role has no permissions"),
        );
      }
      return HostRole.makeEffect({
        roleId,
        name: row.name,
        permissions: [
          canonicalPermissions[0]!,
          ...canonicalPermissions.slice(1),
        ],
      }).pipe(
        Effect.mapError(() => invariant(operation, "stored role is invalid")),
      );
    });
  });

const decodeHosts = (
  rows: ReadonlyArray<{
    readonly hostId: string;
    readonly createdAtEpochMs: number;
  }>,
  operation: HostAccessStoreOperation,
) =>
  Schema.decodeUnknownEffect(Schema.Array(RegisteredHost))(rows).pipe(
    Effect.mapError(() =>
      invariant(operation, "stored registered Host is invalid"),
    ),
  );

const makeRegisteredHostPage = (
  rows: ReadonlyArray<{
    readonly hostId: string;
    readonly createdAtEpochMs: number;
  }>,
  limit: number,
  operation: "listPrincipalHosts" | "listRegisteredHosts",
) =>
  Effect.gen(function* () {
    const items = yield* decodeHosts(rows.slice(0, limit), operation);
    const last = items.at(-1);
    return RegisteredHostPagination.Page.make({
      items,
      nextCursor:
        rows.length > limit && last !== undefined
          ? Option.some(RegisteredHostPagination.makeCursor(last.hostId))
          : Option.none(),
    });
  });

const invariant = (operation: HostAccessStoreOperation, message: string) =>
  new HostAccessInvariantViolation({ operation, message });

const mapStoreError =
  (operation: HostAccessStoreOperation) =>
  <A, E extends { readonly _tag: string }, R>(
    effect: Effect.Effect<A, E | SqlError | EffectDrizzleQueryError, R>,
  ) => {
    const storeFailure = () =>
      Effect.fail(
        new HostAccessStoreError({
          operation,
          message: "Host access persistence operation failed",
        }),
      );
    const withoutSqlError = Effect.catchTag(effect, "SqlError", storeFailure);
    return Effect.catchTag(
      withoutSqlError,
      "EffectDrizzleQueryError",
      storeFailure,
    );
  };
