/**
 * Durable registered-Host and membership coverage.
 *
 * Mental model:
 *   initial claim installs the Host-role catalog, after which HostAccessStore
 *   publishes each Host together with its first Owner and replaces complete
 *   membership role selections inside real SQLite transactions.
 *
 * What this proves:
 *   1. Host + owner membership + Owner assignment become visible together.
 *   2. Effective permissions come from strictly persisted role permissions.
 *   3. Duplicate Host creation and missing role selections do not partially
 *      alter memberships.
 *   4. Global and Principal-scoped Host pages traverse unique Host-ID keys
 *      without skipping, duplicating, or disclosing inaccessible Hosts.
 *
 * Boundaries: SQLite, Drizzle, and shared store contracts are real.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BuiltInHostRoles,
  ClaimInitialAdministratorRecordInput,
  ControlPlaneSetupCapabilityHash,
  CreateHostMembershipInput,
  CreateOwnedHostInput,
  GetHostRoleInput,
  GetRegisteredHostInput,
  HostRoleId,
  type HostRolePagination,
  HostRolesNotFound,
  InitializeControlPlaneInput,
  ListHostRolesInput,
  ListPrincipalHostsInput,
  ListRegisteredHostsInput,
  Pagination,
  Principal,
  PrincipalIds,
  RegisteredHostAlreadyExists,
  RegisteredHostPagination,
  ReplaceMembershipRolesInput,
  ResolvePrincipalHostAccessInput,
} from "@ptools/host-authorization";
import {
  ControlPlaneAccessStore,
  HostAccessStore,
} from "@ptools/host-authorization/effect";
import { Effect, Layer, Option, Result } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeAuthorizationStoresLive } from "../src/hostControlPlaneDaemon/authorization/nodeAuthorizationStores.js";
import {
  NodeControlPlaneDrizzle,
  NodeControlPlaneDrizzleLive,
} from "../src/services/nodeControlPlaneDrizzle.js";

let directory: string;
let filename: string;

const setupCapabilityHash = ControlPlaneSetupCapabilityHash.make(
  "b".repeat(43),
);
const ownerId = PrincipalIds.fromFixedLocalIdentity("host-test/owner");
const memberId = PrincipalIds.fromFixedLocalIdentity("host-test/member");

const live = () =>
  NodeAuthorizationStoresLive.pipe(
    Layer.provideMerge(NodeControlPlaneDrizzleLive({ filename })),
  );

const run = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    ControlPlaneAccessStore | HostAccessStore | NodeControlPlaneDrizzle
  >,
) => Effect.runPromise(effect.pipe(Effect.provide(live())));

const claim = Effect.gen(function* () {
  const controlPlane = yield* ControlPlaneAccessStore;
  yield* controlPlane.initialize(
    InitializeControlPlaneInput.make({ setupCapabilityHash }),
  );
  yield* controlPlane.claimInitialAdministrator(
    ClaimInitialAdministratorRecordInput.make({
      principalId: ownerId,
      setupCapabilityHash,
      claimedAtEpochMs: 1,
    }),
  );
});

describe("Node HostAccessStore", () => {
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "ptools-host-access-"));
    filename = join(directory, "control-plane.sqlite");
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  /**
   * Proves Host registration is one atomic bundle: the Host row, its first
   * Owner membership, and the Owner role assignment become visible together,
   * and every read shape projects them consistently.
   *
   * What this proves:
   *   1. `createOwnedHost` returns both the Host and the owner's full Owner
   *      permission set in one result — no second call needed.
   *   2. Independent resolution (`resolvePrincipalHostAccess`) reproduces the
   *      same effective permissions by joining strictly persisted role
   *      permissions, not by echoing the creation input.
   *   3. Principal-scoped listing, global listing, point lookup, and the
   *      Host-role catalog reads all agree with what was written.
   *
   * This is the positive-path anchor for the file: later tests break one
   * piece (duplicates, unknown roles) and assert nothing else moved.
   */
  it("atomically creates a registered Host with Owner access", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* claim;
        const hosts = yield* HostAccessStore;
        const created = yield* hosts.createOwnedHost(
          CreateOwnedHostInput.make({
            requestedHostId: "node-local",
            ownerPrincipalId: ownerId,
          }),
        );
        const resolved = yield* hosts.resolvePrincipalHostAccess(
          ResolvePrincipalHostAccessInput.make({
            hostId: "node-local",
            principalId: ownerId,
          }),
        );
        const listed = yield* hosts.listPrincipalHosts(
          ListPrincipalHostsInput.make({
            principalId: ownerId,
            limit: Pagination.PageSize.make(10),
            cursor: Option.none(),
          }),
        );
        const registered = yield* hosts.getRegisteredHost(
          GetRegisteredHostInput.make({ hostId: "node-local" }),
        );
        const allHosts = yield* hosts.listRegisteredHosts(
          ListRegisteredHostsInput.make({
            limit: Pagination.PageSize.make(10),
            cursor: Option.none(),
          }),
        );
        const ownerRole = yield* hosts.getHostRole(
          GetHostRoleInput.make({ roleId: BuiltInHostRoles.owner.roleId }),
        );
        const roles = yield* hosts.listHostRoles(
          ListHostRolesInput.make({
            limit: Pagination.PageSize.make(10),
            cursor: Option.none(),
          }),
        );
        return {
          created,
          resolved,
          listed,
          registered,
          allHosts,
          ownerRole,
          roles,
        };
      }),
    );

    expect(result.created.host.hostId).toBe("node-local");
    expect(result.created.ownerAccess.effectivePermissions).toEqual(
      BuiltInHostRoles.owner.permissions,
    );
    expect(result.resolved.effectivePermissions).toEqual(
      BuiltInHostRoles.owner.permissions,
    );
    expect(result.listed.items.map(({ hostId }) => hostId)).toEqual([
      "node-local",
    ]);
    expect(result.registered).toEqual(result.created.host);
    expect(result.allHosts.items).toEqual([result.created.host]);
    expect(result.ownerRole).toEqual(BuiltInHostRoles.owner);
    expect(result.roles.items).toHaveLength(
      Object.keys(BuiltInHostRoles).length,
    );
  });

  /**
   * Proves Host-role listing is correct keyset pagination, not just filtering.
   *
   * Walking pages of ONE (the smallest possible page size) must collect every
   * built-in role exactly once, in ascending role-ID order — the same
   * `afterRoleId` seek used by `listHostRoles` in production. A page size of
   * one maximally exposes off-by-one cursor bugs: skipping the row after each
   * page, repeating the boundary row, or emitting a phantom `nextCursor` on
   * the final page would all fail the sorted/unique/exact-count assertions.
   */
  it("traverses Host roles with bounded keyset pages", async () => {
    const roleIds = await run(
      Effect.gen(function* () {
        yield* claim;
        const hosts = yield* HostAccessStore;
        const collected: Array<string> = [];
        let cursor = Option.none<HostRolePagination.Cursor>();

        do {
          const page = yield* hosts.listHostRoles(
            ListHostRolesInput.make({
              limit: Pagination.PageSize.make(1),
              cursor,
            }),
          );
          expect(page.items).toHaveLength(1);
          collected.push(page.items[0]!.roleId);
          cursor = page.nextCursor;
        } while (Option.isSome(cursor));

        return collected;
      }),
    );

    expect(roleIds).toEqual([...roleIds].sort());
    expect(new Set(roleIds).size).toBe(Object.keys(BuiltInHostRoles).length);
  });

  /**
   * Mental model: global traversal seeks the registered-Host primary key, while
   * scoped traversal seeks the Principal-first membership index and joins only
   * that Principal's Host IDs.
   *
   * What this proves:
   * 1. Both operations publish stable ascending Host-ID pages without gaps or
   *    duplicates.
   * 2. Sparse Principal membership excludes inaccessible Hosts without making
   *    them consume page capacity.
   * 3. Resuming after the final Host ID produces an ordinary terminal page.
   *
   * Boundaries: the SQLite schema, indexes, Drizzle joins, and store are real.
   *
   * Failure mode guarded against: naive LIMIT/OFFSET pagination over a
   * principal-scoped join would let non-member Hosts consume page capacity
   * (gaps in the owner's visible sequence) or re-emit boundary rows across
   * pages; the keyset seek over the membership index must show neither.
   */
  it("traverses Hosts by ID globally and through sparse Principal membership", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* claim;
        const controlPlane = yield* ControlPlaneAccessStore;
        yield* controlPlane.ensurePrincipal(
          Principal.make({ principalId: memberId }),
        );
        const hosts = yield* HostAccessStore;

        // Alternate ownership so the scoped result is sparse relative to the
        // global Host catalog; only membership rows may consume page capacity.
        for (const [hostId, principalId] of [
          ["host-a", ownerId],
          ["host-b", memberId],
          ["host-c", ownerId],
          ["host-d", memberId],
        ] as const) {
          yield* hosts.createOwnedHost(
            CreateOwnedHostInput.make({
              requestedHostId: hostId,
              ownerPrincipalId: principalId,
            }),
          );
        }

        const allHostIds: Array<string> = [];
        let allCursor = Option.none<RegisteredHostPagination.Cursor>();
        do {
          const page = yield* hosts.listRegisteredHosts(
            ListRegisteredHostsInput.make({
              limit: Pagination.PageSize.make(2),
              cursor: allCursor,
            }),
          );
          allHostIds.push(...page.items.map(({ hostId }) => hostId));
          allCursor = page.nextCursor;
        } while (Option.isSome(allCursor));

        const ownerHostIds: Array<string> = [];
        let ownerCursor = Option.none<RegisteredHostPagination.Cursor>();
        do {
          const page = yield* hosts.listPrincipalHosts(
            ListPrincipalHostsInput.make({
              principalId: ownerId,
              limit: Pagination.PageSize.make(1),
              cursor: ownerCursor,
            }),
          );
          ownerHostIds.push(...page.items.map(({ hostId }) => hostId));
          ownerCursor = page.nextCursor;
        } while (Option.isSome(ownerCursor));

        // A valid cursor positioned at the final key is an ordinary exhausted
        // seek, not an error or a repeated final row.
        const exhausted = yield* hosts.listRegisteredHosts(
          ListRegisteredHostsInput.make({
            limit: Pagination.PageSize.make(2),
            cursor: Option.some(
              RegisteredHostPagination.makeCursor("host-d"),
            ),
          }),
        );

        return { allHostIds, ownerHostIds, exhausted };
      }),
    );

    expect(result.allHostIds).toEqual(["host-a", "host-b", "host-c", "host-d"]);
    expect(new Set(result.allHostIds).size).toBe(result.allHostIds.length);
    expect(result.ownerHostIds).toEqual(["host-a", "host-c"]);
    expect(new Set(result.ownerHostIds).size).toBe(result.ownerHostIds.length);
    expect(result.exhausted.items).toEqual([]);
    expect(Option.isNone(result.exhausted.nextCursor)).toBe(true);
  });

  /**
   * Proves Host registration rejects duplicates without side effects.
   *
   * A second `createOwnedHost` for an existing Host ID must fail with the
   * typed `RegisteredHostAlreadyExists` error — not overwrite — and the
   * original Owner's permission set must be fully intact afterwards. This
   * pins the write side of Host-ID uniqueness: re-registering a Host can
   * never silently transfer or reset its ownership.
   */
  it("rejects duplicate Host creation without replacing its Owner", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* claim;
        const hosts = yield* HostAccessStore;
        const input = CreateOwnedHostInput.make({
          requestedHostId: "node-local",
          ownerPrincipalId: ownerId,
        });
        yield* hosts.createOwnedHost(input);
        const duplicate = yield* Effect.result(hosts.createOwnedHost(input));
        const access = yield* hosts.resolvePrincipalHostAccess(
          ResolvePrincipalHostAccessInput.make({
            hostId: "node-local",
            principalId: ownerId,
          }),
        );
        return { duplicate, access };
      }),
    );

    expect(Result.isFailure(result.duplicate)).toBe(true);
    if (Result.isFailure(result.duplicate)) {
      expect(result.duplicate.failure).toBeInstanceOf(
        RegisteredHostAlreadyExists,
      );
    }
    expect(result.access.effectivePermissions).toEqual(
      BuiltInHostRoles.owner.permissions,
    );
  });

  /**
   * Proves role replacement validates the ENTIRE new selection before
   * touching stored membership.
   *
   * The replacement list references a role ID that does not exist in the
   * persisted catalog, so `replaceMembershipRoles` must fail with the typed
   * `HostRolesNotFound` — and, because validation runs inside the same
   * transaction as the delete/insert, the member's current permissions must
   * still be the original Member set afterwards. A validate-after-write
   * implementation would have already deleted the old rows, leaving the
   * member with no access; this test fails in exactly that world.
   */
  it("rejects an unknown replacement role without deleting current access", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* claim;
        const controlPlane = yield* ControlPlaneAccessStore;
        yield* controlPlane.ensurePrincipal(
          Principal.make({ principalId: memberId }),
        );
        const hosts = yield* HostAccessStore;
        yield* hosts.createOwnedHost(
          CreateOwnedHostInput.make({
            requestedHostId: "node-local",
            ownerPrincipalId: ownerId,
          }),
        );
        yield* hosts.createMembership(
          CreateHostMembershipInput.make({
            hostId: "node-local",
            principalId: memberId,
            roleIds: [BuiltInHostRoles.member.roleId],
          }),
        );
        const replacement = yield* Effect.result(
          hosts.replaceMembershipRoles(
            ReplaceMembershipRolesInput.make({
              hostId: "node-local",
              principalId: memberId,
              roleIds: [
                HostRoleId.make("123e4567-e89b-42d3-a456-426614174999"),
              ],
            }),
          ),
        );
        const access = yield* hosts.resolvePrincipalHostAccess(
          ResolvePrincipalHostAccessInput.make({
            hostId: "node-local",
            principalId: memberId,
          }),
        );
        return { replacement, access };
      }),
    );

    expect(Result.isFailure(result.replacement)).toBe(true);
    if (Result.isFailure(result.replacement)) {
      expect(result.replacement.failure).toBeInstanceOf(HostRolesNotFound);
    }
    expect(result.access.effectivePermissions).toEqual(
      BuiltInHostRoles.member.permissions,
    );
  });

  /**
   * Proves membership role selection is complete-replacement semantics.
   *
   * `createMembership` establishes the initial role set (Member) and returns
   * its effective permissions; `replaceMembershipRoles` then swaps the entire
   * selection to Admin, and the returned permissions must reflect ONLY the
   * new set — Member permissions must be gone, not merged. There is no
   * add/remove-roles API by design: callers always state the full desired
   * selection, so effective permissions are never an accumulation of
   * incremental writes.
   */
  it("creates and atomically replaces a complete membership role selection", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* claim;
        const controlPlane = yield* ControlPlaneAccessStore;
        yield* controlPlane.ensurePrincipal(
          Principal.make({ principalId: memberId }),
        );
        const hosts = yield* HostAccessStore;
        yield* hosts.createOwnedHost(
          CreateOwnedHostInput.make({
            requestedHostId: "node-local",
            ownerPrincipalId: ownerId,
          }),
        );
        const member = yield* hosts.createMembership(
          CreateHostMembershipInput.make({
            hostId: "node-local",
            principalId: memberId,
            roleIds: [BuiltInHostRoles.member.roleId],
          }),
        );
        const admin = yield* hosts.replaceMembershipRoles(
          ReplaceMembershipRolesInput.make({
            hostId: "node-local",
            principalId: memberId,
            roleIds: [BuiltInHostRoles.admin.roleId],
          }),
        );
        return { member, admin };
      }),
    );

    expect(result.member.effectivePermissions).toEqual(
      BuiltInHostRoles.member.permissions,
    );
    expect(result.admin.effectivePermissions).toEqual(
      BuiltInHostRoles.admin.permissions,
    );
  });
});
