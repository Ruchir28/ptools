/**
 * Node HostInstanceDiscovery backed by one scope-wide actor-daemon lease.
 *
 * This module owns only actor-daemon connection and hostId resolution. The
 * foreground control-plane scope owns when this layer is built and closed;
 * ordinary client lifetime does not alter discovery behavior.
 */
import { HostInstanceDiscovery } from "@ptools/host-api/effect";
import { Effect, Layer } from "effect";
import { makeNodeDaemonHostInstanceHandle } from "./nodeDaemonHostInstanceHandle.js";
import {
  NodeHostActorDaemonConnection,
  type NodeDaemonConnectionError,
  type NodeDaemonDiscoveryOptions,
} from "./services/nodeHostActorDaemonConnection.js";
import { NodeHostActorDaemonSpawner } from "./services/nodeHostActorDaemonSpawner.js";

/** Testable inner layer; production consumes and hides the connection service. */
export const NodeDaemonHostInstanceDiscoveryFromConnectionLive: Layer.Layer<
  HostInstanceDiscovery,
  never,
  NodeHostActorDaemonConnection
> = Layer.effect(
  HostInstanceDiscovery,
  Effect.gen(function* () {
    const connection = yield* NodeHostActorDaemonConnection;
    return HostInstanceDiscovery.of({
      resolve: (hostId) =>
        Effect.succeed(
          makeNodeDaemonHostInstanceHandle({ hostId, connection }),
        ),
    });
  }),
);

/**
 * Acquires one actor-daemon connection/lease for the discovery layer's complete
 * scope. Resolving a host remains lightweight; the returned handle carries its
 * hostId and dispatches later through this shared private connection.
 */
export const NodeDaemonHostInstanceDiscoveryLive = (
  options: NodeDaemonDiscoveryOptions,
): Layer.Layer<HostInstanceDiscovery, NodeDaemonConnectionError> =>
  Layer.effect(
    HostInstanceDiscovery,
    Effect.gen(function* () {
      const connection = yield* NodeHostActorDaemonConnection;
      return HostInstanceDiscovery.of({
        resolve: (hostId) =>
          Effect.succeed(
            makeNodeDaemonHostInstanceHandle({ hostId, connection }),
          ),
      });
    }),
  ).pipe(
    Layer.provide(
      NodeHostActorDaemonConnection.layer(options).pipe(
        Layer.provide(NodeHostActorDaemonSpawner.layer),
      ),
    ),
  );


export type { NodeDaemonDiscoveryOptions };
