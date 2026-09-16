/**
 * Shared authorization services over the durable Node stores.
 *
 * Mental model:
 *   the Node Layer set supplies the three shared persistence ports over one
 *   scoped SQLite connection; the shared `ControlPlaneBootstrap`,
 *   `ControlPlaneAdministration`, `Authorization`, and `HostTokenService`
 *   Layers sit on top and add the atomic laws and permission projections.
 *
 * What this proves:
 *   1. Real bootstrap initialization + claim installs Administrator authority
 *      through the shared workflow and the Node store's atomic claim.
 *   2. The shared administration workflow creates an owned Host and lists it
 *      from resolved authority.
 *   3. `Authorization` resolves Host authority for a registered Host and never
 *      activates an unregistered one.
 *   4. The shared token lifecycle issues a hash-only record, verifies the
 *      plaintext once, and rejects a tampered credential.
 *
 * Boundaries:
 *   SQLite, migrations, Drizzle transactions, and Node crypto are real. No
 *   provider, host runtime, or network boundary is involved.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  ClaimInitialAdministratorInput,
  ControlPlanePermissions,
  CreateRegisteredHostInput,
  HostPermission,
  HostPermissions,
  HostTokenName,
  HostTokenRejected,
  IssueHostTokenInput,
  ListHostsInput,
  Pagination,
  Principal,
  PrincipalCaller,
  PrincipalIds,
  RegisteredHostNotFound,
  VerifyHostTokenInput,
} from "@ptools/host-authorization";
import {
  Authorization,
  ControlPlaneAdministration,
  ControlPlaneBootstrap,
  HostTokenService,
} from "@ptools/host-authorization/effect";
import { Effect, Layer, Option, Result } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeAuthorizationStoresLive } from "../src/hostControlPlaneDaemon/authorization/nodeAuthorizationStores.js";
import {
  NodeControlPlaneDatabaseError,
  NodeControlPlaneDrizzleLive,
} from "../src/services/nodeControlPlaneDrizzle.js";

let directory: string;
let filename: string;

const operatorId = PrincipalIds.fromFixedLocalIdentity(
  "services-test/operator",
);
const operatorCaller = PrincipalCaller.make({ principalId: operatorId });

type SharedAuthorizationServices =
  | ControlPlaneBootstrap
  | ControlPlaneAdministration
  | Authorization
  | HostTokenService;

/** Shared service Layers over one freshly scoped Node control-plane database. */
const sharedServicesLive = (
  sqliteFilename: string,
): Layer.Layer<
  SharedAuthorizationServices,
  NodeControlPlaneDatabaseError,
  never
> =>
  Layer.mergeAll(
    ControlPlaneBootstrap.layer,
    ControlPlaneAdministration.layer,
    Authorization.layer,
    HostTokenService.layer,
  ).pipe(
    Layer.provide(NodeAuthorizationStoresLive),
    Layer.provide(NodeControlPlaneDrizzleLive({ filename: sqliteFilename })),
    Layer.provide(NodeCrypto.layer),
  );

const run = <A, E>(
  effect: Effect.Effect<A, E, SharedAuthorizationServices>,
  sqliteFilename: string,
) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(sharedServicesLive(sqliteFilename))),
  );

const claimOperator = Effect.gen(function* () {
  const bootstrap = yield* ControlPlaneBootstrap;
  const capability = Option.getOrThrow(yield* bootstrap.initialize);
  yield* bootstrap.claimInitialAdministrator(
    ClaimInitialAdministratorInput.make({ setupCapability: capability }),
    operatorCaller,
  );
});

describe("shared authorization services over Node store layers", () => {
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "ptools-auth-services-"));
    filename = join(directory, "control-plane.sqlite");
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("bootstraps, claims Administrator, and creates an owned Host", async () => {
    const result = await run(
      Effect.gen(function* () {
        const bootstrap = yield* ControlPlaneBootstrap;
        const capability = Option.getOrThrow(yield* bootstrap.initialize);
        const access = yield* bootstrap.claimInitialAdministrator(
          ClaimInitialAdministratorInput.make({ setupCapability: capability }),
          operatorCaller,
        );
        const administration = yield* ControlPlaneAdministration;
        const created = yield* administration.createHost(
          CreateRegisteredHostInput.make({ requestedHostId: "node-local" }),
          operatorCaller,
        );
        const hosts = yield* administration.listHosts(
          ListHostsInput.make({
            limit: Pagination.PageSize.make(10),
            cursor: Option.none(),
          }),
          operatorCaller,
        );
        return { access, created, hosts };
      }),
      filename,
    );

    expect(result.access.effectivePermissions).toContain(
      ControlPlanePermissions.hosts.administer,
    );
    expect(result.created.host.hostId).toBe("node-local");
    expect(result.hosts.items.map(({ hostId }) => hostId)).toEqual([
      "node-local",
    ]);
  });

  it("resolves registered Host authority and never activates a guessed Host", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* claimOperator;
        const administration = yield* ControlPlaneAdministration;
        yield* administration.createHost(
          CreateRegisteredHostInput.make({ requestedHostId: "node-local" }),
          operatorCaller,
        );

        const authorization = yield* Authorization;
        const principal = Principal.make({ principalId: operatorId });
        const registered = yield* authorization.resolveHostPermissions(
          principal,
          "node-local",
        );
        const guessed = yield* Effect.result(
          authorization.resolveHostPermissions(principal, "not-registered"),
        );
        return { registered, guessed };
      }),
      filename,
    );

    expect([...result.registered].sort()).toEqual(
      [...HostPermission.literals].sort(),
    );
    expect(Result.isFailure(result.guessed)).toBe(true);
    if (Result.isFailure(result.guessed)) {
      expect(result.guessed.failure).toBeInstanceOf(RegisteredHostNotFound);
    }
  });

  it("issues a verifiable hash-only Host token and rejects tampering", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* claimOperator;
        const administration = yield* ControlPlaneAdministration;
        yield* administration.createHost(
          CreateRegisteredHostInput.make({ requestedHostId: "node-local" }),
          operatorCaller,
        );

        const tokens = yield* HostTokenService;
        const issued = yield* tokens.issue(
          IssueHostTokenInput.make({
            hostId: "node-local",
            name: HostTokenName.make("automation"),
            grantedPermissions: [HostPermissions.host.read],
            expiresAtEpochMs: Option.none(),
          }),
          operatorCaller,
        );
        const verified = yield* tokens.verify(
          VerifyHostTokenInput.make({ plaintext: issued.plaintext }),
        );
        const tampered = yield* Effect.result(
          tokens.verify(
            VerifyHostTokenInput.make({
              plaintext: `ptools_host_v1_${"A".repeat(43)}`,
            }),
          ),
        );
        return { issued, verified, tampered };
      }),
      filename,
    );

    expect(result.issued.plaintext.startsWith("ptools_host_v1_")).toBe(true);
    expect(result.verified.effectivePermissions).toEqual([
      HostPermissions.host.read,
    ]);
    expect(Result.isFailure(result.tampered)).toBe(true);
    if (Result.isFailure(result.tampered)) {
      expect(result.tampered.failure).toBeInstanceOf(HostTokenRejected);
    }
  });
});
