/*
 * Credentialed Host HTTP authorization runs through the real HttpApi router.
 *
 * What this proves:
 * 1. Every credentialed route is wrapped by authenticated-caller middleware.
 * 2. Each route admits exactly the named Host permission before discovery.
 * 3. Denial and authorization-store failure are encoded as stable HTTP errors.
 * 4. OAuth callback routing is outside ordinary Host authentication.
 *
 * Effect's in-memory HttpApi client supplies real request encoding, routing,
 * middleware, handler execution, and error decoding. Only platform credential
 * proof, authorization persistence, ingress origin, and actor discovery are
 * faked; those fakes expose counters at the boundaries this test observes.
 */
import {
  HostAccessStoreError,
  HostPermissions,
  type HostPermission,
  PrincipalCaller,
  PrincipalIds,
} from "@ptools/host-authorization/contracts";
import { Authorization } from "@ptools/host-authorization/effect";
import { UserPtoolsConfig } from "@ptools/config/contracts";
import { Effect, HashSet, Layer, Option } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { HttpApiClient, HttpApiTest } from "effect/unstable/httpapi";
import { describe, expect, it } from "vitest";
import {
  CredentialedHostApiHandlers,
  HostHttpApi,
  OAuthBrowserHandlers,
  HostHttpForbidden,
  HostHttpHostUnavailable,
  HostHttpInternalError,
} from "../src/http/index.js";
import {
  AuthenticatedHostCallerContext,
  HostApiUnauthorized,
  HostHttpIngress,
  HostHttpOperationAdapterLive,
  HostInstanceDiscovery,
  ProvideHostHttpIngress,
  RequireAuthenticatedHostCaller,
} from "../src/services/index.js";
import {
  CompleteHostMcpOAuthCallbackResponse,
  HostOperationProtocolFailureResponse,
} from "../src/contracts/index.js";

const principalCaller = PrincipalCaller.make({
  principalId: PrincipalIds.fromFixedLocalIdentity("http-test-principal"),
});

type HostApiTestClient = HttpApiClient.ForApi<typeof HostHttpApi>;

const routeCases: ReadonlyArray<{
  readonly name: string;
  readonly permission: HostPermission;
  readonly call: (client: HostApiTestClient) => Effect.Effect<unknown, unknown>;
}> = [
  {
    name: "code mode",
    permission: HostPermissions.host.execute,
    call: (client) =>
      client["host.api"].codeMode({
        params: { hostId: "host-1" },
        payload: { operation: "search_providers" },
      }),
  },
  {
    name: "configuration",
    permission: HostPermissions.host.configure,
    call: (client) =>
      client["host.api"].configure({
        params: { hostId: "host-1" },
        payload: {
          config: UserPtoolsConfig.make({
            mcpServers: {},
            executor: Option.none(),
          }),
        },
      }),
  },
  {
    name: "secret management",
    permission: HostPermissions.secrets.manage,
    call: (client) =>
      client["host.api"].configureSecrets({
        params: { hostId: "host-1" },
        payload: { secrets: {} },
      }),
  },
  {
    name: "auth status",
    permission: HostPermissions.auth.read,
    call: (client) =>
      client["host.api"].mcpAuthStatus({
        params: { hostId: "host-1" },
        payload: {},
      }),
  },
  {
    name: "auth management",
    permission: HostPermissions.auth.manage,
    call: (client) =>
      client["host.api"].startMcpAuth({
        params: { hostId: "host-1", serverName: "github" },
        payload: {},
      }),
  },
];

describe("credentialed Host HTTP authorization", () => {
  for (const route of routeCases) {
    it(`${route.name} requires its named policy before discovery`, async () => {
      let authenticationCount = 0;
      let discoveryCount = 0;
      const client = await Effect.runPromise(
        makeCredentialedClient({
          resolvePermissions: Effect.succeed(HashSet.make(route.permission)),
          onAuthentication: () => authenticationCount++,
          onDiscovery: () => discoveryCount++,
        }),
      );

      const admittedFailure = await Effect.runPromise(
        route.call(client).pipe(Effect.flip),
      );
      expect(admittedFailure).toBeInstanceOf(HostHttpHostUnavailable);
      expect(authenticationCount).toBe(routeCases.length);
      expect(discoveryCount).toBe(1);

      const deniedClient = await Effect.runPromise(
        makeCredentialedClient({
          resolvePermissions: Effect.succeed(HashSet.empty()),
          onAuthentication: () => authenticationCount++,
          onDiscovery: () => discoveryCount++,
        }),
      );
      const deniedFailure = await Effect.runPromise(
        route.call(deniedClient).pipe(Effect.flip),
      );
      expect(deniedFailure).toBeInstanceOf(HostHttpForbidden);
      expect(authenticationCount).toBe(routeCases.length * 2);
      expect(discoveryCount).toBe(1);
    });
  }

  it("returns 401 from authentication before authorization or discovery", async () => {
    let discoveryCount = 0;
    const client = await Effect.runPromise(
      makeCredentialedClient({
        authentication: "deny",
        resolvePermissions: Effect.die("authorization must not run"),
        onDiscovery: () => discoveryCount++,
      }),
    );

    const failure = await Effect.runPromise(
      client["host.api"]
        .mcpAuthStatus({
          params: { hostId: "host-1" },
          payload: {},
        })
        .pipe(Effect.flip),
    );

    expect(failure).toBeInstanceOf(HostApiUnauthorized);
    expect(discoveryCount).toBe(0);
  });

  it("keeps OAuth callbacks outside ordinary Host authentication", async () => {
    let authenticationCount = 0;
    let discoveryCount = 0;
    const client = await Effect.runPromise(
      makeOAuthClient({
        onAuthentication: () => authenticationCount++,
        onDiscovery: () => discoveryCount++,
      }),
    );

    const html = await Effect.runPromise(
      client["host.oauth"].completeOAuthCallbackGet({
        params: { hostId: "host-1", provider: "github" },
      }),
    );

    expect(html).toBe("<p>callback state accepted</p>");
    expect(authenticationCount).toBe(routeCases.length);
    expect(discoveryCount).toBe(1);
  });

  it("projects authorization persistence failure to 500 before discovery", async () => {
    let discoveryCount = 0;
    const client = await Effect.runPromise(
      makeCredentialedClient({
        resolvePermissions: Effect.fail(
          new HostAccessStoreError({
            operation: "resolvePrincipalHostAccess",
            message: "database unavailable",
          }),
        ),
        onDiscovery: () => discoveryCount++,
      }),
    );

    const failure = await Effect.runPromise(
      client["host.api"]
        .mcpAuthStatus({
          params: { hostId: "host-1" },
          payload: {},
        })
        .pipe(Effect.flip),
    );

    expect(failure).toBeInstanceOf(HostHttpInternalError);
    expect(discoveryCount).toBe(0);
  });
});

const makeOAuthClient = (options: {
  readonly onAuthentication: () => void;
  readonly onDiscovery: () => void;
}) => {
  const discovery = Layer.succeed(HostInstanceDiscovery, {
    resolve: () =>
      Effect.sync(() => {
        options.onDiscovery();
        return {
          dispatch: () =>
            Effect.succeed(
              CompleteHostMcpOAuthCallbackResponse.make({
                operation: "complete_mcp_oauth_callback",
                result: {
                  ok: true,
                  response: {
                    status: 200,
                    headers: { "content-type": "text/html" },
                    body: "<p>callback state accepted</p>",
                  },
                },
              }),
            ),
        };
      }),
  });
  const adapter = HostHttpOperationAdapterLive.pipe(Layer.provide(discovery));
  const rejectOrdinaryAuthentication = Layer.succeed(
    RequireAuthenticatedHostCaller,
    (_effect) => {
      options.onAuthentication();
      return Effect.fail(
        new HostApiUnauthorized({ message: "must not guard OAuth callback" }),
      );
    },
  );
  const ingress = Layer.succeed(ProvideHostHttpIngress, (effect) =>
    Effect.provideService(effect, HostHttpIngress, {
      publicOrigin: "https://ptools.example",
    }),
  );
  const handlers = OAuthBrowserHandlers.pipe(
    Layer.provide(adapter),
    HttpRouter.provideRequest(adapter),
    Layer.provideMerge(Layer.mergeAll(rejectOrdinaryAuthentication, ingress)),
  );

  return HttpApiTest.groups(HostHttpApi, ["host.oauth"]).pipe(
    Effect.provide(Layer.mergeAll(handlers, HttpServer.layerServices)),
    Effect.scoped,
  );
};

const makeCredentialedClient = (options: {
  readonly authentication?: "allow" | "deny";
  readonly resolvePermissions: Effect.Effect<
    HashSet.HashSet<HostPermission>,
    HostAccessStoreError
  >;
  readonly onAuthentication?: () => void;
  readonly onDiscovery: () => void;
}) => {
  const authorization = Layer.succeed(
    Authorization,
    Authorization.of({
      resolveControlPlanePermissions: () => Effect.succeed(HashSet.empty()),
      resolveHostPermissions: (_principal, hostId) =>
        hostId === "host-1"
          ? options.resolvePermissions
          : Effect.die("handler authorized the wrong route Host"),
    }),
  );
  const discovery = Layer.succeed(HostInstanceDiscovery, {
    resolve: () =>
      Effect.sync(() => {
        options.onDiscovery();
        return {
          dispatch: () =>
            Effect.succeed(
              HostOperationProtocolFailureResponse.make({
                error: {
                  code: "host_unavailable",
                  message: "observed admitted dispatch",
                },
              }),
            ),
        };
      }),
  });
  const adapter = HostHttpOperationAdapterLive.pipe(Layer.provide(discovery));
  const authenticate = Layer.succeed(
    RequireAuthenticatedHostCaller,
    (effect) => {
      options.onAuthentication?.();
      return options.authentication === "deny"
        ? Effect.fail(
            new HostApiUnauthorized({ message: "authentication failed" }),
          )
        : Effect.provideService(effect, AuthenticatedHostCallerContext, {
            _tag: "Principal",
            caller: principalCaller,
          });
    },
  );
  const ingress = Layer.succeed(ProvideHostHttpIngress, (effect) =>
    Effect.provideService(effect, HostHttpIngress, {
      publicOrigin: "https://ptools.example",
    }),
  );
  const requestServices = Layer.mergeAll(adapter, authorization);
  const handlers = CredentialedHostApiHandlers.pipe(
    Layer.provide(requestServices),
    HttpRouter.provideRequest(requestServices),
    Layer.provideMerge(Layer.mergeAll(authenticate, ingress)),
  );

  return HttpApiTest.groups(HostHttpApi, ["host.api"]).pipe(
    Effect.provide(Layer.mergeAll(handlers, HttpServer.layerServices)),
    Effect.scoped,
  );
};
