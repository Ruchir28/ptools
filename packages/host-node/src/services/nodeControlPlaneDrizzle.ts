/**
 * @file Scoped database capability for one physical Node control-plane schema.
 *
 * One `@effect/sql-sqlite-node` client owns the underlying `node:sqlite`
 * connection. Drizzle is constructed over that provided client and therefore
 * supplies typed mapping and native Effect transactions without opening or
 * closing a second connection.
 */
import { fileURLToPath } from "node:url";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import {
  type EffectSQLiteNodeDatabase,
  makeWithDefaults,
} from "drizzle-orm/effect-sqlite-node";
import { migrate } from "drizzle-orm/effect-sqlite-node/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { Context, Data, Effect, Layer } from "effect";

const migrationsFolder = fileURLToPath(
  new URL("../../drizzle/node-control-plane", import.meta.url),
);
const migrationsTable = "schema_migration";

/** Safe startup failure for the Node-owned control-plane database boundary. */
export class NodeControlPlaneDatabaseError extends Data.TaggedError(
  "NodeControlPlaneDatabaseError",
)<{ readonly message: string; readonly cause?: unknown }> {}

/**
 * Concrete Drizzle database backed by the deployment's sole scoped Effect SQL
 * connection. Node identity and authorization adapters consume this service;
 * callers never receive a raw `DatabaseSync` or ownership of the connection.
 */
export class NodeControlPlaneDrizzle extends Context.Service<
  NodeControlPlaneDrizzle,
  { readonly database: EffectSQLiteNodeDatabase }
>()("@ptools/host-node/NodeControlPlaneDrizzle") {}

/** Configuration fixed after exclusive deployment ownership is acquired. */
export interface NodeControlPlaneDrizzleOptions {
  readonly filename: string;
}

/**
 * Opens, migrates, and scope-closes one control-plane connection.
 * Migration history is checked against the packaged migration set before any
 * pending migration runs, so a binary cannot silently operate on a database
 * containing an unknown or modified migration.
 */
export const NodeControlPlaneDrizzleLive = (
  options: NodeControlPlaneDrizzleOptions,
): Layer.Layer<NodeControlPlaneDrizzle, NodeControlPlaneDatabaseError> =>
  Layer.effect(
    NodeControlPlaneDrizzle,
    Effect.gen(function* () {
      const sql = yield* SqliteClient.SqliteClient;
      const database = yield* makeWithDefaults();

      // Drizzle owns migration discovery and execution. This preflight adds
      // only ptools' stricter downgrade/integrity rule before Drizzle runs.
      yield* verifyKnownMigrationHistory(sql);
      yield* migrate(database, { migrationsFolder, migrationsTable });

      return NodeControlPlaneDrizzle.of({ database });
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof NodeControlPlaneDatabaseError
          ? cause
          : new NodeControlPlaneDatabaseError({
              message: "Unable to initialize the Node control-plane database.",
              cause,
            }),
      ),
    ),
  ).pipe(Layer.provide(SqliteClient.layer({ filename: options.filename })));

/**
 * Rejects database history that this packaged binary cannot account for.
 *
 * Drizzle still owns reading and applying pending migrations through `migrate`.
 * This preflight exists because the pinned `drizzle-orm` `1.0.0-rc.4`
 * migrator otherwise permits an older binary to open a database containing a
 * newer named migration, and it identifies applied
 * migrations primarily by name without rejecting a changed packaged hash.
 */
const verifyKnownMigrationHistory = (sql: SqliteClient.SqliteClient) =>
  Effect.gen(function* () {
    const migrationTable = yield* sql`
      SELECT 1 AS present
      FROM sqlite_master
      WHERE type = 'table' AND name = ${migrationsTable}
    `;
    if (migrationTable.length === 0) return;

    const packagedMigrations = yield* Effect.try({
      try: () => readMigrationFiles({ migrationsFolder }),
      catch: (cause) =>
        new NodeControlPlaneDatabaseError({
          message: "Unable to read packaged Node control-plane migrations.",
          cause,
        }),
    });
    const expectedHashes = new Map(
      packagedMigrations.map((migration) => [migration.name, migration.hash]),
    );
    const appliedMigrations = yield* sql`
      SELECT hash, name
      FROM schema_migration
      ORDER BY id
    `;

    for (const applied of appliedMigrations) {
      if (
        typeof applied.name !== "string" ||
        typeof applied.hash !== "string" ||
        expectedHashes.get(applied.name) !== applied.hash
      ) {
        return yield* new NodeControlPlaneDatabaseError({
          message:
            "The control-plane database contains an unknown or modified migration.",
        });
      }
    }
  });
