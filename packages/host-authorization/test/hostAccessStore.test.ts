/*
 * Abstract HostAccessStore service-shape coverage.
 *
 * What this proves:
 * 1. A platform can implement all eight operations with direct domain successes.
 * 2. Single-value reads and mutations do not require operation result wrappers.
 * 3. Database initialization and role seeding remain absent from the service.
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
  HostRoleKey,
  ListHostRolesInput,
  RegisteredHost,
  GetHostRoleInput,
  GetRegisteredHostInput,
} from "../src/contracts/index.js";
import { HostAccessStore } from "../src/services/index.js";

const registeredHost = RegisteredHost.make({
  hostId: "host-1",
  createdAtEpochMs: 1,
});
const role = HostRole.make({
  roleKey: HostRoleKey.make("member"),
  name: "Member",
  permissions: [HostPermissions.host.read],
});
const memberAccess = HostMemberAccess.make({
  hostId: "host-1",
  userId: "user-1",
  effectivePermissions: [HostPermissions.host.read],
});
const createdOwnedHost = CreatedOwnedHost.make({
  host: registeredHost,
  ownerAccess: memberAccess,
});

const testStore = HostAccessStore.of({
  getRegisteredHost: () => Effect.succeed(registeredHost),
  createOwnedHost: () => Effect.succeed(createdOwnedHost),
  listUserHosts: () => Effect.succeed([registeredHost]),
  resolveUserHostAccess: () => Effect.succeed(memberAccess),
  createMembership: () => Effect.succeed(memberAccess),
  replaceMembershipRoles: () => Effect.succeed(memberAccess),
  getHostRole: () => Effect.succeed(role),
  listHostRoles: () => Effect.succeed([role]),
});

describe("HostAccessStore", () => {
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
          GetHostRoleInput.make({ roleKey: HostRoleKey.make("member") }),
        ),
      ),
    ).resolves.toBe(role);
    await expect(
      Effect.runPromise(testStore.listHostRoles(ListHostRolesInput.make({}))),
    ).resolves.toEqual([role]);
    expect("seedBuiltInHostRoles" in testStore).toBe(false);
  });
});
