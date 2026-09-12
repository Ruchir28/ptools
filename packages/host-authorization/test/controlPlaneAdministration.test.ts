/*
 * Shared Control Plane administration workflow coverage.
 *
 * What this proves:
 * 1. Host creation injects the admitted Principal as Owner rather than trusting
 *    caller-authored JSON.
 * 2. Administrators list every registered Host while ordinary Principals list
 *    only their assigned Hosts.
 * 3. Administrator Host authority still requires a registered Host, without
 *    adding a duplicate existence read to ordinary membership resolution.
 *
 * The package-owned administration Layer is real. Both persistence ports are
 * semantic in-memory fakes; no HTTP, SQLite, D1, Node, or Worker code is used.
 */
import {
  BuiltInControlPlaneRoles,
  CreateRegisteredHostInput,
  CreatedOwnedHost,
  HostMemberAccess,
  HostPermission,
  HostPermissions,
  HostRole,
  HostRoleId,
  Principal,
  PrincipalControlPlaneAccess,
  PrincipalIds,
  PrincipalCaller,
  RegisteredHost,
  RegisteredHostNotFound,
  ReplaceControlPlaneRolesInput,
  ReplacePrincipalControlPlaneRolesInput,
} from "../src/contracts/index.js";
import {
  Authorization,
  ControlPlaneAccessStore,
  ControlPlaneAdministration,
  HostAccessStore,
} from "../src/services/index.js";
import { Effect, HashSet, Layer } from "effect";
import { describe, expect, it } from "vitest";

const administratorId = PrincipalIds.fromFixedLocalIdentity("administrator");
const memberId = PrincipalIds.fromFixedLocalIdentity("member");
const allHost = RegisteredHost.make({
  hostId: "all-host",
  createdAtEpochMs: 1,
});
const memberHost = RegisteredHost.make({
  hostId: "member-host",
  createdAtEpochMs: 2,
});

/**
 * Semantic in-memory Control Plane store fake. Permission resolution is real
 * enough to distinguish the Administrator from an unprivileged Principal;
 * mutations the workflows under test must never reach die loudly, so a silent
 * dependency on them cannot masquerade as a passing assertion.
 */
// Records the trusted command the administration service built, so tests can
// prove the audit assigner came from the admitted caller argument and not from
// caller-authored payload fields.
let replacedRolesCommand: ReplacePrincipalControlPlaneRolesInput | undefined;

const controlPlaneStore = ControlPlaneAccessStore.of({
  initialize: () => Effect.succeed(false),
  ensurePrincipal: (principal) => Effect.succeed(principal),
  getClaimStatus: () => Effect.die("unused"),
  claimInitialAdministrator: () => Effect.die("unused"),
  resolvePermissions: (input) =>
    Effect.succeed(
      PrincipalControlPlaneAccess.make({
        principalId: input.principalId,
        effectivePermissions:
          input.principalId === administratorId
            ? [...BuiltInControlPlaneRoles.administrator.permissions]
            : [],
      }),
    ),
  replaceRoles: (input) => {
    replacedRolesCommand = input;
    return Effect.succeed(
      PrincipalControlPlaneAccess.make({
        principalId: input.principalId,
        effectivePermissions: [
          ...BuiltInControlPlaneRoles.administrator.permissions,
        ],
      }),
    );
  },
});

let createdOwner = memberId;
const ownerAccess = (hostId: string, principalId = memberId) =>
  HostMemberAccess.make({
    hostId,
    principalId,
    effectivePermissions: [HostPermissions.host.read],
  });

const role = HostRole.make({
  roleId: HostRoleId.make("550e8400-e29b-41d4-a716-446655440000"),
  name: "Member",
  permissions: [HostPermissions.host.read],
});

/**
 * Semantic in-memory Host access store fake. `createOwnedHost` records the
 * owner it was handed so assertions can prove the administration service —
 * not caller-authored JSON — decided the created-by identity.
 */
let registeredHostReadCount = 0;
let membershipResolutionCount = 0;
const hostStore = HostAccessStore.of({
  getRegisteredHost: ({ hostId }) => {
    registeredHostReadCount++;
    const host = [allHost, memberHost].find(
      (candidate) => candidate.hostId === hostId,
    );
    return host === undefined
      ? Effect.fail(
          new RegisteredHostNotFound({
            hostId,
            message: "registered Host was not found",
          }),
        )
      : Effect.succeed(host);
  },
  createOwnedHost: (input) => {
    createdOwner = input.ownerPrincipalId;
    const host = RegisteredHost.make({
      hostId: input.requestedHostId,
      createdAtEpochMs: 3,
    });
    return Effect.succeed(
      CreatedOwnedHost.make({
        host,
        ownerAccess: ownerAccess(host.hostId, input.ownerPrincipalId),
      }),
    );
  },
  listPrincipalHosts: () => Effect.succeed([memberHost]),
  listRegisteredHosts: () => Effect.succeed([allHost, memberHost]),
  resolvePrincipalHostAccess: () => {
    membershipResolutionCount++;
    return Effect.succeed(ownerAccess("all-host"));
  },
  createMembership: () => Effect.succeed(ownerAccess("all-host")),
  replaceMembershipRoles: () => Effect.succeed(ownerAccess("all-host")),
  getHostRole: () => Effect.succeed(role),
  listHostRoles: () => Effect.succeed([role]),
});

const dependencies = Layer.merge(
  Layer.succeed(ControlPlaneAccessStore, controlPlaneStore),
  Layer.succeed(HostAccessStore, hostStore),
);
const live = ControlPlaneAdministration.layer.pipe(Layer.provide(dependencies));
const authorizationLive = Authorization.layer.pipe(Layer.provide(dependencies));

/** Supplies the package-owned administration Layer and runs the program. */
const run = <A, E>(effect: Effect.Effect<A, E, ControlPlaneAdministration>) =>
  Effect.runPromise(effect.pipe(Effect.provide(live)));

/**
 * Workflow coverage where the administration service owns trusted identity
 * injection and listing scope, and `Authorization` owns the
 * Administrator-override versus exact-membership resolution split.
 */
describe("ControlPlaneAdministration", () => {
  /**
   * Proves `createHost` stamps the admitted caller (not payload JSON) as the
   * created-by owner, and that listing scope follows authority:
   * Administrators see every registered Host while ordinary Principals see
   * only their assigned Hosts.
   */
  it("injects creator identity and selects global versus assigned listing", async () => {
    const member = PrincipalCaller.make({ principalId: memberId });
    const administrator = PrincipalCaller.make({
      principalId: administratorId,
    });

    const result = await run(
      Effect.gen(function* () {
        const administration = yield* ControlPlaneAdministration;
        yield* administration.createHost(
          CreateRegisteredHostInput.make({ requestedHostId: "new-host" }),
          member,
        );
        const assigned = yield* administration.listHosts(member);
        const all = yield* administration.listHosts(administrator);
        return { assigned, all };
      }),
    );

    expect(createdOwner).toBe(memberId);
    expect(result.assigned).toEqual([memberHost]);
    expect(result.all).toEqual([allHost, memberHost]);
  });

  /**
   * Proves the trusted command carries `assignedByPrincipalId` from the
   * admission-verified assigner argument while the payload selects only the
   * subject — caller-authored JSON cannot forge audit attribution.
   */
  it("injects the admitted assigner into the trusted role-replacement command", async () => {
    const administrator = PrincipalCaller.make({
      principalId: administratorId,
    });
    const member = PrincipalCaller.make({ principalId: memberId });

    const result = await run(
      Effect.gen(function* () {
        const administration = yield* ControlPlaneAdministration;
        return yield* administration.replaceControlPlaneRoles(
          ReplaceControlPlaneRolesInput.make({
            principalId: member.principalId,
            roleIds: [BuiltInControlPlaneRoles.administrator.roleId],
          }),
          administrator,
        );
      }),
    );

    // Attribution must come from the admission-verified assigner argument; the
    // payload-selected subject stays the target of the replacement. The store
    // owns the last-Administrator law, already covered by the bootstrap suite.
    expect(replacedRolesCommand?.assignedByPrincipalId).toBe(administratorId);
    expect(replacedRolesCommand?.principalId).toBe(memberId);
    expect(result.principalId).toBe(memberId);
  });

  /**
   * Proves `Authorization.resolveHostPermissions` grants the complete Host
   * permission catalog to a Control Plane Administrator only after proving the
   * Host exists. Ordinary Principals continue through membership resolution,
   * which already owns that proof, so the shared service does not add a second
   * registration lookup to their path.
   */
  it("resolves registered Administrator override or exact Principal Host access", async () => {
    registeredHostReadCount = 0;
    membershipResolutionCount = 0;

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const authorization = yield* Authorization;
        const administrator = yield* authorization.resolveHostPermissions(
          Principal.make({ principalId: administratorId }),
          "all-host",
        );
        const member = yield* authorization.resolveHostPermissions(
          Principal.make({ principalId: memberId }),
          "all-host",
        );
        return { administrator, member };
      }).pipe(Effect.provide(authorizationLive)),
    );

    expect(HashSet.size(result.administrator)).toBe(
      HostPermission.literals.length,
    );
    for (const permission of HostPermission.literals) {
      expect(HashSet.has(result.administrator, permission)).toBe(true);
    }
    expect([...result.member]).toEqual([HostPermissions.host.read]);
    expect(registeredHostReadCount).toBe(1);
    expect(membershipResolutionCount).toBe(1);
  });

  it("rejects an Administrator Host override for an unregistered Host", async () => {
    const failure = await Effect.runPromise(
      Effect.gen(function* () {
        const authorization = yield* Authorization;
        return yield* authorization.resolveHostPermissions(
          Principal.make({ principalId: administratorId }),
          "unregistered-host",
        );
      }).pipe(Effect.provide(authorizationLive), Effect.flip),
    );

    expect(failure).toBeInstanceOf(RegisteredHostNotFound);
  });
});
