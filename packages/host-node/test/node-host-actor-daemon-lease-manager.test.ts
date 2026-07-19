/**
 * Tests the daemon's in-memory lease state machine without HTTP or actor
 * runtimes. Short durations exercise real expiry/grace fibers, while Deferred
 * values make operation admission and completion ordering deterministic.
 */
import { Deferred, Duration, Effect, Either, Fiber, Option } from "effect";
import { describe, expect, it } from "vitest";
import { makeNodeHostActorDaemonLeaseManager } from "../src/hostActorDaemon/leases/services/nodeHostActorDaemonLeaseManager.js";

const options = {
  leaseTtlMs: 200,
  zeroLeaseGraceMs: 40,
  expirationSweepMs: 5,
  shutdownDrainTimeoutMs: 200,
};

describe("Node host-actor daemon lease manager", () => {
  it("acquires, renews, releases, and shuts down after zero-lease grace", async () => {
    // Flow: acquire one lease, extend its deadline, release it, verify release
    // is idempotent, then observe shutdown only after the empty-lease grace.
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const manager = yield* makeNodeHostActorDaemonLeaseManager(options);
          const lease = yield* manager.acquire;
          const renewed = yield* manager.renew(lease.leaseId);
          expect(renewed.expiresAtEpochMs).toBeGreaterThanOrEqual(
            lease.expiresAtEpochMs,
          );
          expect((yield* manager.release(lease.leaseId))._tag).toBe("Released");
          expect((yield* manager.release(lease.leaseId))._tag).toBe("NotFound");
          yield* manager.awaitShutdown;
        }),
      ),
    );
  });

  it("a new lease logically cancels pending zero-lease shutdown", async () => {
    // zeroLeaseGraceMs is 40. Flow:
    // 1. acquire + release → leases empty → grace(G) scheduled for 40ms
    // 2. sleep 10ms (grace still pending) → acquire second lease → generation
    //    bumps, so when grace(G) wakes it no-ops (logical cancel, no clearTimeout)
    // 3. sleep past the original grace window → awaitShutdown must NOT complete
    // 4. release second lease → new grace → awaitShutdown completes
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const manager = yield* makeNodeHostActorDaemonLeaseManager(options);
          const first = yield* manager.acquire;
          yield* manager.release(first.leaseId);
          // Grace for the empty map is running; do not wait long enough for it.
          yield* Effect.sleep(Duration.millis(10));

          const second = yield* manager.acquire;
          // Wait longer than the cancelled grace window; shutdown must stay pending.
          yield* Effect.sleep(Duration.millis(50));
          const premature = yield* manager.awaitShutdown.pipe(
            Effect.timeoutOption(Duration.millis(5)),
          );
          expect(Option.isNone(premature)).toBe(true);

          yield* manager.release(second.leaseId);
          yield* manager.awaitShutdown;
        }),
      ),
    );
  });

  it("lets an admitted operation finish after its lease is released", async () => {
    // `entered` proves admission happened before the lease is released. `gate`
    // then keeps that admitted operation in flight while zero-lease grace
    // expires. Shutdown stops new admission, but opening the gate proves work
    // admitted earlier may still complete before `drain` returns.
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const manager = yield* makeNodeHostActorDaemonLeaseManager(options);
          const lease = yield* manager.acquire;
          const gate = yield* Deferred.make<string>();
          const entered = yield* Deferred.make<void>();
          const operation = yield* Deferred.succeed(entered, undefined).pipe(
            Effect.zipRight(Deferred.await(gate)),
            // The lease manager wraps this lazy operation without interpreting
            // it. Its in-flight slot stays held until `gate` lets the operation
            // finish and the acquire/use/release bracket runs its finalizer.
            manager.withOperationAdmission(lease.leaseId),
            Effect.forkScoped,
          );

          yield* Deferred.await(entered);
          yield* manager.release(lease.leaseId);
          yield* manager.awaitShutdown;
          yield* Deferred.succeed(gate, "finished");
          expect(yield* Fiber.join(operation)).toBe("finished");
          yield* manager.drain;
        }),
      ),
    );
  });

  it("releases operation admission after failure or interruption", async () => {
    // Admission slots must release on failure and interruption, not only on
    // success. After one failed admission and one interrupted in-flight op,
    // `drain` should complete within 30ms. A leaked slot would leave `drain`
    // waiting for the manager's 200ms shutdownDrainTimeout instead.
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const manager = yield* makeNodeHostActorDaemonLeaseManager(options);
          const lease = yield* manager.acquire;

          const failed = yield* Effect.fail("expected failure").pipe(
            manager.withOperationAdmission(lease.leaseId),
            Effect.exit,
          );
          expect(failed._tag).toBe("Failure");

          const entered = yield* Deferred.make<void>();
          const interrupted = yield* Deferred.succeed(entered, undefined).pipe(
            Effect.zipRight(Effect.never),
            manager.withOperationAdmission(lease.leaseId),
            Effect.forkScoped,
          );
          yield* Deferred.await(entered);
          yield* Fiber.interrupt(interrupted);

          yield* manager.stopAdmission;
          const drained = yield* manager.drain.pipe(
            Effect.timeoutOption(Duration.millis(30)),
          );
          expect(Option.isSome(drained)).toBe(true);
        }),
      ),
    );
  });

  it("rejects unknown and expired leases through the typed channel", async () => {
    // Exercise both rejection identities: an ID never issued by this manager is
    // `unknown`; an issued ID used after its deadline is `expired`.
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const manager = yield* makeNodeHostActorDaemonLeaseManager({
            ...options,
            leaseTtlMs: 10,
          });
          const unknown = yield* manager.renew("missing").pipe(Effect.either);
          expect(Either.isLeft(unknown)).toBe(true);
          if (Either.isLeft(unknown))
            expect(unknown.left.reason).toBe("unknown");

          const lease = yield* manager.acquire;
          yield* Effect.sleep(Duration.millis(20));
          const expired = yield* Effect.void.pipe(
            manager.withOperationAdmission(lease.leaseId),
            Effect.either,
          );
          expect(Either.isLeft(expired)).toBe(true);
          if (Either.isLeft(expired))
            expect(expired.left.reason).toBe("expired");
        }),
      ),
    );
  });
});
