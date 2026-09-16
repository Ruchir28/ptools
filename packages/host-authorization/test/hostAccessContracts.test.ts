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
import { Option, Schema } from "effect";
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
  HostRoleId,
  ListHostRolesInput,
  ListPrincipalHostsInput,
  ListRegisteredHostsInput,
  Pagination,
  PrincipalId,
  PrincipalIds,
  RegisteredHost,
  ReplaceMembershipRolesInput,
  GetHostRoleInput,
  GetRegisteredHostInput,
  ResolvePrincipalHostAccessInput,
} from "../src/contracts/index.js";

/** Fixture builders producing schema-valid domain values for contract probes. */
const host = (hostId: string, createdAtEpochMs = 1): RegisteredHost =>
  RegisteredHost.make({ hostId, createdAtEpochMs });

const access = (hostId: string, principalId: string): HostMemberAccess =>
  HostMemberAccess.make({
    hostId,
    principalId: PrincipalIds.fromFixedLocalIdentity(principalId),
    effectivePermissions: [
      HostPermissions.host.read,
      HostPermissions.host.execute,
    ],
  });

/**
 * Domain-value invariants: branded construction, intrinsic validation, strict
 * external decoding, and the owned-host aggregate law are enforced by the
 * schemas themselves, not by service code.
 */
describe("host access domain values", () => {
  /**
   * Proves plain structural objects cannot typecheck as the branded domain
   * values, so hand-built rows or decoded JSON cannot masquerade as
   * `RegisteredHost` or `HostMemberAccess` output.
   */
  it("uses branded classes rather than structurally interchangeable records", () => {
    expectTypeOf<{
      readonly hostId: string;
      readonly createdAtEpochMs: number;
    }>().not.toMatchTypeOf<RegisteredHost>();
    expectTypeOf<{
      readonly hostId: string;
      readonly principalId: string;
      readonly effectivePermissions: readonly ["host:read"];
    }>().not.toMatchTypeOf<HostMemberAccess>();

    expect(host("host-1")).toBeInstanceOf(RegisteredHost);
    expect(access("host-1", "user-1")).toBeInstanceOf(HostMemberAccess);
  });

  /**
   * Proves intrinsic schema filters reject negative timestamps, empty
   * permission lists, out-of-catalog order, and duplicates at construction
   * time rather than at use time.
   */
  it("validates timestamps and canonical effective permissions", () => {
    const decodeAccess = Schema.decodeUnknownSync(HostMemberAccess);

    expect(() =>
      RegisteredHost.make({ hostId: "host-1", createdAtEpochMs: -1 }),
    ).toThrow();
    expect(() =>
      decodeAccess({
        hostId: "host-1",
        principalId: PrincipalIds.fromFixedLocalIdentity("principal-1"),
        effectivePermissions: [],
      }),
    ).toThrow();
    expect(() =>
      decodeAccess({
        hostId: "host-1",
        principalId: PrincipalIds.fromFixedLocalIdentity("principal-1"),
        effectivePermissions: [
          HostPermissions.host.execute,
          HostPermissions.host.read,
        ],
      }),
    ).toThrow();
    expect(() =>
      decodeAccess({
        hostId: "host-1",
        principalId: PrincipalIds.fromFixedLocalIdentity("principal-1"),
        effectivePermissions: [
          HostPermissions.host.read,
          HostPermissions.host.read,
        ],
      }),
    ).toThrow();
  });

  /**
   * Proves strict external decoding flags excess properties, so private
   * platform persistence fields cannot silently leak into the shared
   * contract shape.
   */
  it("rejects persistence fields under strict external decoding", () => {
    const decode = Schema.decodeUnknownSync(HostMemberAccess, {
      onExcessProperty: "error",
    });

    expect(() =>
      decode({
        hostId: "host-1",
        principalId: PrincipalIds.fromFixedLocalIdentity("principal-1"),
        effectivePermissions: [HostPermissions.host.read],
        roleId: 42,
      }),
    ).toThrow();
  });

  /**
   * Proves `CreatedOwnedHost` construction fails when the owner access
   * belongs to a different Host than the registered Host — the aggregate
   * identity law holds at the value level, not only inside store
   * implementations.
   */
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

/**
 * Every store verb carries one explicit, branded input value, and successes
 * stay domain values — no transport-style result wrappers or optional
 * smart-constructor conventions.
 */
describe("host access operation inputs", () => {
  /**
   * Proves each of the nine store verbs has a dedicated branded input class,
   * so call sites cannot pass loosely typed argument bundles.
   */
  it("constructs one explicit input value for every store operation", () => {
    expect(GetRegisteredHostInput.make({ hostId: "host-1" })).toBeInstanceOf(
      GetRegisteredHostInput,
    );
    expect(
      CreateOwnedHostInput.make({
        requestedHostId: "host-1",
        ownerPrincipalId: PrincipalIds.fromFixedLocalIdentity("principal-1"),
      }),
    ).toBeInstanceOf(CreateOwnedHostInput);
    expect(
      ListPrincipalHostsInput.make({
        principalId: PrincipalIds.fromFixedLocalIdentity("principal-1"),
        limit: Pagination.PageSize.make(10),
        cursor: Option.none(),
      }),
    ).toBeInstanceOf(ListPrincipalHostsInput);
    expect(
      ListRegisteredHostsInput.make({
        limit: Pagination.PageSize.make(10),
        cursor: Option.none(),
      }),
    ).toBeInstanceOf(ListRegisteredHostsInput);
    expect(
      ResolvePrincipalHostAccessInput.make({
        hostId: "host-1",
        principalId: PrincipalIds.fromFixedLocalIdentity("principal-1"),
      }),
    ).toBeInstanceOf(ResolvePrincipalHostAccessInput);
    expect(
      CreateHostMembershipInput.make({
        hostId: "host-1",
        principalId: PrincipalIds.fromFixedLocalIdentity("principal-1"),
        roleIds: [HostRoleId.make("550e8400-e29b-41d4-a716-446655440000")],
      }),
    ).toBeInstanceOf(CreateHostMembershipInput);
    expect(
      ReplaceMembershipRolesInput.make({
        hostId: "host-1",
        principalId: PrincipalIds.fromFixedLocalIdentity("principal-1"),
        roleIds: [HostRoleId.make("123e4567-e89b-42d3-a456-426614174000")],
      }),
    ).toBeInstanceOf(ReplaceMembershipRolesInput);
    expect(
      GetHostRoleInput.make({
        roleId: HostRoleId.make("123e4567-e89b-42d3-a456-426614174000"),
      }),
    ).toBeInstanceOf(GetHostRoleInput);
    expect(
      ListHostRolesInput.make({
        limit: Pagination.PageSize.make(10),
        cursor: Option.none(),
      }),
    ).toBeInstanceOf(ListHostRolesInput);
  });

  /**
   * Proves successes are the shared domain values themselves — registered
   * hosts, member access, roles — with no transport-style result wrappers.
   */
  it("keeps operation successes as domain values instead of wrapper DTOs", () => {
    expect(host("host-1")).toBeInstanceOf(RegisteredHost);
    expect(access("host-1", "user-1")).toBeInstanceOf(HostMemberAccess);
    expect(
      HostRole.make({
        roleId: HostRoleId.make("550e8400-e29b-41d4-a716-446655440000"),
        name: "Member",
        permissions: [HostPermissions.host.read],
      }),
    ).toBeInstanceOf(HostRole);
  });
});

/**
 * Diagnostics publish the exact operation vocabulary: invariant violations
 * and store errors round-trip their fields, and unknown operations fail
 * decoding instead of widening the runtime discriminator set.
 */
describe("host access errors", () => {
  /**
   * Proves the runtime operation vocabulary matches the service verbs
   * exactly, keeping diagnostics attributable to a real caller-driven
   * operation.
   */
  it("uses exact runtime operation discriminators", () => {
    expect(HostAccessStoreOperation.literals).toEqual([
      "getRegisteredHost",
      "createOwnedHost",
      "listPrincipalHosts",
      "listRegisteredHosts",
      "resolvePrincipalHostAccess",
      "createMembership",
      "replaceMembershipRoles",
      "getHostRole",
      "listHostRoles",
    ]);
  });

  /**
   * Proves typed errors decode round-trip with their operation fields, and
   * that a non-runtime operation (init-only seeding) fails
   * `HostAccessStoreError` decoding instead of widening the discriminator
   * set.
   */
  it("round-trips exact invariant and store operation fields", () => {
    const invariant = new HostAccessInvariantViolation({
      operation: "createOwnedHost",
      message: "invalid platform result",
    });
    const storeError = new HostAccessStoreError({
      operation: "listPrincipalHosts",
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
        operation: "installBuiltInHostRoles",
        message: "not a runtime store operation",
      }),
    ).toThrow();
  });
});
