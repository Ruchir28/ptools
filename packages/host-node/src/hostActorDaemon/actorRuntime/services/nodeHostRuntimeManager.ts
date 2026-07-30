/**
 * @file Daemon-internal registry and lifecycle owner for active Node host
 * actors. It selects one actor by `input.hostId`; operation interpretation stays
 * exclusively in the selected runtime's shared `HostInstanceHandler`.
 */
import type {
  HostOperationDispatchInput,
  HostOperationResponse,
} from "@ptools/host-api";
import {
  Data,
  Context,
  Deferred,
  Effect,
  Exit,
  HashMap,
  Option,
  Scope,
  SynchronizedRef,
  Layer,
} from "effect";
import type { NodeHostActorRuntime } from "../nodeHostActorRuntime.js";
import {
  NodeHostActorRuntimeError,
  NodeHostActorRuntimePhase,
} from "../nodeHostActorRuntimeError.js";
import {
  NodeDaemonHostActorRuntimeActivator,
  type NodeDaemonHostActorRuntimeActivatorOperations,
} from "./nodeDaemonHostActorRuntimeActivator.js";

/** Operations exposed only inside the authoritative Node daemon process. */
export interface NodeHostRuntimeManagerOperations {
  /**
   * Route one normalized operation to the actor selected by `input.hostId`.
   * Activation/runtime failures stay in the typed error channel; expected Host
   * API failures are response values produced by the actor-local handler.
   */
  readonly dispatch: (
    input: HostOperationDispatchInput,
  ) => Effect.Effect<HostOperationResponse, NodeHostActorRuntimeError>;
}

/**
 * Published state for one host ID.
 *
 * `Activating` lets concurrent same-host callers await one acquisition, while
 * `Active` is the single reusable runtime owned by this manager scope.
 */
type ActorEntry = Data.TaggedEnum<{
  Activating: {
    readonly gate: Deferred.Deferred<
      NodeHostActorRuntime,
      NodeHostActorRuntimeError
    >;
  };
  Active: { readonly runtime: NodeHostActorRuntime };
}>;
const ActorEntry = Data.taggedEnum<ActorEntry>();

/** `Closed` atomically prevents new publication before disposal starts. */
type ManagerState = Data.TaggedEnum<{
  Open: { readonly entries: HashMap.HashMap<string, ActorEntry> };
  Closed: {};
}>;
const ManagerState = Data.taggedEnum<ManagerState>();

/** Decision made while holding the synchronized state lock. */
type ActorSelection = Data.TaggedEnum<{
  Activate: {
    readonly gate: Deferred.Deferred<
      NodeHostActorRuntime,
      NodeHostActorRuntimeError
    >;
  };
  Await: {
    readonly gate: Deferred.Deferred<
      NodeHostActorRuntime,
      NodeHostActorRuntimeError
    >;
  };
  Reuse: { readonly runtime: NodeHostActorRuntime };
  Closed: {};
}>;
const ActorSelection = Data.taggedEnum<ActorSelection>();

/**
 * Build the daemon manager around its named actor-activation service.
 *
 * `NodeDaemonHostActorRuntimeActivator` is daemon infrastructure. It is read
 * once here and is never provided to any actor `ManagedRuntime`.
 */
export const makeNodeHostRuntimeManager: Effect.Effect<
  NodeHostRuntimeManagerOperations,
  never,
  Scope.Scope | NodeDaemonHostActorRuntimeActivator
> = Effect.gen(function* () {
  const runtimeActivator = yield* NodeDaemonHostActorRuntimeActivator;
  const state = yield* SynchronizedRef.make<ManagerState>(
    ManagerState.Open({ entries: HashMap.empty() }),
  );

  yield* Effect.addFinalizer(() => closeManager(state));

  /**
   * Resolve one host actor for this request.
   *
   * Concurrent callers for the same `hostId` share one activation attempt:
   * the first publishes `Activating` and runs `activateAndPublish`; later
   * callers `Await` that same Deferred. Waiters receive that attempt's shared
   * success or failure and do not retry here. A later independent request can
   * start a fresh activation only after a failed attempt removes the entry.
   */
  const getOrActivate = (
    hostId: string,
  ): Effect.Effect<NodeHostActorRuntime, NodeHostActorRuntimeError> =>
    Effect.gen(function* () {
      const candidateGate = yield* Deferred.make<
        NodeHostActorRuntime,
        NodeHostActorRuntimeError
      >();
      const selection = yield* SynchronizedRef.modify(
        state,
        (snapshot): readonly [ActorSelection, ManagerState] =>
          ManagerState.$match(snapshot, {
            Closed: () => [ActorSelection.Closed(), snapshot] as const,
            Open: ({ entries }) =>
              Option.match(HashMap.get(entries, hostId), {
                onNone: () =>
                  [
                    ActorSelection.Activate({ gate: candidateGate }),
                    ManagerState.Open({
                      entries: HashMap.set(
                        entries,
                        hostId,
                        ActorEntry.Activating({ gate: candidateGate }),
                      ),
                    }),
                  ] as const,
                onSome: ActorEntry.$match({
                  Activating: ({ gate }) =>
                    [ActorSelection.Await({ gate }), snapshot] as const,
                  Active: ({ runtime }) =>
                    [ActorSelection.Reuse({ runtime }), snapshot] as const,
                }),
              }),
          }),
      );

      return yield* ActorSelection.$match(selection, {
        Closed: () => Effect.fail(managerClosedError(hostId)),
        Reuse: ({ runtime }) => Effect.succeed(runtime),
        // Same-host waiters share this attempt's outcome; no local retry.
        Await: ({ gate }) => Deferred.await(gate),
        Activate: ({ gate }) =>
          activateAndPublish({ hostId, gate, runtimeActivator, state }),
      });
    });

  return {
    dispatch: (input) =>
      getOrActivate(input.hostId).pipe(
        Effect.flatMap((runtime) => runtime.dispatch(input)),
      ),
  } satisfies NodeHostRuntimeManagerOperations;
});

/**
 * Authoritative in-process owner of active host actors inside the Node daemon.
 *
 * The service is intentionally absent from public HTTP ingress and from every
 * actor `ManagedRuntime`. Its package-owned Layer requires the
 * daemon-owned `NodeDaemonHostActorRuntimeActivator`; closing the manager Layer
 * stops publication and disposes all runtimes accumulated in its map.
 */
export class NodeHostRuntimeManager extends Context.Service<NodeHostRuntimeManager>()(
  "@ptools/host-node/hostActorDaemon/NodeHostRuntimeManager",
  { make: makeNodeHostRuntimeManager },
) {
  static readonly layer = Layer.effect(this, this.make);
}

/**
 * Finish one claimed activation after `getOrActivate` already published
 * `Activating { gate }` for this `hostId`.
 *
 * Why `uninterruptibleMask`:
 * Interruption here means permanently stopping this fiber (request abort,
 * timeout, scope close) — not pausing to run another fiber. By the time this
 * runs, other same-host callers may already be waiting on `gate`. If this
 * fiber died after claiming `Activating` but before map update +
 * `Deferred.done`, that entry would stick forever and waiters would hang.
 *
 * The mask makes cleanup uninterruptible by default. `restore(...)` reopens
 * interruptibility only around the long `activate(...)` call so activation
 * itself can still be cancelled. After activation returns (success, failure,
 * or interrupt captured as `Exit`), publication and Deferred completion must
 * still run so waiters always unblock.
 *
 * Failure workflow:
 * - Failed/interrupted activation removes the map entry and completes `gate`
 *   with that shared failure. Concurrent waiters fail the same way and do not
 *   retry inside this manager.
 * - A later independent request can claim `Activating` again because the entry
 *   is gone.
 * - If the manager closed while activation succeeded, dispose the runtime and
 *   publish a closed failure instead of installing `Active`.
 */
const activateAndPublish = (input: {
  readonly hostId: string;
  readonly gate: Deferred.Deferred<
    NodeHostActorRuntime,
    NodeHostActorRuntimeError
  >;
  readonly runtimeActivator: NodeDaemonHostActorRuntimeActivatorOperations;
  readonly state: SynchronizedRef.SynchronizedRef<ManagerState>;
}): Effect.Effect<NodeHostActorRuntime, NodeHostActorRuntimeError> =>
  // Default: uninterruptible. `restore` makes only activation cancellable.
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      // Long work may still be interrupted; capture outcome without skipping cleanup.
      const activationExit = yield* restore(
        input.runtimeActivator.activate(input.hostId),
      ).pipe(Effect.exit);

      // Uninterruptible from here: always publish Active, clear failure, or
      // treat the claim as closed before releasing waiters.
      const managerWasClosed = yield* SynchronizedRef.modify(
        input.state,
        (snapshot) =>
          ManagerState.$match(snapshot, {
            Closed: () => [true, snapshot] as const,
            Open: ({ entries }) => {
              const current = HashMap.get(entries, input.hostId);
              const ownsEntry = Option.exists(
                current,
                ActorEntry.$match({
                  Activating: ({ gate }) => gate === input.gate,
                  Active: () => false,
                }),
              );
              // Manager closed or another owner replaced this claim.
              if (!ownsEntry) return [true, snapshot] as const;

              return Exit.match(activationExit, {
                // Clear Activating so a future request can retry activation.
                onFailure: () =>
                  [
                    false,
                    ManagerState.Open({
                      entries: HashMap.remove(entries, input.hostId),
                    }),
                  ] as const,
                onSuccess: (runtime) =>
                  [
                    false,
                    ManagerState.Open({
                      entries: HashMap.set(
                        entries,
                        input.hostId,
                        ActorEntry.Active({ runtime }),
                      ),
                    }),
                  ] as const,
              });
            },
          }),
      );

      const publishedExit = managerWasClosed
        ? Exit.fail(managerClosedError(input.hostId))
        : activationExit;

      // Succeeded activate after close must not leak the unused runtime.
      if (managerWasClosed && Exit.isSuccess(activationExit)) {
        yield* activationExit.value.dispose.pipe(
          Effect.catch((error) => reportDisposalFailure(error)),
        );
      }
      // Unblock this caller and every same-host waiter with one shared Exit.
      yield* Deferred.done(input.gate, publishedExit);
      return yield* Deferred.await(input.gate);
    }),
  );

/**
 * Stop new actor publication, snapshot the current entries, unblock pending
 * activations, and attempt every active runtime disposal independently.
 */
const closeManager = (
  state: SynchronizedRef.SynchronizedRef<ManagerState>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const entries = yield* SynchronizedRef.modify(state, (snapshot) =>
      ManagerState.$match(snapshot, {
        Closed: () => [HashMap.empty<string, ActorEntry>(), snapshot] as const,
        Open: ({ entries }) => [entries, ManagerState.Closed()] as const,
      }),
    );

    yield* Effect.forEach(
      HashMap.toEntries(entries),
      ([hostId, entry]) =>
        ActorEntry.$match(entry, {
          Activating: ({ gate }) =>
            Deferred.fail(gate, managerClosedError(hostId)),
          Active: ({ runtime }) =>
            runtime.dispose.pipe(
              Effect.catch((error) => reportDisposalFailure(error)),
            ),
        }),
      { concurrency: "unbounded", discard: true },
    );
  });

/** Typed rejection used after the daemon manager begins closing. */
const managerClosedError = (hostId: string) =>
  new NodeHostActorRuntimeError({
    hostId,
    phase: NodeHostActorRuntimePhase.Execute,
    message: "Node host runtime manager is closed.",
  });

/** Report one disposal failure without preventing cleanup of other actors. */
const reportDisposalFailure = (
  error: NodeHostActorRuntimeError,
): Effect.Effect<void> =>
  Effect.logError(
    `Failed to dispose Node host actor ${error.hostId}: ${error.message}`,
  ).pipe(Effect.annotateLogs("cause", error.cause));
