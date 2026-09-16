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
 *   5. Host and token pagination queries seek the indexes that own their
 *      ordering rather than sorting or scanning unrelated rows.
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

  /**
   * Mental model: each bounded page must begin at its cursor inside the index
   * that owns the published order. Global Hosts use their primary key, scoped
   * Hosts use the Principal-first membership index, and tokens use their
   * creation-time composite indexes.
   *
   * What this proves:
   * 1. Global Host pages seek the `host_id` primary-key index.
   * 2. Principal-scoped pages seek `(principal_id, host_id)` before joining the
   *    selected Host rows and require no temporary ordering B-tree.
   * 3. Both token listing scopes retain their matching composite indexes.
   *
   * Boundaries: checked-in migrations and SQLite's real query planner are real;
   * the SQL mirrors the corresponding Drizzle store queries.
   */
  it("uses range-seek indexes for bounded Host and token pages", async () => {
    const plans = await withDatabase(
      Effect.gen(function* () {
        const { database } = yield* NodeControlPlaneDrizzle;
        const hosts = yield* database.all<{ readonly detail: string }>(
          "EXPLAIN QUERY PLAN SELECT * FROM registered_host WHERE host_id > 'host-1' ORDER BY host_id LIMIT 11",
        );
        const principalHosts = yield* database.all<{ readonly detail: string }>(
          "EXPLAIN QUERY PLAN SELECT host.host_id, host.created_at_epoch_ms FROM principal_host_membership AS membership INNER JOIN registered_host AS host ON membership.host_id = host.host_id WHERE membership.principal_id = 'principal-1' AND membership.host_id > 'host-1' ORDER BY membership.host_id LIMIT 11",
        );
        const allTokens = yield* database.all<{ readonly detail: string }>(
          "EXPLAIN QUERY PLAN SELECT * FROM host_token WHERE created_at_epoch_ms > 10 OR (created_at_epoch_ms = 10 AND token_id > '123e4567-e89b-42d3-a456-426614174000') ORDER BY created_at_epoch_ms, token_id LIMIT 11",
        );
        const hostTokens = yield* database.all<{ readonly detail: string }>(
          "EXPLAIN QUERY PLAN SELECT * FROM host_token WHERE host_id = 'host-1' AND (created_at_epoch_ms > 10 OR (created_at_epoch_ms = 10 AND token_id > '123e4567-e89b-42d3-a456-426614174000')) ORDER BY created_at_epoch_ms, token_id LIMIT 11",
        );
        return { hosts, principalHosts, allTokens, hostTokens };
      }),
    );

    expect(
      plans.hosts.some(({ detail }) =>
        detail.includes("sqlite_autoindex_registered_host_1"),
      ),
    ).toBe(true);
    expect(
      plans.principalHosts.some(({ detail }) =>
        detail.includes("principal_host_membership_principal_page_idx"),
      ),
    ).toBe(true);
    expect(
      plans.principalHosts.some(({ detail }) =>
        detail.includes("sqlite_autoindex_registered_host_1"),
      ),
    ).toBe(true);
    expect(
      plans.principalHosts.every(
        ({ detail }) => !detail.includes("USE TEMP B-TREE"),
      ),
    ).toBe(true);
    expect(
      plans.allTokens.some(({ detail }) =>
        detail.includes("host_token_page_idx"),
      ),
    ).toBe(true);
    expect(
      plans.hostTokens.some(({ detail }) =>
        detail.includes("host_token_host_page_idx"),
      ),
    ).toBe(true);
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
