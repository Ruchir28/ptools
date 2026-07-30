/**
 * Unit coverage for Node HostInstanceDiscovery's connection sharing.
 *
 * Background — discovery is scoped infrastructure, while resolve(hostId) is a
 * cheap per-operation lookup. The layer must acquire one leased daemon
 * connection up front and give every returned handle that same capability;
 * resolve must never create connection or lease lifetimes of its own.
 *
 * What this proves:
 *   1. Building discovery acquires one NodeHostActorDaemonConnection for the
 *      whole Effect.scoped lifetime — not one connection per resolve().
 *   2. resolve(hostId) returns a fresh handle per hostId, but each handle
 *      reuses that same shared connection.
 *   3. The connection is released only when the outer discovery scope closes.
 *
 * The connection layer is faked with acquireRelease counters so we can assert
 * acquisition/release without standing up a real daemon or RPC transport.
 */
import { HostInstanceDiscovery } from "@ptools/host-api/effect";
import { Effect, Layer } from "effect";
import { expect, it } from "vitest";
import { NodeDaemonHostInstanceDiscoveryFromConnectionLive } from "../src/nodeDaemonHostInstanceDiscovery.js";
import { NodeHostActorDaemonConnection } from "../src/services/nodeHostActorDaemonConnection.js";

it("acquires one internal connection for the discovery scope and shares it across resolves", async () => {
  let acquisitions = 0;
  let releases = 0;

  // Fake connection whose lifetime we can count. handleHostOperation is unused;
  // this test only cares that discovery wires through one shared connection.
  const connectionLayer = Layer.effect(
    NodeHostActorDaemonConnection,
    Effect.acquireRelease(
      Effect.sync(() => {
        acquisitions += 1;
        return NodeHostActorDaemonConnection.of({
          handleHostOperation: () => Effect.die("not called"),
        });
      }),
      () =>
        Effect.sync(() => {
          releases += 1;
        }),
    ),
  );

  // Discovery depends on NodeHostActorDaemonConnection; providing the fake
  // above means resolve() gets handles backed by that single scoped instance.
  const discoveryLayer = NodeDaemonHostInstanceDiscoveryFromConnectionLive.pipe(
    Layer.provide(connectionLayer),
  );

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const discovery = yield* HostInstanceDiscovery;

        // Two resolves → two distinct handles (different hostIds), but both
        // must share the one connection acquired when the layer was built.
        const first = yield* discovery.resolve("alpha");
        const second = yield* discovery.resolve("beta");
        expect(first).not.toBe(second);
        expect(acquisitions).toBe(1);
        // Scope is still open, so the connection finalizer has not run yet.
        expect(releases).toBe(0);
      }).pipe(Effect.provide(discoveryLayer)),
    ),
  );

  // Leaving Effect.scoped closes the discovery/connection scope → one release.
  expect(acquisitions).toBe(1);
  expect(releases).toBe(1);
});
