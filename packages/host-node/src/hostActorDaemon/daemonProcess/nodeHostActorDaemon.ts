/**
 * @file Root lifecycle composition for one authoritative daemon process.
 *
 * This module connects process ownership, credentials, leases, private RPC,
 * and per-host actor management. Explicit child scopes preserve shutdown order:
 * stop admission, drain work, dispose actors, close RPC, invalidate metadata,
 * then release the process lock.
 *
 * It serves no public Host HttpApi and performs no caller-side discovery.
 */
import { FileSystem } from "@effect/platform";
import { Context, Effect, Exit, Layer, Scope } from "effect";
import type { NodeHostActorRuntimeOptions } from "../actorRuntime/contracts/nodeHostActorRuntimeOptions.js";
import { NodeDaemonHostActorRuntimeActivator } from "../actorRuntime/services/nodeDaemonHostActorRuntimeActivator.js";
import { NodeHostRuntimeManager } from "../actorRuntime/services/nodeHostRuntimeManager.js";
import {
  DEFAULT_NODE_HOST_ACTOR_DAEMON_LEASE_OPTIONS,
  NodeHostActorDaemonLeaseManager,
  type NodeHostActorDaemonLeaseOptions,
} from "../leases/services/nodeHostActorDaemonLeaseManager.js";
import {
  acquireNodeHostActorDaemonOwnership,
  publishNodeHostActorDaemonCredential,
} from "../ownership/nodeHostActorDaemonOwnership.js";
import { NODE_HOST_ACTOR_DAEMON_PROTOCOL_VERSION } from "../rpc/nodeHostActorDaemonRpcContracts.js";
import { startNodeHostActorDaemonRpcServer } from "../rpc/nodeHostActorDaemonRpcServer.js";

export interface NodeHostActorDaemonOptions extends NodeHostActorRuntimeOptions {
  readonly leases?: Partial<NodeHostActorDaemonLeaseOptions>;
}

/**
 * Acquire ownership and run the complete daemon until zero-lease shutdown or
 * interruption. Every exit path uses the same scoped drain and cleanup order;
 * ownership is always the outermost and last-released resource.
 */
export const runNodeHostActorDaemon = (options: NodeHostActorDaemonOptions) =>
  // Outer scope: process ownership only (lock FD + ready-metadata finalizers).
  // Stays open for the whole time this process owns the namespace, and releases
  // the kernel lock last—after the inner daemon scope has fully torn down.
  Effect.scoped(
    Effect.gen(function* () {
      const ownership = yield* acquireNodeHostActorDaemonOwnership(
        options.internalStateDirectory,
      );

      // Inner scope: everything that runs under that ownership (credential,
      // leases, actor manager, RPC listener, drain). Ends first on shutdown,
      // signal, or failure so finalizers run before the outer scope:
      // stop admission → drain → dispose manager/RPC → (outer) invalidate
      // ready metadata → close lock FD.
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const credential =
            yield* publishNodeHostActorDaemonCredential(ownership);
          const leaseOptions: NodeHostActorDaemonLeaseOptions = {
            ...DEFAULT_NODE_HOST_ACTOR_DAEMON_LEASE_OPTIONS,
            ...options.leases,
          };

          const daemonServices = Layer.merge(
            NodeHostActorDaemonLeaseManager.Default(leaseOptions),
            NodeHostRuntimeManager.Default.pipe(
              Layer.provide(
                NodeDaemonHostActorRuntimeActivator.Default(options),
              ),
            ),
          );

          // Two child scopes under this inner daemon scope, closed by parent
          // finalizers. Effect finalizers are LIFO, so register close order as
          // the reverse of desired shutdown:
          //
          //   register serverScope close first  → closes last  (RPC listener)
          //   register serviceScope close next → closes middle (leases/runtimes)
          //   register drain last (below)       → runs first
          //
          // Desired unwind: stop admission + drain → dispose managers → close RPC.
          const serverScope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(serverScope, Exit.void));
          const serviceScope = yield* Scope.make();
          yield* Effect.addFinalizer(() =>
            Scope.close(serviceScope, Exit.void),
          );

          // Build lease + runtime manager into serviceScope so their resources
          // are disposed when that child scope closes.
          const serviceContext = yield* Layer.buildWithScope(
            daemonServices,
            serviceScope,
          );
          const leases = Context.get(
            serviceContext,
            NodeHostActorDaemonLeaseManager,
          );
          const runtimes = Context.get(serviceContext, NodeHostRuntimeManager);

          // Bind the RPC listener to serverScope (not the ambient scope) so it
          // closes on the schedule above, after managers have been disposed.
          const server = yield* startNodeHostActorDaemonRpcServer(
            ownership,
            credential,
          ).pipe(
            Effect.provideService(NodeHostActorDaemonLeaseManager, leases),
            Effect.provideService(NodeHostRuntimeManager, runtimes),
            Effect.provideService(Scope.Scope, serverScope),
          );

          // Last finalizer → first to run on interruption/shutdown, before the
          // serviceScope and serverScope closes registered above.
          yield* Effect.addFinalizer(() =>
            leases.stopAdmission.pipe(Effect.zipRight(leases.drain)),
          );

          yield* ownership.publishReadyMetadata({
            origin: server.origin,
            protocolVersion: NODE_HOST_ACTOR_DAEMON_PROTOCOL_VERSION,
          });

          yield* leases.awaitShutdown;
          yield* leases.stopAdmission;
          yield* leases.drain;
        }),
      );
    }),
  );

/** Required platform environment for the daemon composition. */
export type NodeHostActorDaemonEnvironment = FileSystem.FileSystem;
