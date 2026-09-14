/**
 * Node control-plane SQLite foundation coverage.
 *
 * Mental model:
 *   one scoped Effect SQLite client opens the physical database, Drizzle maps
 *   typed tables over that exact client, and checked-in migrations establish
 *   the schema before any identity or authorization adapter can use it.
 *
 * What this proves:
 *   1. The pinned Drizzle RC executes through the pinned Effect V4 SQLite
 *      driver and creates the reviewed schema on a real database.
 *   2. Reopening is idempotent while unknown migration history fails closed.
 *   3. Foreign keys and native Drizzle Effect transactions run on that same
 *      connection and roll back multi-table failures.
 *   4. Generated/refined Effect schemas reject malformed persisted domain IDs.
 *
 * Boundaries:
 *   Temporary files, node:sqlite, Effect SQL, Drizzle queries, migrations, and
 *   transactions are real. There is no fake database or transaction helper.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Effect, Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PrincipalRowInsertSchema,
  PrincipalRowSelectSchema,
  PrincipalRowUpdateSchema,
} from "../src/hostControlPlaneDaemon/persistence/nodeControlPlanePersistedSchemas.js";
import {
  localIdentityTable,
  principalTable,
  schemaMigrationTable,
} from "../src/hostControlPlaneDaemon/persistence/nodeControlPlaneSqliteSchema.js";
import {
  NodeControlPlaneDatabaseError,
  NodeControlPlaneDrizzle,
  NodeControlPlaneDrizzleLive,
} from "../src/services/nodeControlPlaneDrizzle.js";

let directory: string;
let filename: string;

const withDatabase = <A, E>(
  effect: Effect.Effect<A, E, NodeControlPlaneDrizzle>,
) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(NodeControlPlaneDrizzleLive({ filename }))),
  );

describe("Node control-plane Effect SQLite and Drizzle", () => {
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "ptools-control-plane-sqlite-"));
    filename = join(directory, "control-plane.sqlite");
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("migrates a real database and reopens it idempotently", async () => {
    const inspect = Effect.gen(function* () {
      const { database } = yield* NodeControlPlaneDrizzle;
      return yield* database.all<{ readonly name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      );
    });

    const firstTables = await withDatabase(inspect);
    const secondTables = await withDatabase(inspect);

    expect(firstTables).toEqual(secondTables);
    expect(firstTables.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        "authorization_catalog_state",
        "control_plane_claim",
        "host_token",
        "local_identity",
        "local_principal_credential",
        "principal",
        "registered_host",
        "schema_migration",
      ]),
    );
  });

  it("rejects unknown migration history before adapters can run", async () => {
    await withDatabase(
      Effect.gen(function* () {
        const { database } = yield* NodeControlPlaneDrizzle;
        yield* database.insert(schemaMigrationTable).values({
          hash: "unknown-hash",
          createdAt: 9_999_999_999_999,
          name: "99999999999999_unknown_future_migration",
        });
      }),
    );

    await expect(
      withDatabase(Effect.asVoid(NodeControlPlaneDrizzle)),
    ).rejects.toBeInstanceOf(NodeControlPlaneDatabaseError);
  });

  it("enforces foreign keys and rolls back a real Drizzle transaction", async () => {
    const persisted = await withDatabase(
      Effect.gen(function* () {
        const { database } = yield* NodeControlPlaneDrizzle;

        const invalidIdentity = database.insert(localIdentityTable).values({
          principalId: "ptools_principal_v1_local_bWlzc2luZw",
          username: "operator",
          passwordHash: "not-plaintext",
          createdAtEpochMs: 1,
        });
        expect((yield* Effect.exit(invalidIdentity))._tag).toBe("Failure");

        const principalId = "ptools_principal_v1_local_b3BlcmF0b3I";
        const transaction = database.transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.insert(principalTable).values({
              principalId,
              createdAtEpochMs: 1,
            });
            yield* tx.insert(principalTable).values({
              principalId,
              createdAtEpochMs: 2,
            });
          }),
        );
        expect((yield* Effect.exit(transaction))._tag).toBe("Failure");

        return yield* database
          .select()
          .from(principalTable)
          .where(eq(principalTable.principalId, principalId));
      }),
    );

    expect(persisted).toEqual([]);
  });

  it("derives refined select, insert, and update schemas from the table", async () => {
    const principalId = "ptools_principal_v1_local_b3BlcmF0b3I";

    expect(
      Schema.decodeUnknownSync(PrincipalRowInsertSchema)({
        principalId,
        createdAtEpochMs: 1,
      }),
    ).toMatchObject({ principalId, createdAtEpochMs: 1 });
    expect(
      Schema.decodeUnknownSync(PrincipalRowUpdateSchema)({
        createdAtEpochMs: 2,
      }),
    ).toEqual({ createdAtEpochMs: 2 });

    // Drizzle's inferred row type cannot detect corrupted domain values. All
    // three generated schemas retain the PrincipalId and EpochMillis checks.
    for (const schema of [
      PrincipalRowSelectSchema,
      PrincipalRowInsertSchema,
      PrincipalRowUpdateSchema,
    ]) {
      expect(() =>
        Schema.decodeUnknownSync(schema)({
          principalId: "caller-selected-id",
          createdAtEpochMs: -1,
        }),
      ).toThrow();
    }
  });
});
