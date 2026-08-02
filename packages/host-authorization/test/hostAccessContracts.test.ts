/*
 * Shared registered-host access contract coverage.
 *
 * What this proves:
 * 1. Store inputs and reusable domain successes remain schema-backed values.
 * 2. Intrinsic value invariants are enforced by ordinary schema construction.
 * 3. Store diagnostics use the exact operation vocabulary.
 *
 * Input/output correlation and list ordering are service laws for the reusable
 * platform contract suite. These tests use no persistence, RPC, or HTTP.
 */
import { Schema } from "effect";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  CreatedOwnedHost,
  CreateHostMembershipInput,
  CreateOwnedHostInput,
  HostAccessInvariantViolation,
  HostAccessStoreError,
  HostAccessStoreOperation,
  HostMemberAccess,
  HostPermissions,
  HostRole,
  HostRoleKey,
  ListHostRolesInput,
  ListUserHostsInput,
  RegisteredHost,
  ReplaceMembershipRolesInput,
  GetHostRoleInput,
  GetRegisteredHostInput,
  ResolveUserHostAccessInput,
} from "../src/contracts/index.js";

const host = (hostId: string, createdAtEpochMs = 1): RegisteredHost =>
  RegisteredHost.make({ hostId, createdAtEpochMs });

const access = (hostId: string, userId: string): HostMemberAccess =>
  HostMemberAccess.make({
    hostId,
    userId,
    effectivePermissions: [
      HostPermissions.host.read,
      HostPermissions.host.execute,
    ],
  });

describe("host access domain values", () => {
  it("uses branded classes rather than structurally interchangeable records", () => {
    expectTypeOf<{
      readonly hostId: string;
      readonly createdAtEpochMs: number;
    }>().not.toMatchTypeOf<RegisteredHost>();
    expectTypeOf<{
      readonly hostId: string;
      readonly userId: string;
      readonly effectivePermissions: readonly ["host:read"];
    }>().not.toMatchTypeOf<HostMemberAccess>();

    expect(host("host-1")).toBeInstanceOf(RegisteredHost);
    expect(access("host-1", "user-1")).toBeInstanceOf(HostMemberAccess);
  });

  it("validates timestamps and canonical effective permissions", () => {
    const decodeAccess = Schema.decodeUnknownSync(HostMemberAccess);

    expect(() =>
      RegisteredHost.make({ hostId: "host-1", createdAtEpochMs: -1 }),
    ).toThrow();
    expect(() =>
      decodeAccess({
        hostId: "host-1",
        userId: "user-1",
        effectivePermissions: [],
      }),
    ).toThrow();
    expect(() =>
      decodeAccess({
        hostId: "host-1",
        userId: "user-1",
        effectivePermissions: [
          HostPermissions.host.execute,
          HostPermissions.host.read,
        ],
      }),
    ).toThrow();
    expect(() =>
      decodeAccess({
        hostId: "host-1",
        userId: "user-1",
        effectivePermissions: [
          HostPermissions.host.read,
          HostPermissions.host.read,
        ],
      }),
    ).toThrow();
  });

  it("rejects persistence fields under strict external decoding", () => {
    const decode = Schema.decodeUnknownSync(HostMemberAccess, {
      onExcessProperty: "error",
    });

    expect(() =>
      decode({
        hostId: "host-1",
        userId: "user-1",
        effectivePermissions: [HostPermissions.host.read],
        roleId: 42,
      }),
    ).toThrow();
  });

  it("enforces the intrinsic owned-host aggregate invariant through .make", () => {
    const registeredHost = host("host-1");
    const ownerAccess = access("host-1", "user-1");

    expect(
      CreatedOwnedHost.make({ host: registeredHost, ownerAccess }),
    ).toMatchObject({ host: registeredHost, ownerAccess });
    expect(() =>
      CreatedOwnedHost.make({
        host: registeredHost,
        ownerAccess: access("different-host", "user-1"),
      }),
    ).toThrow();
  });
});

describe("host access operation inputs", () => {
  it("constructs one explicit input value for every store operation", () => {
    expect(GetRegisteredHostInput.make({ hostId: "host-1" })).toBeInstanceOf(
      GetRegisteredHostInput,
    );
    expect(
      CreateOwnedHostInput.make({
        requestedHostId: "host-1",
        ownerUserId: "user-1",
      }),
    ).toBeInstanceOf(CreateOwnedHostInput);
    expect(ListUserHostsInput.make({ userId: "user-1" })).toBeInstanceOf(
      ListUserHostsInput,
    );
    expect(
      ResolveUserHostAccessInput.make({
        hostId: "host-1",
        userId: "user-1",
      }),
    ).toBeInstanceOf(ResolveUserHostAccessInput);
    expect(
      CreateHostMembershipInput.make({
        hostId: "host-1",
        userId: "user-1",
        roleKeys: [HostRoleKey.make("member")],
      }),
    ).toBeInstanceOf(CreateHostMembershipInput);
    expect(
      ReplaceMembershipRolesInput.make({
        hostId: "host-1",
        userId: "user-1",
        roleKeys: [HostRoleKey.make("admin")],
      }),
    ).toBeInstanceOf(ReplaceMembershipRolesInput);
    expect(
      GetHostRoleInput.make({ roleKey: HostRoleKey.make("admin") }),
    ).toBeInstanceOf(GetHostRoleInput);
    expect(ListHostRolesInput.make({})).toBeInstanceOf(ListHostRolesInput);
  });

  it("keeps operation successes as domain values instead of wrapper DTOs", () => {
    expect(host("host-1")).toBeInstanceOf(RegisteredHost);
    expect(access("host-1", "user-1")).toBeInstanceOf(HostMemberAccess);
    expect(
      HostRole.make({
        roleKey: HostRoleKey.make("member"),
        name: "Member",
        permissions: [HostPermissions.host.read],
      }),
    ).toBeInstanceOf(HostRole);
  });
});

describe("host access errors", () => {
  it("uses exact runtime operation discriminators", () => {
    expect(HostAccessStoreOperation.literals).toEqual([
      "getRegisteredHost",
      "createOwnedHost",
      "listUserHosts",
      "resolveUserHostAccess",
      "createMembership",
      "replaceMembershipRoles",
      "getHostRole",
      "listHostRoles",
    ]);
  });

  it("round-trips exact invariant and store operation fields", () => {
    const invariant = new HostAccessInvariantViolation({
      operation: "createOwnedHost",
      message: "invalid platform result",
    });
    const storeError = new HostAccessStoreError({
      operation: "listUserHosts",
      message: "central access storage unavailable",
    });

    expect(
      Schema.decodeUnknownSync(HostAccessInvariantViolation)(invariant),
    ).toEqual(invariant);
    expect(Schema.decodeUnknownSync(HostAccessStoreError)(storeError)).toEqual(
      storeError,
    );
    expect(() =>
      Schema.decodeUnknownSync(HostAccessStoreError)({
        _tag: "HostAccessStoreError",
        operation: "seedBuiltInHostRoles",
        message: "not a runtime store operation",
      }),
    ).toThrow();
  });
});
