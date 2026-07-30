/**
 * @file Heartbeat leases and operation admission for one daemon process.
 *
 * Public Node servers acquire and renew leases through private RPC. A valid
 * lease admits an operation and increments in-flight work; admitted work may
 * finish after lease expiry. Zero leases starts graceful shutdown.
 *
 * All decisions are serialized through `SynchronizedRef`. This service does
 * not own the RPC listener, process lock, or actor runtimes.
 */
import { randomUUID } from "node:crypto";
import {
  Clock,
  Context,
  Data,
  Deferred,
  Duration,
  Effect,
  HashMap,
  HashSet,
  Option,
  Scope,
  SynchronizedRef,
  Layer,
} from "effect";
import {
  NodeDaemonLeaseRejected,
  type NodeDaemonLeaseReleaseResult,
  type NodeDaemonServerLease,
} from "../../rpc/nodeHostActorDaemonRpcContracts.js";

export interface NodeHostActorDaemonLeaseOptions {
  readonly leaseTtlMs: number;
  readonly zeroLeaseGraceMs: number;
  readonly expirationSweepMs: number;
  readonly shutdownDrainTimeoutMs: number;
}

export const DEFAULT_NODE_HOST_ACTOR_DAEMON_LEASE_OPTIONS: NodeHostActorDaemonLeaseOptions =
  {
    leaseTtlMs: 15_000,
    zeroLeaseGraceMs: 30_000,
    expirationSweepMs: 1_000,
    shutdownDrainTimeoutMs: 30_000,
  };

interface LeaseRecord {
  readonly expiresAtEpochMs: number;
}

type RenewDecision =
  | { readonly _tag: "Renewed" }
  | {
      readonly _tag: "Rejected";
      readonly reason: "unknown" | "expired" | "shutting-down";
      readonly schedule: Option.Option<number>;
    };

interface ReleaseDecision {
  readonly result: NodeDaemonLeaseReleaseResult;
  readonly schedule: Option.Option<number>;
}

interface AdmissionDecision {
  readonly status: "admitted" | "unknown" | "expired" | "shutting-down";
  readonly schedule: Option.Option<number>;
}

class LeaseState extends Data.Class<{
  readonly leases: HashMap.HashMap<string, LeaseRecord>;
  /** IDs issued during this daemon lifetime, retained to distinguish expiry. */
  readonly knownLeaseIds: HashSet.HashSet<string>;
  readonly acceptingOperations: boolean;
  readonly inFlightOperations: number;
  /** Incrementing token logically cancels previously scheduled grace timers. */
  readonly zeroLeaseGeneration: number;
}> {}

export interface NodeHostActorDaemonLeaseManagerOperations {
  /** Create one unguessable heartbeat lease unless shutdown already started. */
  readonly acquire: Effect.Effect<
    NodeDaemonServerLease,
    NodeDaemonLeaseRejected
  >;
  /** Extend one known, unexpired lease from the daemon's current clock. */
  readonly renew: (
    leaseId: string,
  ) => Effect.Effect<NodeDaemonServerLease, NodeDaemonLeaseRejected>;
  /** Idempotently release one lease and start grace when it was the last. */
  readonly release: (
    leaseId: string,
  ) => Effect.Effect<NodeDaemonLeaseReleaseResult>;
  /**
   * Wrap one operation with daemon-wide lease admission and in-flight tracking.
   *
   * Calling this function only builds a new lazy Effect; the lease manager does
   * not interpret the operation or know which actor will handle it. When the
   * returned Effect runs, the manager atomically validates `leaseId` and
   * increments `inFlightOperations` before starting `operation`. It always
   * decrements that count after the operation succeeds, fails, or is
   * interrupted.
   *
   * Keeping the complete bracket here prevents an ingress adapter from
   * forgetting cleanup or attaching an admission permit to the wrong scope.
   * The RPC middleware is the current caller and passes its downstream handler
   * Effect as `operation`; actor selection and execution remain downstream.
   */
  readonly withOperationAdmission: (
    leaseId: string,
  ) => <A, E, R>(
    operation: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | NodeDaemonLeaseRejected, R>;
  /** Completes once zero-lease grace expires and admission has stopped. */
  readonly awaitShutdown: Effect.Effect<void>;
  /** Permanently reject new leases and operation admission. */
  readonly stopAdmission: Effect.Effect<void>;
  /** Wait for admitted work, bounded by the configured shutdown timeout. */
  readonly drain: Effect.Effect<void>;
}

/**
 * Build the daemon's single shared lease and admission state owner.
 *
 * Three boundaries use the returned value, all observing the same
 * `SynchronizedRef`: RPC lease procedures acquire/renew/release caller leases;
 * RPC operation middleware brackets downstream handler execution with
 * `withOperationAdmission`; and daemon shutdown awaits zero leases, stops new
 * admission, then drains the in-flight count before actors are disposed.
 *
 * The manager never selects an actor or interprets a host operation. Its
 * background expiry sweep and zero-lease grace timers belong to the supplied
 * service scope and are interrupted when that scope closes.
 */
export const makeNodeHostActorDaemonLeaseManager = (
  options: NodeHostActorDaemonLeaseOptions,
): Effect.Effect<
  NodeHostActorDaemonLeaseManagerOperations,
  never,
  Scope.Scope
> =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const state = yield* SynchronizedRef.make(
      new LeaseState({
        leases: HashMap.empty(),
        knownLeaseIds: HashSet.empty(),
        acceptingOperations: true,
        inFlightOperations: 0,
        zeroLeaseGeneration: 0,
      }),
    );
    const shutdown = yield* Deferred.make<void>();

    /**
     * Start a non-blocking zero-lease timer owned by the manager's service
     * scope. This function is also called later from RPC-triggered service
     * methods, whose request scopes end too early for the timer. `forkIn(scope)`
     * therefore keeps the timer alive after that request returns, while still
     * interrupting it when the lease manager itself is disposed.
     *
     * Timers are logically cancelled rather than manually cleared: acquiring a
     * lease increments `zeroLeaseGeneration`, so an older timer wakes, sees a
     * different generation, and leaves shutdown unchanged.
     */
    const scheduleZeroLeaseGrace = (generation: number) =>
      Effect.sleep(Duration.millis(options.zeroLeaseGraceMs)).pipe(
        Effect.flatMap(() =>
          SynchronizedRef.modify(state, (snapshot) => {
            const shouldShutdown =
              snapshot.acceptingOperations &&
              HashMap.isEmpty(snapshot.leases) &&
              snapshot.zeroLeaseGeneration === generation;
            return [
              shouldShutdown,
              shouldShutdown
                ? new LeaseState({
                    ...snapshot,
                    acceptingOperations: false,
                  })
                : snapshot,
            ] as const;
          }),
        ),
        Effect.flatMap((shouldShutdown) =>
          shouldShutdown ? Deferred.succeed(shutdown, undefined) : Effect.void,
        ),
        Effect.forkIn(scope),
        Effect.asVoid,
      );

    const scheduleIfNeeded = (generation: Option.Option<number>) =>
      Option.match(generation, {
        onNone: () => Effect.void,
        onSome: scheduleZeroLeaseGrace,
      });

    // A newly spawned daemon with no lease must eventually exit if its launcher
    // disappears before acquiring one.
    yield* scheduleZeroLeaseGrace(0);

    const acquire = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const leaseId = randomUUID();
      const expiresAtEpochMs = now + options.leaseTtlMs;
      const accepted = yield* SynchronizedRef.modify(state, (snapshot) => {
        if (!snapshot.acceptingOperations) return [false, snapshot] as const;
        const leases = removeExpired(snapshot.leases, now);
        return [
          true,
          new LeaseState({
            ...snapshot,
            leases: HashMap.set(leases, leaseId, { expiresAtEpochMs }),
            knownLeaseIds: HashSet.add(snapshot.knownLeaseIds, leaseId),
            zeroLeaseGeneration: snapshot.zeroLeaseGeneration + 1,
          }),
        ] as const;
      });
      if (!accepted) {
        return yield* leaseRejected(leaseId, "shutting-down");
      }
      return { leaseId, expiresAtEpochMs } satisfies NodeDaemonServerLease;
    });

    const renew = (leaseId: string) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const expiresAtEpochMs = now + options.leaseTtlMs;
        const result = yield* SynchronizedRef.modify(
          state,
          (snapshot): readonly [RenewDecision, LeaseState] => {
            if (!snapshot.acceptingOperations) {
              return [
                {
                  _tag: "Rejected",
                  reason: "shutting-down",
                  schedule: Option.none(),
                },
                snapshot,
              ] as const;
            }
            const hadLease = HashSet.has(snapshot.knownLeaseIds, leaseId);
            const leases = removeExpired(snapshot.leases, now);
            const active = HashMap.has(leases, leaseId);
            if (!active) {
              const generation = HashMap.isEmpty(leases)
                ? snapshot.zeroLeaseGeneration + 1
                : snapshot.zeroLeaseGeneration;
              return [
                {
                  _tag: "Rejected",
                  reason: hadLease ? "expired" : "unknown",
                  schedule: HashMap.isEmpty(leases)
                    ? Option.some(generation)
                    : Option.none(),
                },
                new LeaseState({
                  ...snapshot,
                  leases,
                  zeroLeaseGeneration: generation,
                }),
              ] as const;
            }
            return [
              { _tag: "Renewed" },
              new LeaseState({
                ...snapshot,
                leases: HashMap.set(leases, leaseId, { expiresAtEpochMs }),
                zeroLeaseGeneration: snapshot.zeroLeaseGeneration + 1,
              }),
            ] as const;
          },
        );
        if (result._tag === "Rejected") {
          yield* scheduleIfNeeded(result.schedule);
          return yield* leaseRejected(leaseId, result.reason);
        }
        return { leaseId, expiresAtEpochMs } satisfies NodeDaemonServerLease;
      });

    const release = (leaseId: string) =>
      SynchronizedRef.modify(
        state,
        (snapshot): readonly [ReleaseDecision, LeaseState] => {
          const existed = HashMap.has(snapshot.leases, leaseId);
          if (!existed) {
            return [
              {
                result: {
                  _tag: "NotFound",
                } satisfies NodeDaemonLeaseReleaseResult,
                schedule: Option.none<number>(),
              },
              snapshot,
            ] as const;
          }
          const leases = HashMap.remove(snapshot.leases, leaseId);
          const generation = snapshot.zeroLeaseGeneration + 1;
          return [
            {
              result: {
                _tag: "Released",
              } satisfies NodeDaemonLeaseReleaseResult,
              schedule: HashMap.isEmpty(leases)
                ? Option.some(generation)
                : Option.none<number>(),
            },
            new LeaseState({
              ...snapshot,
              leases,
              zeroLeaseGeneration: generation,
            }),
          ] as const;
        },
      ).pipe(
        Effect.flatMap((value) =>
          scheduleIfNeeded(value.schedule).pipe(Effect.as(value.result)),
        ),
      );

    /**
     * Validate one lease and claim one in-flight slot before downstream work
     * starts. This is the acquire half of `withOperationAdmission`.
     *
     * Validation and increment happen in one `SynchronizedRef.modify`, so
     * shutdown cannot slip between "lease accepted" and "operation tracked".
     */
    const acquireOperationAdmission = (leaseId: string) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const admission = yield* SynchronizedRef.modify(
          state,
          (snapshot): readonly [AdmissionDecision, LeaseState] => {
            if (!snapshot.acceptingOperations) {
              return [
                { status: "shutting-down", schedule: Option.none() },
                snapshot,
              ] as const;
            }
            const hadLease = HashSet.has(snapshot.knownLeaseIds, leaseId);
            const leases = removeExpired(snapshot.leases, now);
            if (!HashMap.has(leases, leaseId)) {
              const becameEmpty =
                !HashMap.isEmpty(snapshot.leases) && HashMap.isEmpty(leases);
              const generation = becameEmpty
                ? snapshot.zeroLeaseGeneration + 1
                : snapshot.zeroLeaseGeneration;
              return [
                {
                  status: hadLease ? "expired" : "unknown",
                  schedule: becameEmpty
                    ? Option.some(generation)
                    : Option.none(),
                },
                new LeaseState({
                  ...snapshot,
                  leases,
                  zeroLeaseGeneration: generation,
                }),
              ] as const;
            }
            return [
              { status: "admitted", schedule: Option.none() },
              new LeaseState({
                ...snapshot,
                leases,
                inFlightOperations: snapshot.inFlightOperations + 1,
              }),
            ] as const;
          },
        );
        yield* scheduleIfNeeded(admission.schedule);
        if (admission.status !== "admitted") {
          return yield* leaseRejected(leaseId, admission.status);
        }
      });

    /** Release the in-flight slot claimed by `acquireOperationAdmission`. */
    const finishOperationAdmission = SynchronizedRef.update(
      state,
      (snapshot) =>
        new LeaseState({
          ...snapshot,
          inFlightOperations: Math.max(0, snapshot.inFlightOperations - 1),
        }),
    );

    /**
     * Add admission tracking around an opaque downstream Effect.
     *
     * `acquireUseRelease` keeps the lifecycle inside this state owner: it does
     * not expose a raw permit or `Scope` that middleware could retain for too
     * long. The supplied operation runs only after admission succeeds, and the
     * release action runs for every operation exit.
     */
    const withOperationAdmission =
      (leaseId: string) =>
      <A, E, R>(
        operation: Effect.Effect<A, E, R>,
      ): Effect.Effect<A, E | NodeDaemonLeaseRejected, R> =>
        Effect.acquireUseRelease(
          acquireOperationAdmission(leaseId),
          () => operation,
          () => finishOperationAdmission,
        );

    // Expiry sweep owns grace scheduling when the final heartbeat disappears.
    yield* Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const generation = yield* SynchronizedRef.modify(state, (snapshot) => {
        const leases = removeExpired(snapshot.leases, now);
        if (
          HashMap.size(leases) === HashMap.size(snapshot.leases) ||
          !HashMap.isEmpty(leases)
        ) {
          return [
            Option.none<number>(),
            new LeaseState({ ...snapshot, leases }),
          ] as const;
        }
        const next = snapshot.zeroLeaseGeneration + 1;
        return [
          Option.some(next),
          new LeaseState({ ...snapshot, leases, zeroLeaseGeneration: next }),
        ] as const;
      });
      yield* scheduleIfNeeded(generation);
    }).pipe(
      Effect.delay(Duration.millis(options.expirationSweepMs)),
      Effect.forever,
      Effect.forkScoped,
    );

    const stopAdmission = SynchronizedRef.update(
      state,
      (snapshot) =>
        new LeaseState({
          ...snapshot,
          acceptingOperations: false,
          zeroLeaseGeneration: snapshot.zeroLeaseGeneration + 1,
        }),
    );

    const drain = Effect.gen(function* () {
      const waitUntilEmpty = Effect.gen(function* () {
        while (true) {
          const inFlight = yield* SynchronizedRef.get(state).pipe(
            Effect.map((snapshot) => snapshot.inFlightOperations),
          );
          if (inFlight === 0) return;
          yield* Effect.sleep(Duration.millis(10));
        }
      });
      yield* waitUntilEmpty.pipe(
        Effect.timeoutOption(Duration.millis(options.shutdownDrainTimeoutMs)),
        Effect.asVoid,
      );
    });

    return {
      acquire,
      renew,
      release,
      withOperationAdmission,
      awaitShutdown: Deferred.await(shutdown),
      stopAdmission,
      drain,
    } satisfies NodeHostActorDaemonLeaseManagerOperations;
  });

/**
 * Daemon-wide authority for caller leases and operation admission.
 *
 * This service owns process-level activity, not actor behavior. Lease RPC
 * handlers modify caller leases, operation middleware uses
 * `withOperationAdmission` to count work while its downstream actor Effect is
 * running, and the daemon root uses `awaitShutdown` / `drain` to order cleanup.
 */
export class NodeHostActorDaemonLeaseManager extends Context.Service<NodeHostActorDaemonLeaseManager>()(
  "@ptools/host-node/hostActorDaemon/NodeHostActorDaemonLeaseManager",
  {
    make: (
      options: NodeHostActorDaemonLeaseOptions = DEFAULT_NODE_HOST_ACTOR_DAEMON_LEASE_OPTIONS,
    ) => makeNodeHostActorDaemonLeaseManager(options),
  },
) {
  static readonly layer = (
    options: NodeHostActorDaemonLeaseOptions = DEFAULT_NODE_HOST_ACTOR_DAEMON_LEASE_OPTIONS,
  ) => Layer.effect(this, this.make(options));
}

const removeExpired = (
  leases: HashMap.HashMap<string, LeaseRecord>,
  now: number,
): HashMap.HashMap<string, LeaseRecord> =>
  HashMap.filter(leases, (lease) => lease.expiresAtEpochMs > now);

const leaseRejected = (
  leaseId: string,
  reason: "unknown" | "expired" | "shutting-down",
) =>
  new NodeDaemonLeaseRejected({
    leaseId,
    reason,
    message:
      reason === "shutting-down"
        ? "The Node host-actor daemon is shutting down."
        : reason === "expired"
          ? "The Node daemon server lease has expired."
          : "The Node daemon server lease is unknown.",
  });
