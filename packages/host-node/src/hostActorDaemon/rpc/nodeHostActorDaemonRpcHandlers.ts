/**
 * @file Daemon-side implementations of the private typed procedures.
 *
 * `effect/unstable/rpc` owns envelope/schema decoding and RPC middleware owns
 * credential, protocol, and lease admission checks. These handlers perform
 * daemon-level delegation only: `HandleHostOperation` forwards the complete
 * decoded input to `NodeHostRuntimeManager` without interpreting it.
 */
import { Effect } from "effect";
import {
  NODE_HOST_ACTOR_DAEMON_PROTOCOL_VERSION,
  NodeHostActorDaemonRpcs,
  NodeHostActorRuntimeRpcError,
} from "./nodeHostActorDaemonRpcContracts.js";
import type { NodeHostActorDaemonOwnership } from "../ownership/nodeHostActorDaemonOwnership.js";
import { NodeHostActorDaemonLeaseManager } from "../leases/services/nodeHostActorDaemonLeaseManager.js";
import { NodeHostRuntimeManager } from "../actorRuntime/services/nodeHostRuntimeManager.js";

/**
 * Bind procedure names to the one ownership identity, lease authority, and
 * actor manager already created by the daemon process composition.
 */
export const NodeHostActorDaemonRpcHandlersLive = (
  ownership: NodeHostActorDaemonOwnership,
) =>
  NodeHostActorDaemonRpcs.toLayer(
    Effect.gen(function* () {
      const leases = yield* NodeHostActorDaemonLeaseManager;
      const runtimes = yield* NodeHostRuntimeManager;

      return NodeHostActorDaemonRpcs.of({
        Health: () =>
          Effect.succeed({
            protocolVersion: NODE_HOST_ACTOR_DAEMON_PROTOCOL_VERSION,
            ownerGeneration: ownership.ownerGeneration,
            pid: ownership.pid,
            startedAtEpochMs: ownership.startedAtEpochMs,
          }),
        AcquireServerLease: () => leases.acquire,
        RenewServerLease: ({ leaseId }) => leases.renew(leaseId),
        ReleaseServerLease: ({ leaseId }) => leases.release(leaseId),
        HandleHostOperation: ({ input }) =>
          runtimes.dispatch(input).pipe(
            Effect.mapError(
              (error) =>
                new NodeHostActorRuntimeRpcError({
                  hostId: error.hostId,
                  phase: error.phase,
                  message: error.message,
                }),
            ),
          ),
      });
    }),
  );
