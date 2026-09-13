/*
 * The Control Center crosses a browser-authenticated JSON boundary.
 *
 * What this proves:
 * 1. Browser reads and mutations require a verified Principal.
 * 2. auth:read/auth:manage run before Host operation work.
 * 3. Effect owns JSON decoding; no HTML form or presentation query is involved.
 *
 * Effect's in-memory HttpApi client supplies real JSON encoding, routing,
 * middleware, and decoding. Browser proof, authorization persistence, ingress,
 * and actor operations are faked only at their declared service boundaries.
 */
import {
  HostPermissions,
  PrincipalCaller,
  PrincipalIds,
  type HostPermission,
  type VerifiedHostToken,
} from "@ptools/host-authorization/contracts";
import {
  Authorization,
  HostAccessStore,
} from "@ptools/host-authorization/effect";
import { Effect, HashSet, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { HttpApiClient, HttpApiTest } from "effect/unstable/httpapi";
import { describe, expect, it } from "vitest";
import {
  BrowserHostAuthMutationHandlers,
  BrowserHostAuthReadHandlers,
  HostHttpApi,
  HostHttpForbidden,
} from "../src/http/index.js";
import {
  AuthenticatedHostCallerContext,
  HostApiUnauthorized,
  HostHttpIngress,
  HostHttpOperationAdapter,
  ProvideHostHttpIngress,
  RequireAuthenticatedBrowserPrincipal,
  RequireAuthenticatedHostCaller,
} from "../src/services/index.js";

const caller = PrincipalCaller.make({
  principalId: PrincipalIds.fromFixedLocalIdentity("browser-api-test"),
});
const statusResponse = {
  operation: "mcp_auth_status" as const,
  result: {
    ok: true as const,
    status: {
      authUrl: "https://ptools.example/hosts/host-1/auth",
      servers: [
        {
          serverName: "github",
          jsServerName: "github",
          transport: "http" as const,
          status: "requires_auth" as const,
          authorizeUrl:
            "https://ptools.example/hosts/host-1/auth?server=github&intent=authorize",
        },
      ],
    },
  },
};

type BrowserClient = HttpApiClient.ForApi<typeof HostHttpApi>;

describe("browser Host JSON API", () => {
  it("authorizes a status read without starting provider work", async () => {
    let statusCount = 0;
    let startCount = 0;
    const client = await Effect.runPromise(
      makeClient({
        permissions: HashSet.make(HostPermissions.auth.read),
        onStatus: () => statusCount++,
        onStart: () => startCount++,
      }),
    );

    const response = await Effect.runPromise(
      client["host.browser.auth.read"].mcpAuthStatus({
        params: { hostId: "host-1" },
      }),
    );

    expect(response).toEqual(statusResponse);
    expect(statusCount).toBe(1);
    expect(startCount).toBe(0);
  });

  it("decodes JSON start payloads and passes their typed force value", async () => {
    const observed: Array<boolean | undefined> = [];
    const client = await Effect.runPromise(
      makeClient({
        permissions: HashSet.make(HostPermissions.auth.manage),
        onStart: (force) => observed.push(force),
      }),
    );

    await Effect.runPromise(
      client["host.browser.auth.mutation"].startMcpAuth({
        params: { hostId: "host-1", serverName: "github" },
        payload: {},
      }),
    );
    await Effect.runPromise(
      client["host.browser.auth.mutation"].startMcpAuth({
        params: { hostId: "host-1", serverName: "github" },
        payload: { force: true },
      }),
    );

    expect(observed).toEqual([undefined, true]);
  });

  it("rejects browser authentication before authorization and status", async () => {
    let authorizationCount = 0;
    let statusCount = 0;
    const client = await Effect.runPromise(
      makeClient({
        authentication: "deny",
        permissions: HashSet.make(HostPermissions.auth.read),
        onAuthorization: () => authorizationCount++,
        onStatus: () => statusCount++,
      }),
    );

    const failure = await Effect.runPromise(
      client["host.browser.auth.read"]
        .mcpAuthStatus({ params: { hostId: "host-1" } })
        .pipe(Effect.flip),
    );

    expect(failure).toBeInstanceOf(HostApiUnauthorized);
    expect(authorizationCount).toBe(0);
    expect(statusCount).toBe(0);
  });

  it("rejects a Host-token context before authorization and status", async () => {
    let authorizationCount = 0;
    let statusCount = 0;
    const client = await Effect.runPromise(
      makeClient({
        callerKind: "host-token",
        permissions: HashSet.make(HostPermissions.auth.read),
        onAuthorization: () => authorizationCount++,
        onStatus: () => statusCount++,
      }),
    );

    const failure = await Effect.runPromise(
      client["host.browser.auth.read"]
        .mcpAuthStatus({ params: { hostId: "host-1" } })
        .pipe(Effect.flip),
    );

    expect(failure).toBeInstanceOf(HostHttpForbidden);
    expect(authorizationCount).toBe(0);
    expect(statusCount).toBe(0);
  });

  it("applies auth:read and auth:manage before their operations", async () => {
    let statusCount = 0;
    let startCount = 0;
    const client = await Effect.runPromise(
      makeClient({
        permissions: HashSet.empty(),
        onStatus: () => statusCount++,
        onStart: () => startCount++,
      }),
    );

    const readFailure = await Effect.runPromise(
      client["host.browser.auth.read"]
        .mcpAuthStatus({ params: { hostId: "host-1" } })
        .pipe(Effect.flip),
    );
    const mutationFailure = await Effect.runPromise(
      client["host.browser.auth.mutation"]
        .startMcpAuth({
          params: { hostId: "host-1", serverName: "github" },
          payload: { force: false },
        })
        .pipe(Effect.flip),
    );

    expect(readFailure).toBeInstanceOf(HostHttpForbidden);
    expect(mutationFailure).toBeInstanceOf(HostHttpForbidden);
    expect(statusCount).toBe(0);
    expect(startCount).toBe(0);
  });
});

interface TestOptions {
  readonly authentication?: "allow" | "deny";
  readonly callerKind?: "principal" | "host-token";
  readonly permissions: HashSet.HashSet<HostPermission>;
  readonly onAuthorization?: () => void;
  readonly onStatus?: () => void;
  readonly onStart?: (force: boolean | undefined) => void;
}

const makeClient = (
  options: TestOptions,
): Effect.Effect<BrowserClient, never, never> => {
  const authorization = Layer.succeed(
    Authorization,
    Authorization.of({
      resolveControlPlanePermissions: () => Effect.succeed(HashSet.empty()),
      resolveHostPermissions: () =>
        Effect.sync(() => {
          options.onAuthorization?.();
          return options.permissions;
        }),
    }),
  );
  const unexpected = () => Effect.die("unexpected browser Host operation");
  const adapter = Layer.succeed(
    HostHttpOperationAdapter,
    HostHttpOperationAdapter.of({
      codeMode: unexpected,
      configure: unexpected,
      configureSecrets: unexpected,
      completeMcpOAuthCallback: unexpected,
      mcpAuthStatus: () =>
        Effect.sync(() => {
          options.onStatus?.();
          return statusResponse;
        }),
      startMcpAuth: (ctx) =>
        Effect.sync(() => {
          options.onStart?.(ctx.payload.force);
          return {
            operation: "start_mcp_auth" as const,
            result: {
              ok: true as const,
              authorizeUrl: "https://provider.example/oauth/authorize",
            },
          };
        }),
    }),
  );
  const authenticated = () =>
    options.callerKind === "host-token"
      ? {
          _tag: "HostToken" as const,
          token: {} as VerifiedHostToken,
        }
      : { _tag: "Principal" as const, caller };
  const authenticate = Layer.succeed(
    RequireAuthenticatedBrowserPrincipal,
    (effect) =>
      options.authentication === "deny"
        ? Effect.fail(
            new HostApiUnauthorized({ message: "authentication failed" }),
          )
        : Effect.provideService(
            effect,
            AuthenticatedHostCallerContext,
            authenticated(),
          ),
  );
  const ingress = Layer.succeed(ProvideHostHttpIngress, (effect) =>
    Effect.provideService(effect, HostHttpIngress, {
      publicOrigin: "https://ptools.example",
    }),
  );
  const unexpectedHostAccess = () =>
    Effect.die("browser Principal admission must not use HostAccessStore");
  const hostAccess = Layer.succeed(
    HostAccessStore,
    HostAccessStore.of({
      getRegisteredHost: unexpectedHostAccess,
      createOwnedHost: unexpectedHostAccess,
      listPrincipalHosts: unexpectedHostAccess,
      listRegisteredHosts: unexpectedHostAccess,
      resolvePrincipalHostAccess: unexpectedHostAccess,
      createMembership: unexpectedHostAccess,
      replaceMembershipRoles: unexpectedHostAccess,
      getHostRole: unexpectedHostAccess,
      listHostRoles: unexpectedHostAccess,
    }),
  );
  const requestServices = Layer.mergeAll(adapter, authorization, hostAccess);
  const handlers = Layer.mergeAll(
    BrowserHostAuthReadHandlers,
    BrowserHostAuthMutationHandlers,
  ).pipe(
    Layer.provide(requestServices),
    HttpRouter.provideRequest(requestServices),
    Layer.provideMerge(Layer.mergeAll(authenticate, ingress)),
  );

  const unusedMachineAuthentication = Layer.succeed(
    RequireAuthenticatedHostCaller,
    (effect) =>
      Effect.provideService(effect, AuthenticatedHostCallerContext, {
        _tag: "Principal",
        caller,
      }),
  );

  return HttpApiTest.groups(HostHttpApi, [
    "host.browser.auth.read",
    "host.browser.auth.mutation",
  ]).pipe(
    Effect.provide(
      Layer.mergeAll(
        handlers,
        HttpServer.layerServices,
        unusedMachineAuthentication,
      ),
    ),
    Effect.scoped,
  );
};
