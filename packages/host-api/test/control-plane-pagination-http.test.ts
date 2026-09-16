/*
 * Control Plane pagination crosses an untrusted HTTP query boundary.
 *
 * Mental model: clients relay opaque cursor strings; each HttpApi route
 * validates and converts its operation-specific cursor before a shared handler
 * may call an authorization service. Responses reverse that transformation and
 * publish an optional continuation string.
 *
 * What this proves:
 * 1. Valid registered-Host and Host-token cursors survive query encoding and
 *    reach their owning services unchanged as validated cursors.
 * 2. Non-empty response cursors survive response encoding and client decoding.
 * 3. A terminal (no-continuation) page round-trips as `Option.none`, and
 *    malformed Host/token cursors return HTTP 400 before domain work starts.
 * 4. An out-of-contract pagination limit (0 or 101) is also rejected with
 *    HTTP 400 before domain work, at the same query-decoding boundary.
 *
 * Effect's in-memory HttpApi pipeline supplies real query encoding, routing,
 * middleware, request decoding, response encoding, and client decoding.
 * Authentication, authorization, and domain services are faked only at their
 * declared service boundaries.
 */
import {
  ControlPlanePermissions,
  HostPermissions,
  HostTokenId,
  HostTokenPageRequest,
  HostTokenPagination,
  ListHostsInput,
  Pagination,
  PrincipalCaller,
  PrincipalIds,
  RegisteredHost,
  RegisteredHostPagination,
} from "@ptools/host-authorization/contracts";
import {
  Authorization,
  ControlPlaneAdministration,
  ControlPlaneBootstrap,
  HostAccessStore,
  HostTokenService,
} from "@ptools/host-authorization/effect";
import { Effect, HashSet, Layer, Option } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import {
  HttpApiBuilder,
  HttpApiClient,
  HttpApiTest,
} from "effect/unstable/httpapi";
import { describe, expect, it } from "vitest";
import {
  ControlPlaneAdministrationHandlers,
  ControlPlaneClaimStatusHandlers,
  ControlPlaneHttpApi,
  HostCredentialAdministrationHandlers,
} from "../src/http/index.js";
import {
  AuthenticatedHostCallerContext,
  RequireAuthenticatedHostCaller,
} from "../src/services/index.js";

const caller = PrincipalCaller.make({
  principalId: PrincipalIds.fromFixedLocalIdentity(
    "control-plane-pagination-http-test",
  ),
});
const host = RegisteredHost.make({
  hostId: "host-b",
  createdAtEpochMs: 10,
});
const hostCursor = RegisteredHostPagination.makeCursor("host-a");
const nextHostCursor = RegisteredHostPagination.makeCursor(host.hostId);
const tokenCursor = HostTokenPagination.makeCursor({
  tokenId: HostTokenId.make("123e4567-e89b-42d3-a456-426614174000"),
  createdAtEpochMs: 10,
});
const nextTokenCursor = HostTokenPagination.makeCursor({
  tokenId: HostTokenId.make("123e4567-e89b-42d3-a456-426614174001"),
  createdAtEpochMs: 10,
});

type ControlPlaneClient = HttpApiClient.ForApi<typeof ControlPlaneHttpApi>;
type ControlPlaneAdministrationShape = Parameters<
  typeof ControlPlaneAdministration.of
>[0];
type HostTokenServiceShape = Parameters<typeof HostTokenService.of>[0];

/**
 * Request-observable service methods supplied by each HTTP boundary test.
 * Listing methods default to empty pages so a test only enables the operation
 * it intends to observe; unrelated mutations and credential lifecycle work die.
 */
interface TestServiceOptions {
  readonly listHosts?: ControlPlaneAdministrationShape["listHosts"];
  readonly listAllTokens?: HostTokenServiceShape["listAll"];
  readonly listTokensByHost?: HostTokenServiceShape["listByHost"];
}

describe("Control Plane pagination HTTP boundary", () => {
  it("relays a valid Host cursor in both request and response directions", async () => {
    let observedCursor: RegisteredHostPagination.Cursor | undefined;
    const client = await Effect.runPromise(
      makeClient({
        listHosts: (input) => {
          observedCursor = Option.getOrUndefined(input.cursor);
          return Effect.succeed(
            RegisteredHostPagination.Page.make({
              items: [host],
              nextCursor: Option.some(nextHostCursor),
            }),
          );
        },
      }),
    );

    const page = await Effect.runPromise(
      client["control-plane.administration"].listHosts({
        query: ListHostsInput.make({
          limit: Pagination.PageSize.make(1),
          cursor: Option.some(hostCursor),
        }),
      }),
    );

    expect(observedCursor).toBe(hostCursor);
    expect(page.items).toEqual([host]);
    expect(page.nextCursor).toEqual(Option.some(nextHostCursor));
  });

  it("returns HTTP 400 for a malformed Host cursor before administration", async () => {
    let administrationCount = 0;
    const web = makeWebHandler({
      listHosts: () => {
        administrationCount++;
        return Effect.succeed(emptyHostPage);
      },
    });

    try {
      const response = await web.handler(
        new Request("http://localhost/hosts?limit=1&cursor=malformed-cursor"),
      );
      expect(response.status).toBe(400);
      expect(administrationCount).toBe(0);
    } finally {
      await web.dispose();
    }
  });

  /**
   * Proves the query-decoding ingress boundary rejects out-of-contract page
   * sizes before any domain work: `Pagination.PageSize` admits integers 1–100
   * only, so both ends of the range must fail as an HTTP 400 with the
   * administration service never invoked. This is transport admission, not a
   * service-side check — the service may trust an already-decoded limit.
   */
  it("returns HTTP 400 for out-of-contract pagination limits before administration", async () => {
    let administrationCount = 0;
    const web = makeWebHandler({
      listHosts: () => {
        administrationCount++;
        return Effect.succeed(emptyHostPage);
      },
    });

    try {
      for (const limit of ["0", "101"]) {
        const response = await web.handler(
          new Request(`http://localhost/hosts?limit=${limit}`),
        );
        expect(response.status).toBe(400);
      }
      expect(administrationCount).toBe(0);
    } finally {
      await web.dispose();
    }
  });

  /**
   * Proves the response-encoding boundary distinguishes "no continuation" from
   * "continuation available": when a service publishes an empty final page
   * (`nextCursor: Option.none()`), the generated client decodes the wire
   * response back to `Option.none()` rather than an empty string or undefined.
   * Without this proof a dropped/empty cursor field could silently masquerade
   * as a valid terminal page.
   */
  it("decodes a terminal page's absent nextCursor as Option.none on the client", async () => {
    const client = await Effect.runPromise(
      makeClient({
        listHosts: () => Effect.succeed(emptyHostPage),
      }),
    );

    const page = await Effect.runPromise(
      client["control-plane.administration"].listHosts({
        query: ListHostsInput.make({
          limit: Pagination.PageSize.make(1),
          cursor: Option.none(),
        }),
      }),
    );

    expect(page.items).toEqual([]);
    expect(page.nextCursor).toStrictEqual(Option.none());
  });

  it("relays Host-token cursors through global and Host-scoped routes", async () => {
    let observedGlobalCursor: HostTokenPagination.Cursor | undefined;
    let observedHostCursor: HostTokenPagination.Cursor | undefined;
    const client = await Effect.runPromise(
      makeClient({
        listAllTokens: (input) => {
          observedGlobalCursor = Option.getOrUndefined(input.cursor);
          return Effect.succeed(tokenPageWithContinuation);
        },
        listTokensByHost: (input) => {
          expect(input.hostId).toBe("host-1");
          observedHostCursor = Option.getOrUndefined(input.cursor);
          return Effect.succeed(tokenPageWithContinuation);
        },
      }),
    );
    const query = HostTokenPageRequest.make({
      limit: Pagination.PageSize.make(1),
      cursor: Option.some(tokenCursor),
    });

    const globalPage = await Effect.runPromise(
      client["control-plane.administration"].listAllHostTokens({ query }),
    );
    const hostPage = await Effect.runPromise(
      client["host.credentials"].listHostTokens({
        params: { hostId: "host-1" },
        query,
      }),
    );

    expect(observedGlobalCursor).toBe(tokenCursor);
    expect(observedHostCursor).toBe(tokenCursor);
    expect(globalPage.nextCursor).toEqual(Option.some(nextTokenCursor));
    expect(hostPage.nextCursor).toEqual(Option.some(nextTokenCursor));
  });

  it("returns HTTP 400 for malformed token cursors before token listing", async () => {
    let tokenListCount = 0;
    const unexpectedTokenList = () => {
      tokenListCount++;
      return Effect.succeed(emptyTokenPage);
    };
    const web = makeWebHandler({
      listAllTokens: unexpectedTokenList,
      listTokensByHost: unexpectedTokenList,
    });

    try {
      for (const url of [
        "http://localhost/control-plane/credentials?limit=1&cursor=malformed-cursor",
        "http://localhost/hosts/host-1/credentials?limit=1&cursor=malformed-cursor",
      ]) {
        const response = await web.handler(new Request(url));
        expect(response.status).toBe(400);
      }
      expect(tokenListCount).toBe(0);
    } finally {
      await web.dispose();
    }
  });
});

const emptyHostPage = RegisteredHostPagination.Page.make({
  items: [],
  nextCursor: Option.none(),
});
const emptyTokenPage = HostTokenPagination.Page.make({
  items: [],
  nextCursor: Option.none(),
});
const tokenPageWithContinuation = HostTokenPagination.Page.make({
  items: [],
  nextCursor: Option.some(nextTokenCursor),
});

/**
 * Builds every Control Plane handler group over request-observable fakes.
 * Supplying all groups lets raw-request tests use the production API router
 * rather than a test-only endpoint declaration.
 */
const makeHandlers = (options: TestServiceOptions = {}) => {
  const unexpected = () => Effect.die("unexpected Control Plane operation");
  const administration = Layer.succeed(
    ControlPlaneAdministration,
    ControlPlaneAdministration.of({
      createHost: unexpected,
      listHosts: options.listHosts ?? (() => Effect.succeed(emptyHostPage)),
      replaceControlPlaneRoles: unexpected,
    }),
  );
  const bootstrap = Layer.succeed(
    ControlPlaneBootstrap,
    ControlPlaneBootstrap.of({
      initialize: Effect.die("unexpected Control Plane initialization"),
      claimInitialAdministrator: unexpected,
      getClaimStatus: unexpected,
    }),
  );
  const tokens = Layer.succeed(
    HostTokenService,
    HostTokenService.of({
      issue: unexpected,
      verify: unexpected,
      revoke: unexpected,
      listByHost:
        options.listTokensByHost ?? (() => Effect.succeed(emptyTokenPage)),
      listAll: options.listAllTokens ?? (() => Effect.succeed(emptyTokenPage)),
    }),
  );
  const authorization = Layer.succeed(
    Authorization,
    Authorization.of({
      resolveControlPlanePermissions: () =>
        Effect.succeed(HashSet.make(ControlPlanePermissions.hosts.administer)),
      resolveHostPermissions: () =>
        Effect.succeed(HashSet.make(HostPermissions.tokens.manage)),
    }),
  );
  const hostAccess = Layer.succeed(
    HostAccessStore,
    HostAccessStore.of({
      getRegisteredHost: unexpected,
      createOwnedHost: unexpected,
      listPrincipalHosts: unexpected,
      listRegisteredHosts: unexpected,
      resolvePrincipalHostAccess: unexpected,
      createMembership: unexpected,
      replaceMembershipRoles: unexpected,
      getHostRole: unexpected,
      listHostRoles: unexpected,
    }),
  );
  const authenticate = Layer.succeed(RequireAuthenticatedHostCaller, (effect) =>
    Effect.provideService(effect, AuthenticatedHostCallerContext, {
      _tag: "Principal",
      caller,
    }),
  );
  const requestServices = Layer.mergeAll(
    administration,
    bootstrap,
    tokens,
    authorization,
    hostAccess,
  );
  return Layer.mergeAll(
    ControlPlaneClaimStatusHandlers,
    ControlPlaneAdministrationHandlers,
    HostCredentialAdministrationHandlers,
  ).pipe(
    Layer.provide(requestServices),
    HttpRouter.provideRequest(requestServices),
    Layer.provideMerge(authenticate),
  );
};

/** Creates a generated client backed by the real in-memory API router. */
const makeClient = (
  options: TestServiceOptions = {},
): Effect.Effect<ControlPlaneClient, never, never> =>
  HttpApiTest.groups(ControlPlaneHttpApi, [
    "control-plane.administration",
    "host.credentials",
  ]).pipe(
    Effect.provide(
      Layer.mergeAll(makeHandlers(options), HttpServer.layerServices),
    ),
    Effect.scoped,
  );

/** Creates a disposable Web Request handler for malformed raw-query tests. */
const makeWebHandler = (options: TestServiceOptions = {}) => {
  const apiLayer = HttpApiBuilder.layer(ControlPlaneHttpApi).pipe(
    Layer.provide(makeHandlers(options)),
    Layer.provide(HttpServer.layerServices),
  );
  return HttpRouter.toWebHandler(apiLayer, { disableLogger: true });
};
