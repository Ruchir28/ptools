/*
 * Abstract HostAccessStore service-shape coverage.
 *
 * What this proves:
 * 1. A platform can implement all eight operations with direct domain successes.
 * 2. Single-value reads and mutations do not require operation result wrappers.
 * 3. Database initialization and built-in installation remain absent from the service.
 *
 * This in-memory value proves Context wiring and signatures only. The first
 * concrete platform adds the reusable behavioral-law suite for identity
 * correlation, canonical ordering, and mutation atomicity.
 */
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  CreatedOwnedHost,
  HostMemberAccess,
  HostPermissions,
  HostRole,
  HostRoleId,
  ListHostRolesInput,
  PrincipalId,
  PrincipalIds,
  RegisteredHost,
  GetHostRoleInput,
  GetRegisteredHostInput,
} from "../src/contracts/index.js";
import { HostAccessStore } from "../src/services/index.js";

/**
 * Minimal valid domain fixtures shared by every operation probe. They exist so
 * the fake store can return complete, schema-valid successes rather than
 * placeholders, proving the service shape composes with real contract types.
 */
const registeredHost = RegisteredHost.make({
  hostId: "host-1",
  createdAtEpochMs: 1,
});
const role = HostRole.make({
  roleId: HostRoleId.make("550e8400-e29b-41d4-a716-446655440000"),
  name: "Member",
  permissions: [HostPermissions.host.read],
});
const memberAccess = HostMemberAccess.make({
  hostId: "host-1",
  principalId: PrincipalIds.fromFixedLocalIdentity("principal-1"),
  effectivePermissions: [HostPermissions.host.read],
});
const createdOwnedHost = CreatedOwnedHost.make({
  host: registeredHost,
  ownerAccess: memberAccess,
});

/**
 * In-memory `HostAccessStore` value proving Context wiring and signatures
 * only. Every operation returns its fixture directly; behavior laws (identity
 * correlation, canonical ordering, mutation atomicity) belong to the shared
 * platform contract suite once the first concrete adapter exists.
 */
const testStore = HostAccessStore.of({
  getRegisteredHost: () => Effect.succeed(registeredHost),
  createOwnedHost: () => Effect.succeed(createdOwnedHost),
  listPrincipalHosts: () => Effect.succeed([registeredHost]),
  listRegisteredHosts: () => Effect.succeed([registeredHost]),
  resolvePrincipalHostAccess: () => Effect.succeed(memberAccess),
  createMembership: () => Effect.succeed(memberAccess),
  replaceMembershipRoles: () => Effect.succeed(memberAccess),
  getHostRole: () => Effect.succeed(role),
  listHostRoles: () => Effect.succeed([role]),
});

/**
 * Service-shape coverage: the store is consumed through Effect context,
 * successes are direct domain values instead of transport wrappers, and
 * init-only seeding stays off the request-time port.
 */
describe("HostAccessStore", () => {
  /**
   * Proves the store is consumed through Effect context, returns the exact
   * domain success for single-value reads and lists, and — because seeding is
   * init-only — exposes no `installBuiltInHostRoles`-style operation at all.
   */
  it("publishes direct domain successes through Effect context", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* HostAccessStore;
        return yield* store.getRegisteredHost(
          GetRegisteredHostInput.make({ hostId: "host-1" }),
        );
      }).pipe(Effect.provideService(HostAccessStore, testStore)),
    );

    expect(result).toBe(registeredHost);
    await expect(
      Effect.runPromise(
        testStore.getHostRole(
          GetHostRoleInput.make({
            roleId: HostRoleId.make("550e8400-e29b-41d4-a716-446655440000"),
          }),
        ),
      ),
    ).resolves.toBe(role);
    await expect(
      Effect.runPromise(testStore.listHostRoles(ListHostRolesInput.make({}))),
    ).resolves.toEqual([role]);
    expect("installBuiltInHostRoles" in testStore).toBe(false);
  });
});
