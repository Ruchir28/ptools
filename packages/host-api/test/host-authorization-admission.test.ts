/*
 * Shared decoded Host-admission coverage.
 *
 * What this proves:
 * 1. Principal callers resolve current registered-Host authority before policy.
 * 2. Verified Host tokens require a registered exact route Host before policy.
 * 3. Equal grants produce equal policy decisions for both caller kinds.
 * 4. Registration, denial, and Principal-only rejection stop protected work.
 *
 * The real admission combinators, request context, and policies are used. Only
 * Principal role resolution and Host registration persistence are faked; no
 * HTTP server, database, token plaintext, Node process, or Cloudflare Worker
 * participates.
 */
import {
  ControlPlanePermissions,
  HostAccessStoreError,
  HostPermissions,
  HostTokenCaller,
  HostTokenId,
  HostTokenPermissionSelection,
  Principal,
  PrincipalId,
  PrincipalIds,
  PrincipalCaller,
  RegisteredHost,
  RegisteredHostNotFound,
  VerifiedHostToken,
} from "@ptools/host-authorization/contracts";
import {
  Authorization,
  HostAccessStore,
  HostPolicies,
} from "@ptools/host-authorization/effect";
import { Effect, HashSet, Layer } from "effect";
import { describe, expect, it } from "vitest";
import {
  AuthenticatedHostCallerContext,
  HostTokenRouteMismatch,
  PrincipalCallerRequired,
  withControlPlaneAuthorization,
  withHostAuthorization,
  withPrincipalHostAuthorization,
} from "../src/services/hostAuthorizationAdmission.js";
import {
  HostHttpIngress,
  HostHttpOperationAdapter,
  HostHttpOperationAdapterLive,
  HostInstanceDiscovery,
} from "../src/services/index.js";

const principalId = PrincipalIds.fromFixedLocalIdentity("principal-1");
const principalCaller = PrincipalCaller.make({ principalId });
const tokenId = HostTokenId.make("00010203-0405-4607-8809-0a0b0c0d0e0f");
const verifiedTokenFor = (hostId: string) =>
  VerifiedHostToken.make({
    principal: HostTokenCaller.make({ tokenId, hostId }),
    effectivePermissions: HostTokenPermissionSelection.make([
      HostPermissions.host.execute,
    ]),
  });
const verifiedToken = verifiedTokenFor("host-1");

const registeredHost = RegisteredHost.make({
  hostId: "host-1",
  createdAtEpochMs: 1,
});
const unexpectedHostAccessOperation = () =>
  Effect.die("unexpected HostAccessStore operation");
const registeredHostAccessStore = HostAccessStore.of({
  getRegisteredHost: ({ hostId }) =>
    hostId === registeredHost.hostId
      ? Effect.succeed(registeredHost)
      : Effect.fail(
          new RegisteredHostNotFound({
            hostId,
            message: "registered Host was not found",
          }),
        ),
  createOwnedHost: unexpectedHostAccessOperation,
  listPrincipalHosts: unexpectedHostAccessOperation,
  listRegisteredHosts: unexpectedHostAccessOperation,
  resolvePrincipalHostAccess: unexpectedHostAccessOperation,
  createMembership: unexpectedHostAccessOperation,
  replaceMembershipRoles: unexpectedHostAccessOperation,
  getHostRole: unexpectedHostAccessOperation,
  listHostRoles: unexpectedHostAccessOperation,
});

const authorization = Authorization.of({
  resolveControlPlanePermissions: () =>
    Effect.succeed(HashSet.make(ControlPlanePermissions.hosts.create)),
  resolveHostPermissions: (principal: Principal, hostId: string) => {
    expect(principal.principalId).toBe(principalId);
    expect(hostId).toBe("host-1");
    return Effect.succeed(HashSet.make(HostPermissions.host.execute));
  },
});

const run = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    Authorization | AuthenticatedHostCallerContext | HostAccessStore
  >,
  caller: AuthenticatedHostCallerContext["Service"],
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provideService(Authorization, authorization),
      Effect.provideService(HostAccessStore, registeredHostAccessStore),
      Effect.provideService(AuthenticatedHostCallerContext, caller),
    ),
  );

const discoveryLayer = (onResolve: () => void) =>
  Layer.succeed(HostInstanceDiscovery, {
    resolve: () =>
      Effect.sync(() => {
        onResolve();
        return {
          dispatch: () =>
            Effect.succeed({
              operation: "mcp_auth_status" as const,
              result: {
                ok: true as const,
                status: { authUrl: "https://ptools.example/auth", servers: [] },
              },
            }),
        };
      }),
  });

const authorizedStatusDispatch = (hostId = "host-1") =>
  withHostAuthorization({ hostId, policy: HostPolicies.execute }, () =>
    Effect.flatMap(HostHttpOperationAdapter, (adapter) =>
      adapter.mcpAuthStatus({ params: { hostId } }),
    ),
  );

describe("Host authorization admission", () => {
  it("normalizes Principal and token authority into the same policy result", async () => {
    const operation = () =>
      withHostAuthorization(
        { hostId: "host-1", policy: HostPolicies.execute },
        () => Effect.succeed("started"),
      );

    await expect(
      run(operation(), { _tag: "Principal", caller: principalCaller }),
    ).resolves.toBe("started");
    await expect(
      run(operation(), { _tag: "HostToken", token: verifiedToken }),
    ).resolves.toBe("started");
  });

  it("rejects cross-Host token use before Host discovery", async () => {
    let discoveryCount = 0;
    const failure = await Effect.runPromise(
      authorizedStatusDispatch("other-host").pipe(
        Effect.provideService(Authorization, authorization),
        Effect.provideService(HostAccessStore, registeredHostAccessStore),
        Effect.provideService(AuthenticatedHostCallerContext, {
          _tag: "HostToken",
          token: verifiedToken,
        }),
        Effect.provideService(HostHttpIngress, {
          publicOrigin: "https://ptools.example",
        }),
        Effect.provide(
          HostHttpOperationAdapterLive.pipe(
            Layer.provide(discoveryLayer(() => discoveryCount++)),
          ),
        ),
        Effect.flip,
      ),
    );

    expect(failure).toBeInstanceOf(HostTokenRouteMismatch);
    expect(discoveryCount).toBe(0);
  });

  it("rejects a matching Host token when its route Host is not registered", async () => {
    let discoveryCount = 0;
    const hostId = "unregistered-host";

    const failure = await Effect.runPromise(
      authorizedStatusDispatch(hostId).pipe(
        Effect.provideService(Authorization, authorization),
        Effect.provideService(HostAccessStore, registeredHostAccessStore),
        Effect.provideService(AuthenticatedHostCallerContext, {
          _tag: "HostToken",
          token: verifiedTokenFor(hostId),
        }),
        Effect.provideService(HostHttpIngress, {
          publicOrigin: "https://ptools.example",
        }),
        Effect.provide(
          HostHttpOperationAdapterLive.pipe(
            Layer.provide(discoveryLayer(() => discoveryCount++)),
          ),
        ),
        Effect.flip,
      ),
    );

    expect(failure).toBeInstanceOf(RegisteredHostNotFound);
    expect(discoveryCount).toBe(0);
  });

  it("does not discover a Host when the Principal lacks the route permission", async () => {
    let discoveryCount = 0;
    const deniedAuthorization = Authorization.of({
      ...authorization,
      resolveHostPermissions: () => Effect.succeed(HashSet.empty()),
    });

    const failure = await Effect.runPromise(
      authorizedStatusDispatch().pipe(
        Effect.provideService(Authorization, deniedAuthorization),
        Effect.provideService(HostAccessStore, registeredHostAccessStore),
        Effect.provideService(AuthenticatedHostCallerContext, {
          _tag: "Principal",
          caller: principalCaller,
        }),
        Effect.provideService(HostHttpIngress, {
          publicOrigin: "https://ptools.example",
        }),
        Effect.provide(
          HostHttpOperationAdapterLive.pipe(
            Layer.provide(discoveryLayer(() => discoveryCount++)),
          ),
        ),
        Effect.flip,
      ),
    );

    expect(failure).toMatchObject({ _tag: "HostAuthorizationDenied" });
    expect(discoveryCount).toBe(0);
  });

  it("keeps authorization storage failure distinct and stops before discovery", async () => {
    let discoveryCount = 0;
    const failedAuthorization = Authorization.of({
      ...authorization,
      resolveHostPermissions: () =>
        Effect.fail(
          new HostAccessStoreError({
            operation: "resolvePrincipalHostAccess",
            message: "database unavailable",
          }),
        ),
    });

    const failure = await Effect.runPromise(
      authorizedStatusDispatch().pipe(
        Effect.provideService(Authorization, failedAuthorization),
        Effect.provideService(HostAccessStore, registeredHostAccessStore),
        Effect.provideService(AuthenticatedHostCallerContext, {
          _tag: "Principal",
          caller: principalCaller,
        }),
        Effect.provideService(HostHttpIngress, {
          publicOrigin: "https://ptools.example",
        }),
        Effect.provide(
          HostHttpOperationAdapterLive.pipe(
            Layer.provide(discoveryLayer(() => discoveryCount++)),
          ),
        ),
        Effect.flip,
      ),
    );

    expect(failure).toBeInstanceOf(HostAccessStoreError);
    expect(discoveryCount).toBe(0);
  });

  it("discovers and dispatches exactly once after successful admission", async () => {
    let discoveryCount = 0;

    const response = await Effect.runPromise(
      authorizedStatusDispatch().pipe(
        Effect.provideService(Authorization, authorization),
        Effect.provideService(HostAccessStore, registeredHostAccessStore),
        Effect.provideService(AuthenticatedHostCallerContext, {
          _tag: "Principal",
          caller: principalCaller,
        }),
        Effect.provideService(HostHttpIngress, {
          publicOrigin: "https://ptools.example",
        }),
        Effect.provide(
          HostHttpOperationAdapterLive.pipe(
            Layer.provide(discoveryLayer(() => discoveryCount++)),
          ),
        ),
      ),
    );

    expect(response).toMatchObject({
      operation: "mcp_auth_status",
      result: { ok: true },
    });
    expect(discoveryCount).toBe(1);
  });

  it("admits current Principal Control Plane authority and rejects tokens", async () => {
    await expect(
      run(
        withControlPlaneAuthorization(
          ControlPlanePermissions.hosts.create,
          () => Effect.succeed("created"),
        ),
        { _tag: "Principal", caller: principalCaller },
      ),
    ).resolves.toBe("created");

    await expect(
      run(
        withControlPlaneAuthorization(
          ControlPlanePermissions.hosts.create,
          () => Effect.succeed("must-not-run"),
        ).pipe(Effect.flip),
        { _tag: "HostToken", token: verifiedToken },
      ),
    ).resolves.toBeInstanceOf(PrincipalCallerRequired);
  });

  it("rejects a Host token at a Principal-caller-only lifecycle seam", async () => {
    let started = false;
    const failure = await run(
      withPrincipalHostAuthorization(
        { hostId: "host-1", policy: HostPolicies.manageTokens },
        () => Effect.sync(() => (started = true)),
      ).pipe(Effect.flip),
      { _tag: "HostToken", token: verifiedToken },
    );

    expect(failure).toBeInstanceOf(PrincipalCallerRequired);
    expect(started).toBe(false);
  });
});
