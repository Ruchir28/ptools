/** Node HostInstanceDiscovery backed by one scope-wide daemon lease. */
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

/** Acquire one connection/lease for the discovery layer's complete scope. */
export const NodeDaemonHostInstanceDiscoveryLive = (
  options: NodeDaemonDiscoveryOptions,
): Layer.Layer<HostInstanceDiscovery, NodeDaemonConnectionError> =>
  NodeDaemonHostInstanceDiscoveryFromConnectionLive.pipe(
    Layer.provide(
      NodeHostActorDaemonConnection.Default(options).pipe(
        Layer.provide(NodeHostActorDaemonSpawner.Default),
      ),
    ),
  );

export type { NodeDaemonDiscoveryOptions };
