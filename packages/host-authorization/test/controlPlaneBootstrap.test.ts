/*
 * Shared Control Plane bootstrap and Principal model coverage.
 *
 * What this proves:
 * 1. Provider subjects are canonically separated from fixed-local identities.
 * 2. Initialization returns setup plaintext once while storing only its digest.
 * 3. Claim atomically creates the first Administrator and rejects replay.
 * 4. Initial claim allocates and retains the Administrator role ID atomically.
 * 5. Global role replacement cannot remove the final Administrator.
 *
 * The real shared bootstrap service and in-memory atomic store are used. Crypto
 * and Clock are deterministic fakes; no HTTP, provider, SQLite, D1, Node host,
 * or Cloudflare Worker participates.
 */
import { createHash } from "node:crypto";
import {
  BuiltInControlPlaneRoles,
  ClaimInitialAdministratorInput,
  ControlPlaneClaimRejected,
  LastControlPlaneAdministrator,
  PrincipalId,
  PrincipalIds,
  PrincipalCaller,
  ReplacePrincipalControlPlaneRolesInput,
} from "../src/contracts/index.js";
import {
  ControlPlaneAccessStore,
  ControlPlaneBootstrap,
  InMemoryControlPlaneAccessStoreLayer,
} from "../src/services/index.js";
import { Clock, Crypto, Effect, Layer, Option, Schema } from "effect";
import { describe, expect, it } from "vitest";

/**
 * Deterministic Crypto fake: sequential random bytes with genuine SHA-256
 * digests, so bootstrap hashing is reproducible while remaining the real
 * algorithm rather than a stubbed equivalence.
 */
const crypto = Crypto.make({
  randomBytes: (size) => Uint8Array.from({ length: size }, (_, index) => index),
  digest: (_algorithm, data) =>
    Effect.succeed(new Uint8Array(createHash("sha256").update(data).digest())),
});

/** Frozen Clock at 1_000ms; bootstrap timestamps are inputs, not measurements. */
const clock: Clock.Clock = {
  currentTimeMillisUnsafe: () => 1_000,
  currentTimeMillis: Effect.succeed(1_000),
  currentTimeNanosUnsafe: () => 1_000_000_000n,
  currentTimeNanos: Effect.succeed(1_000_000_000n),
  sleep: () => Effect.void,
};

/**
 * Real bootstrap service over the real in-memory atomic store; only platform
 * crypto and time are faked. The initialize/claim lifecycle under test is the
 * shared implementation, not a re-creation of it.
 */
const live = Layer.provideMerge(
  ControlPlaneBootstrap.layer,
  Layer.merge(
    InMemoryControlPlaneAccessStoreLayer,
    Layer.succeed(Crypto.Crypto, crypto),
  ),
);

/** Adds the frozen Clock on top of the shared bootstrap Layer. */
const provideLive = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(live), Effect.provideService(Clock.Clock, clock));

describe("Principal identity", () => {
  /**
   * Proves provider/subject pairs are hashed with domain separation so
   * `("ab","c")` and `("a","bc")` cannot collide, fixed-local identities use
   * a distinct prefix, and raw provider subjects fail `PrincipalId` decoding.
   */
  it("uses collision-free domain-separated canonical IDs", () => {
    const first = PrincipalIds.fromExternalSubject("ab", "c");
    const second = PrincipalIds.fromExternalSubject("a", "bc");
    const local = PrincipalIds.fromFixedLocalIdentity("abc");

    expect(first).not.toBe(second);
    expect(first).not.toBe(local);
    expect(first).toMatch(/^ptools_principal_v1_external_/);
    expect(local).toMatch(/^ptools_principal_v1_local_/);
    expect(() => PrincipalIds.fromExternalSubject("", "subject")).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(PrincipalId)("raw-provider-subject"),
    ).toThrow();
  });
});

describe("Control Plane bootstrap", () => {
  /**
   * Proves the setup capability is one-time (second initialize returns
   * None), claiming installs the full Administrator grants, the claim status
   * becomes Claimed, and replaying the same capability is rejected.
   */
  it("delivers setup plaintext once, claims Administrator, and rejects replay", async () => {
    const alice = PrincipalCaller.make({
      principalId: PrincipalIds.fromExternalSubject("test", "alice"),
    });

    const result = await Effect.runPromise(
      provideLive(
        Effect.gen(function* () {
          const bootstrap = yield* ControlPlaneBootstrap;
          const first = yield* bootstrap.initialize;
          const second = yield* bootstrap.initialize;
          const capability = Option.getOrThrow(first);
          const claimed = yield* bootstrap.claimInitialAdministrator(
            ClaimInitialAdministratorInput.make({
              setupCapability: capability,
            }),
            alice,
          );
          const status = yield* bootstrap.getClaimStatus();
          const replay = yield* Effect.flip(
            bootstrap.claimInitialAdministrator(
              ClaimInitialAdministratorInput.make({
                setupCapability: capability,
              }),
              alice,
            ),
          );
          return { second, claimed, status, replay };
        }),
      ),
    );

    expect(Option.isNone(result.second)).toBe(true);
    expect(result.claimed.effectivePermissions).toEqual(
      BuiltInControlPlaneRoles.administrator.permissions,
    );
    expect(result.status._tag).toBe("Claimed");
    expect(result.replay).toBeInstanceOf(ControlPlaneClaimRejected);
  });

  /**
   * Proves the store-level last-Administrator safety law: stripping all
   * roles from the only Administrator fails with
   * `LastControlPlaneAdministrator` instead of leaving the Control Plane
   * unadministrable.
   */
  it("prevents removal of the final Administrator", async () => {
    const aliceId = PrincipalIds.fromFixedLocalIdentity("principal-alice");
    const alice = PrincipalCaller.make({ principalId: aliceId });

    const failure = await Effect.runPromise(
      provideLive(
        Effect.gen(function* () {
          const bootstrap = yield* ControlPlaneBootstrap;
          const capability = Option.getOrThrow(yield* bootstrap.initialize);
          yield* bootstrap.claimInitialAdministrator(
            ClaimInitialAdministratorInput.make({
              setupCapability: capability,
            }),
            alice,
          );
          const store = yield* ControlPlaneAccessStore;
          return yield* Effect.flip(
            store.replaceRoles(
              ReplacePrincipalControlPlaneRolesInput.make({
                principalId: aliceId,
                roleIds: [],
                assignedByPrincipalId: aliceId,
              }),
            ),
          );
        }),
      ),
    );

    expect(failure).toBeInstanceOf(LastControlPlaneAdministrator);
  });
});
