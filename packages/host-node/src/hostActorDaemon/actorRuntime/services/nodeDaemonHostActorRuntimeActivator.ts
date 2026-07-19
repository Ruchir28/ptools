/**
 * @file Daemon-side capability for constructing one host actor runtime.
 *
 * This service lives in the Node host-actor daemon, not inside any actor's
 * `ManagedRuntime`. The daemon manager calls it when a `hostId` has no active
 * entry; the returned runtime then owns that actor's identity, stores, handler,
 * and configured-context cache.
 */
import { Effect } from "effect";
import type { NodeHostActorRuntimeOptions } from "../contracts/nodeHostActorRuntimeOptions.js";
import {
  makeNodeHostActorRuntime,
  type NodeHostActorRuntime,
} from "../nodeHostActorRuntime.js";
import type { NodeHostActorRuntimeError } from "../nodeHostActorRuntimeError.js";

/** Daemon-side activation operations consumed by `NodeHostRuntimeManager`. */
export interface NodeDaemonHostActorRuntimeActivatorOperations {
  /**
   * Build and eagerly initialize one actor selected by a logical host ID.
   * The manager decides when to call this and owns the returned runtime; this
   * service keeps no actor map and performs no operation dispatch.
   */
  readonly activate: (
    hostId: string,
  ) => Effect.Effect<NodeHostActorRuntime, NodeHostActorRuntimeError>;
}

/**
 * Node-daemon-owned actor activation service.
 *
 * Its production `.Default(options)` closes over daemon-wide physical settings
 * once when the daemon Layer graph is built. It is provided to
 * `NodeHostRuntimeManager`; it is never installed into `HostStableRuntimeLayer`
 * or exposed to `HostInstanceHandler`. This separation prevents an actor from
 * gaining authority to create sibling actors.
 */
export class NodeDaemonHostActorRuntimeActivator extends Effect.Service<NodeDaemonHostActorRuntimeActivator>()(
  "@ptools/host-node/hostActorDaemon/NodeDaemonHostActorRuntimeActivator",
  {
    effect: (options: NodeHostActorRuntimeOptions) =>
      Effect.succeed({
        activate: (hostId) => makeNodeHostActorRuntime(hostId, options),
      } satisfies NodeDaemonHostActorRuntimeActivatorOperations),
  },
) {}
