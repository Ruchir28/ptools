/**
 * @file One stable runtime owned by one `hostId` inside the Node daemon.
 *
 * `NodeHostRuntimeManager` creates this value lazily and stores exactly one per
 * active host. It combines Node storage, MCP, and Deno capabilities with the
 * shared host runtime, then exposes only dispatch and disposal.
 *
 * This module does not own the daemon process, RPC listener, server leases, or
 * cross-process ownership lock.
 */
import type {
  HostOperationDispatchInput,
  HostOperationResponse,
} from "@ptools/host-api";
import {
  HostInstanceHandler,
  type HostStableRuntimeServices,
} from "@ptools/host-runtime";
import { Cause, Effect, ManagedRuntime } from "effect";
import { DenoSandboxRuntimeLayer } from "../../executor/localExecutor.js";
import {
  NodeFileHostStateStorageBackendLayer,
  NodeKeyringHostSecretStorageBackendLayer,
} from "../../layers/platform/hostStorage.js";
import { NodeMcpConnectorLive } from "../../mcpConnector.js";
import type { NodeHostActorRuntimeOptions } from "./contracts/nodeHostActorRuntimeOptions.js";
import {
  makeNodeHostActorRuntimeLayer,
  type NodeHostActorPlatformLayers,
} from "./layers/nodeHostActorRuntimeLayer.js";
import {
  NodeHostActorRuntimeError,
  NodeHostActorRuntimePhase,
} from "./nodeHostActorRuntimeError.js";
import { nodeHostStateRootDirectory } from "../daemonProcess/nodeHostActorStateNamespace.js";

/**
 * Callable lifecycle boundary stored in exactly one manager entry.
 *
 * The underlying `ManagedRuntime` is deliberately hidden so callers cannot run
 * arbitrary Effects against actor services or bypass typed execution/disposal
 * errors. `dispatch` is the only operation path into `HostInstanceHandler`.
 */
export interface NodeHostActorRuntime {
  /** Logical identity used to create this runtime and its storage namespaces. */
  readonly hostId: string;
  /** Execute one complete normalized Host API operation in this actor runtime. */
  readonly dispatch: (
    input: HostOperationDispatchInput,
  ) => Effect.Effect<HostOperationResponse, NodeHostActorRuntimeError>;
  /** Close the actor's stable Layer scope and all resources owned beneath it. */
  readonly dispose: Effect.Effect<void, NodeHostActorRuntimeError>;
}

/**
 * Activate one production actor from daemon-wide physical settings.
 *
 * The selected `hostId` becomes the shared `HostIdentity`; storage backends use
 * it to derive isolated filesystem/keyring namespaces. MCP and Deno remain
 * Node-specific primitive capabilities consumed by the shared stable Layer.
 */
export const makeNodeHostActorRuntime = (
  hostId: string,
  options: NodeHostActorRuntimeOptions,
): Effect.Effect<NodeHostActorRuntime, NodeHostActorRuntimeError> =>
  makeNodeHostActorRuntimeFromPlatformLayers(hostId, {
    stateStorageBackend: NodeFileHostStateStorageBackendLayer(
      nodeHostStateRootDirectory(options),
    ),
    secretStorageBackend: NodeKeyringHostSecretStorageBackendLayer({
      serviceName: options.keyringServiceName,
    }),
    mcpConnector: NodeMcpConnectorLive,
    sandboxRuntime: DenoSandboxRuntimeLayer(
      options.denoExecutable === undefined
        ? undefined
        : { denoExecutable: options.denoExecutable },
    ),
  });

/**
 * Build and eagerly initialize one actor from final abstract platform Layers.
 *
 * Production supplies Node adapters above; tests may supply in-memory ports
 * without replacing shared stores, context caching, or operation handling. The
 * eager `runtimeEffect` evaluation ensures Layer acquisition failures occur
 * before the manager publishes this actor. The returned wrapper retains the
 * `ManagedRuntime` solely for dispatch and deterministic scope disposal.
 */
export const makeNodeHostActorRuntimeFromPlatformLayers = (
  hostId: string,
  platform: NodeHostActorPlatformLayers,
): Effect.Effect<NodeHostActorRuntime, NodeHostActorRuntimeError> => {
  const managedRuntime: ManagedRuntime.ManagedRuntime<
    HostStableRuntimeServices,
    unknown
  > = ManagedRuntime.make(makeNodeHostActorRuntimeLayer(hostId, platform));

  return managedRuntime.runtimeEffect.pipe(
    mapRuntimeCause(
      hostId,
      NodeHostActorRuntimePhase.Activate,
      "Failed to activate host actor runtime.",
    ),
    // Eager activation above proves the Layer can build before the manager
    // publishes this actor. Deliberately discard the returned raw Runtime:
    // dispatch provides the ManagedRuntime itself, so disposal invalidates
    // future dispatch instead of leaving a captured Runtime usable afterward.
    Effect.as({
      hostId,
      dispatch: (input: HostOperationDispatchInput) =>
        Effect.flatMap(HostInstanceHandler, (handler) =>
          handler.handle(input),
        ).pipe(
          /**
           * Effect 3.21 `provide(ManagedRuntime)` enters the actor on the current
           * request fiber; it does not create a thread, fiber, or actor mailbox.
           * It fiber-locally overlays the actor Context, FiberRefs, and runtime
           * flags, with actor services winning duplicate Context tags, and then
           * restores the request fiber in an `ensuring` finalizer. Consequently,
           * concurrent host IDs receive independent HostIdentity values without
           * mutating the manager Context.
           *
           * Non-colliding manager services remain visible because Contexts are
           * merged, so this is an ownership/execution boundary, not a security
           * sandbox. The typed operation requires only HostInstanceHandler. If a
           * future design needs a strictly separate execution fiber or mailbox,
           * use Runtime.runFork and explicitly bridge interruption/completion
           * rather than assuming `provide` supplies that isolation.
           */
          Effect.provide(managedRuntime),
          mapRuntimeCause(
            hostId,
            NodeHostActorRuntimePhase.Execute,
            "Failed to execute a host actor operation.",
          ),
        ),
      dispose: managedRuntime.disposeEffect.pipe(
        mapRuntimeCause(
          hostId,
          NodeHostActorRuntimePhase.Dispose,
          "Failed to dispose host actor runtime.",
        ),
      ),
    } satisfies NodeHostActorRuntime),
    Effect.onError(() => managedRuntime.disposeEffect),
  );
};

/**
 * Preserve interruption while translating actor Layer defects and typed
 * failures into the daemon-internal runtime error boundary.
 */
const mapRuntimeCause =
  (hostId: string, phase: NodeHostActorRuntimePhase, message: string) =>
  <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, NodeHostActorRuntimeError, R> =>
    effect.pipe(
      Effect.catchAllCause((cause) =>
        Cause.isInterruptedOnly(cause)
          ? Effect.interrupt
          : Effect.fail(
              new NodeHostActorRuntimeError({
                hostId,
                phase,
                message,
                cause,
              }),
            ),
      ),
    );
