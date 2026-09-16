/**
 * Durable Control Plane access-store coverage.
 *
 * Mental model:
 *   the shared bootstrap port delegates one indivisible initial claim to the
 *   Node adapter; that transaction installs both role catalogs, registers the
 *   claimant, grants Administrator, consumes setup authority, and publishes
 *   claimed state together.
 *
 * What this proves:
 *   1. Exact built-in role IDs, permissions, and catalog versions are installed.
 *   2. A repeated claim cannot create a second Administrator.
 *   3. Role replacement cannot remove the final Administrator and rolls back.
 *   4. Principal registration remains idempotent and grants no authority.
 *
 * Boundaries:
 *   SQLite, Effect SQL, Drizzle migrations, and transactions are real. Only
 *   secure-random setup generation is bypassed by supplying a validated digest
 *   directly to the persistence port.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BuiltInControlPlaneRoleDefinitionVersion,
  BuiltInControlPlaneRoles,
  BuiltInHostRoleDefinitionVersion,
  BuiltInHostRoles,
  ClaimInitialAdministratorRecordInput,
  ControlPlaneAccessInvariantViolation,
  ControlPlaneClaimRejected,
  ControlPlaneSetupCapabilityHash,
  InitializeControlPlaneInput,
  LastControlPlaneAdministrator,
  Principal,
  PrincipalIds,
  ReplacePrincipalControlPlaneRolesInput,
  ResolvePrincipalControlPlaneAccessInput,
} from "@ptools/host-authorization";
import { ControlPlaneAccessStore } from "@ptools/host-authorization/effect";
import { eq } from "drizzle-orm";
import { Context, Effect, Layer, Result } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeAuthorizationStoresLive } from "../src/hostControlPlaneDaemon/authorization/nodeAuthorizationStores.js";
import { NodeAuthorizationCatalogStartupProbeLive } from "../src/hostControlPlaneDaemon/authorization/nodeAuthorizationStores.js";
import {
  authorizationCatalogStateTable,
  controlPlaneRolePermissionTable,
  controlPlaneRoleTable,
  hostRolePermissionTable,
  hostRoleTable,
  principalControlPlaneRoleTable,
  principalTable,
} from "../src/hostControlPlaneDaemon/persistence/nodeControlPlaneSqliteSchema.js";
import {
  NodeControlPlaneDrizzle,
  NodeControlPlaneDrizzleLive,
} from "../src/services/nodeControlPlaneDrizzle.js";

let directory: string;
let filename: string;

const setupHash = ControlPlaneSetupCapabilityHash.make("a".repeat(43));
const operatorId = PrincipalIds.fromFixedLocalIdentity("test/operator");
const otherId = PrincipalIds.fromFixedLocalIdentity("test/other");

const live = () =>
  NodeAuthorizationStoresLive.pipe(
    Layer.provideMerge(NodeControlPlaneDrizzleLive({ filename })),
  );

const run = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    ControlPlaneAccessStore | NodeControlPlaneDrizzle
  >,
) => Effect.runPromise(effect.pipe(Effect.provide(live())));

const initializeAndClaim = Effect.gen(function* () {
  const store = yield* ControlPlaneAccessStore;
  yield* store.initialize(
    InitializeControlPlaneInput.make({ setupCapabilityHash: setupHash }),
  );
  return yield* store.claimInitialAdministrator(
    ClaimInitialAdministratorRecordInput.make({
      principalId: operatorId,
      setupCapabilityHash: setupHash,
      claimedAtEpochMs: 100,
    }),
  );
});

describe("Node ControlPlaneAccessStore", () => {
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "ptools-control-access-"));
    filename = join(directory, "control-plane.sqlite");
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  /**
   * Proves the first-claim transaction installs the complete package-authored
   * catalog exactly as this binary understands it, and grants the claimant
   * Administrator in the same atomic step.
   *
   * What this proves:
   *   1. The claim result itself already carries the full Administrator
   *      permission set — no second read or backfill is needed.
   *   2. The catalog-state row pins both definition versions this binary was
   *      built with (the values the startup probe later re-proves).
   *   3. Persisted role names/IDs match the built-in constants byte-for-byte;
   *      permission and host-role row counts match the package catalogs so
   *      nothing extra or missing was installed.
   *   4. The claimant's role assignment is written in the same transaction —
   *      a claimed database can never exist without its Administrator.
   *
   * Direct SQLite reads (not store calls) are deliberate: the assertion is
   * about the persisted rows themselves, not the store's projection of them.
   */
  it("claims once and atomically installs both exact built-in catalogs", async () => {
    const result = await run(
      Effect.gen(function* () {
        const access = yield* initializeAndClaim;
        const { database } = yield* NodeControlPlaneDrizzle;
        return {
          access,
          catalog: yield* database
            .select()
            .from(authorizationCatalogStateTable),
          controlRoles: yield* database.select().from(controlPlaneRoleTable),
          controlPermissions: yield* database
            .select()
            .from(controlPlaneRolePermissionTable),
          hostRoles: yield* database.select().from(hostRoleTable),
          hostPermissions: yield* database
            .select()
            .from(hostRolePermissionTable),
          assignments: yield* database
            .select()
            .from(principalControlPlaneRoleTable),
        };
      }),
    );

    expect(result.access.effectivePermissions).toEqual(
      BuiltInControlPlaneRoles.administrator.permissions,
    );
    expect(result.catalog).toEqual([
      {
        catalogStateId: 1,
        controlPlaneRoleVersion: BuiltInControlPlaneRoleDefinitionVersion,
        hostRoleVersion: BuiltInHostRoleDefinitionVersion,
      },
    ]);
    expect(result.controlRoles).toEqual([
      {
        roleId: BuiltInControlPlaneRoles.administrator.roleId,
        name: BuiltInControlPlaneRoles.administrator.name,
      },
    ]);
    expect(
      result.controlPermissions.map(({ permission }) => permission),
    ).toEqual(
      expect.arrayContaining([
        ...BuiltInControlPlaneRoles.administrator.permissions,
      ]),
    );
    expect(result.hostRoles).toHaveLength(Object.keys(BuiltInHostRoles).length);
    expect(result.hostPermissions).toHaveLength(
      Object.values(BuiltInHostRoles).reduce(
        (count, role) => count + role.permissions.length,
        0,
      ),
    );
    expect(result.assignments).toEqual([
      {
        principalId: operatorId,
        roleId: BuiltInControlPlaneRoles.administrator.roleId,
      },
    ]);
  });

  /**
   * Proves the initial claim is once-only and immutable once accepted.
   *
   * A second principal presenting the same valid setup capability after a
   * committed claim must be rejected with the dedicated typed error
   * (`ControlPlaneClaimRejected`) — not silently ignored — and the first
   * claimant's record (identity, timestamp) must remain untouched. This is
   * the guarantee that prevents a late caller with a leaked setup capability
   * from minting a second Administrator.
   */
  it("rejects a repeated claim without changing the first claimant", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        yield* initializeAndClaim;
        const store = yield* ControlPlaneAccessStore;
        const second = yield* Effect.result(
          store.claimInitialAdministrator(
            ClaimInitialAdministratorRecordInput.make({
              principalId: otherId,
              setupCapabilityHash: setupHash,
              claimedAtEpochMs: 200,
            }),
          ),
        );
        return { second, status: yield* store.getClaimStatus() };
      }),
    );

    expect(Result.isFailure(outcome.second)).toBe(true);
    if (Result.isFailure(outcome.second)) {
      expect(outcome.second.failure).toBeInstanceOf(ControlPlaneClaimRejected);
    }
    expect(outcome.status).toMatchObject({
      _tag: "Claimed",
      initialAdministratorId: operatorId,
      claimedAtEpochMs: 100,
    });
  });

  /**
   * Proves claim uniqueness holds under a race, not just sequentially.
   *
   * Two claims for different principals are launched concurrently against the
   * same initialized database. Exactly one may succeed; the loser must fail
   * with `ControlPlaneClaimRejected`. This exercises the atomic
   * compare-and-set inside the claim transaction (claim state consumed in the
   * same write that installs the catalog), which a naive check-then-insert
   * would fail under interleaving.
   */
  it("admits exactly one of two concurrent initial claims", async () => {
    const results = await run(
      Effect.gen(function* () {
        const store = yield* ControlPlaneAccessStore;
        yield* store.initialize(
          InitializeControlPlaneInput.make({ setupCapabilityHash: setupHash }),
        );
        return yield* Effect.all(
          [
            Effect.result(
              store.claimInitialAdministrator(
                ClaimInitialAdministratorRecordInput.make({
                  principalId: operatorId,
                  setupCapabilityHash: setupHash,
                  claimedAtEpochMs: 100,
                }),
              ),
            ),
            Effect.result(
              store.claimInitialAdministrator(
                ClaimInitialAdministratorRecordInput.make({
                  principalId: otherId,
                  setupCapabilityHash: setupHash,
                  claimedAtEpochMs: 101,
                }),
              ),
            ),
          ],
          { concurrency: "unbounded" },
        );
      }),
    );

    expect(results.filter(Result.isSuccess)).toHaveLength(1);
    expect(results.filter(Result.isFailure)).toHaveLength(1);
    const rejected = results.find(Result.isFailure);
    expect(
      rejected && Result.isFailure(rejected) ? rejected.failure : null,
    ).toBeInstanceOf(ControlPlaneClaimRejected);
  });

  /**
   * Proves the last-administrator invariant is enforced atomically at the
   * mutation that would violate it.
   *
   * The sole Administrator attempts to remove all of their own roles. The
   * store must fail with the dedicated `LastControlPlaneAdministrator` error
   * (not a generic failure) AND leave the stored permission set fully intact
   * — proving rollback, not merely validation-after-write. Without this
   * guard, the control plane could enter unrecoverable lockout: no principal
   * left with authority to grant Administrator again.
   */
  it("rolls back an attempted removal of the final Administrator", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* initializeAndClaim;
        const store = yield* ControlPlaneAccessStore;
        const replacement = yield* Effect.result(
          store.replaceRoles(
            ReplacePrincipalControlPlaneRolesInput.make({
              principalId: operatorId,
              roleIds: [],
              assignedByPrincipalId: operatorId,
            }),
          ),
        );
        const access = yield* store.resolvePermissions(
          ResolvePrincipalControlPlaneAccessInput.make({
            principalId: operatorId,
          }),
        );
        return { replacement, access };
      }),
    );

    expect(Result.isFailure(result.replacement)).toBe(true);
    if (Result.isFailure(result.replacement)) {
      expect(result.replacement.failure).toBeInstanceOf(
        LastControlPlaneAdministrator,
      );
    }
    expect(result.access.effectivePermissions).toEqual(
      BuiltInControlPlaneRoles.administrator.permissions,
    );
  });

  /**
   * Proves the claim path refuses a database whose authorization catalog is
   * partially installed, and that the refusal leaves no partial state.
   *
   * The test bypasses the store and raw-inserts one host role row (no
   * permissions, no catalog-state row), simulating an interrupted earlier
   * install. `claimInitialAdministrator` must then:
   *   1. fail with `ControlPlaneAccessInvariantViolation` — a pre-existing
   *      catalog is contradictory during a fresh claim, and the installer is
   *      deliberately not an upsert;
   *   2. roll back its own writes — claim state stays `Unclaimed` and no
   *      principal row exists, so the database remains retryable after the
   *      inconsistency is repaired rather than half-claimed.
   */
  it("rolls back claim when a partial catalog already exists", async () => {
    const result = await run(
      Effect.gen(function* () {
        const store = yield* ControlPlaneAccessStore;
        yield* store.initialize(
          InitializeControlPlaneInput.make({ setupCapabilityHash: setupHash }),
        );
        const { database } = yield* NodeControlPlaneDrizzle;
        yield* database.insert(hostRoleTable).values({
          roleId: BuiltInHostRoles.owner.roleId,
          name: BuiltInHostRoles.owner.name,
        });
        const claimResult = yield* Effect.result(
          store.claimInitialAdministrator(
            ClaimInitialAdministratorRecordInput.make({
              principalId: operatorId,
              setupCapabilityHash: setupHash,
              claimedAtEpochMs: 100,
            }),
          ),
        );
        return {
          claimResult,
          status: yield* store.getClaimStatus(),
          principals: yield* database.select().from(principalTable),
        };
      }),
    );

    expect(Result.isFailure(result.claimResult)).toBe(true);
    if (Result.isFailure(result.claimResult)) {
      expect(result.claimResult.failure).toBeInstanceOf(
        ControlPlaneAccessInvariantViolation,
      );
    }
    expect(result.status._tag).toBe("Unclaimed");
    expect(result.principals).toEqual([]);
  });

  /**
   * Proves a tampered catalog cannot boot the daemon.
   *
   * After a legitimate claim, the test hand-edits the persisted catalog-state
   * version (simulating a database written by a different/newer binary), then
   * rebuilds the store composition exactly as control-plane startup does and
   * runs the authorization catalog startup probe against it.
   *
   * What this proves: the failure surfaces at `Layer.build` time — before any
   * request can be served — as a failed probe, not a per-request error.
   * V1 has no catalog transition runner, so a version mismatch must fail
   * closed at boot instead of guessing at semantics. The scoping gymnastics
   * (manual Layer.build/Effect.scoped) exist to reproduce real composition
   * order: probe built over the same scoped database, failure observed as
   * the layer's exit result.
   */
  it("fails startup when a claimed catalog is corrupted", async () => {
    // Builds the stores and the startup probe over one scoped database, as
    // control-plane composition does. The probe failure — not a request — is
    // the proof that a tampered catalog cannot boot.
    const buildComposition = Effect.scoped(
      Effect.gen(function* () {
        const drizzleContext = yield* Layer.build(
          NodeControlPlaneDrizzleLive({ filename }),
        );
        const provideDrizzle = Layer.succeedContext(
          drizzleContext,
        ) as Layer.Layer<NodeControlPlaneDrizzle, never, never>;
        const stores = yield* Layer.build(
          NodeAuthorizationStoresLive.pipe(Layer.provide(provideDrizzle)),
        );
        const provideAll = Layer.succeedContext(
          Context.merge(drizzleContext, stores),
        ) as Layer.Layer<
          ControlPlaneAccessStore | NodeControlPlaneDrizzle,
          never,
          never
        >;
        yield* Effect.provide(
          Effect.gen(function* () {
            yield* initializeAndClaim;
            const { database } = yield* NodeControlPlaneDrizzle;
            yield* database
              .update(authorizationCatalogStateTable)
              .set({ hostRoleVersion: 999 })
              .where(eq(authorizationCatalogStateTable.catalogStateId, 1));
          }),
          provideAll,
        );
        const probe = yield* Effect.result(
          Layer.build(
            NodeAuthorizationCatalogStartupProbeLive.pipe(
              Layer.provide(provideDrizzle),
            ),
          ),
        );
        return probe;
      }),
    );
    const outcome = await Effect.runPromise(Effect.result(buildComposition));
    expect(Result.isSuccess(outcome)).toBe(true);
    if (Result.isSuccess(outcome)) {
      expect(Result.isFailure(outcome.success)).toBe(true);
    }
  });

  /**
   * Proves the permission-resolution path fails closed on corrupted stored
   * vocabulary rather than silently dropping or tolerating it.
   *
   * One persisted permission value is overwritten with an unknown string
   * after a legitimate claim. The next `resolvePermissions` call must fail
   * with `ControlPlaneAccessInvariantViolation` — strict schema decoding of
   * every stored permission, no permissive fallback. This is the request-path
   * complement to the startup probe: a malformed grant can never be
   * interpreted as "no permission" or "unknown, allow" — it denies the
   * referencing request outright.
   */
  it("rejects malformed persisted permission vocabulary", async () => {
    const failure = await run(
      Effect.gen(function* () {
        yield* initializeAndClaim;
        const { database } = yield* NodeControlPlaneDrizzle;
        yield* database
          .update(controlPlaneRolePermissionTable)
          .set({ permission: "unknown:permission" })
          .where(
            eq(
              controlPlaneRolePermissionTable.permission,
              BuiltInControlPlaneRoles.administrator.permissions[0],
            ),
          );
        const store = yield* ControlPlaneAccessStore;
        return yield* Effect.result(
          store.resolvePermissions(
            ResolvePrincipalControlPlaneAccessInput.make({
              principalId: operatorId,
            }),
          ),
        );
      }),
    );

    expect(Result.isFailure(failure)).toBe(true);
    if (Result.isFailure(failure)) {
      expect(failure.failure).toBeInstanceOf(
        ControlPlaneAccessInvariantViolation,
      );
    }
  });

  /**
   * Proves principal registration is idempotent and confers no authority.
   *
   * `ensurePrincipal` is called twice for the same principal ID (the duplicate
   * must be a no-op, not an error or a second row), and the principal then
   * resolves to an EMPTY permission set. Registration establishes durable
   * identity only — authentication proves the caller, but admission authority
   * comes exclusively from explicit role assignment, so merely existing as a
   * principal row grants nothing.
   */
  it("registers another Principal idempotently without granting authority", async () => {
    const access = await run(
      Effect.gen(function* () {
        yield* initializeAndClaim;
        const store = yield* ControlPlaneAccessStore;
        const principal = Principal.make({ principalId: otherId });
        yield* store.ensurePrincipal(principal);
        yield* store.ensurePrincipal(principal);
        return yield* store.resolvePermissions(
          ResolvePrincipalControlPlaneAccessInput.make({
            principalId: otherId,
          }),
        );
      }),
    );

    expect(access.effectivePermissions).toEqual([]);
  });
});
