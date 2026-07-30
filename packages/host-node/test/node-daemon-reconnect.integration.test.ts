/**
 * Integration coverage for heartbeat recovery across daemon generations.
 *
 * Background — the public HTTP server owns one long-lived connection lease:
 *   Heartbeat renews that lease against the daemon generation recorded in the
 *   active connection. If the daemon disappears, the failed renewal elects one
 *   caller to reconnect. Recovery must start/discover a new owning generation,
 *   acquire its lease completely, publish it as active, and only then close the
 *   stale connection. No Host operation is replayed during this process.
 *
 * What this proves:
 *   1. Interrupting the first real daemon is detected by heartbeat and invokes
 *      the injected spawner exactly once.
 *   2. Recovery connects to a different ownerGeneration and acquires a lease
 *      that remains heartbeat-live beyond the replacement's zero-lease grace.
 *   3. The original connection owner also owns the recovered lease: closing
 *      that scope releases it and allows the replacement daemon to shut down.
 *
 * Both daemon generations, ownership locks, ready metadata, RPC listeners,
 * credentials, leases, and heartbeat traffic are real. Only process creation is
 * replaced: the test spawner forks the replacement daemon in-process so its
 * fiber and generation can be observed deterministically.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  Data,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Scope,
} from "effect";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { runNodeHostActorDaemon } from "../src/hostActorDaemon/daemonProcess/nodeHostActorDaemon.js";
import {
  NODE_HOST_ACTOR_DAEMON_READY_FILE,
  type NodeHostActorDaemonReadyMetadata,
} from "../src/hostActorDaemon/ownership/nodeHostActorDaemonOwnership.js";
import { NodeHostActorDaemonConnection } from "../src/services/nodeHostActorDaemonConnection.js";
import { NodeHostActorDaemonSpawner } from "../src/services/nodeHostActorDaemonSpawner.js";

class ReconnectTestError extends Data.TaggedError("ReconnectTestError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

it("reconnects and reacquires a lease after the owning daemon restarts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ptools-daemon-reconnect-"));
  let starts = 0;

  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          // The test parent owns both daemon fibers and the separately closable
          // connection scope, so failure cleanup cannot leave a daemon behind.
          const parentScope = yield* Effect.scope;
          const firstDaemon = yield* startDaemon(directory).pipe(
            Effect.forkIn(parentScope),
          );
          const firstReady = yield* waitForReady(directory, Option.none());
          // Deferred is the observation seam between heartbeat's plain spawner
          // capability and the test fiber that later inspects the replacement.
          const replacementStarted =
            yield* Deferred.make<Fiber.Fiber<void, unknown>>();

          // Replace only detached OS process creation. Recovery still executes
          // production connectOrStart/discovery against real filesystem and RPC.
          const spawnerLayer = Layer.succeed(
            NodeHostActorDaemonSpawner,
            NodeHostActorDaemonSpawner.of({
              start: () =>
                Effect.gen(function* () {
                  starts += 1;
                  const replacement = yield* startDaemon(directory).pipe(
                    Effect.forkIn(parentScope),
                  );
                  yield* Deferred.succeed(replacementStarted, replacement);
                }),
            }),
          );
          // Keep the connection lifetime independently closable; the test must
          // prove recovered resources remain children of this original owner.
          const connectionOwnerScope = yield* Scope.fork(
            parentScope,
            "sequential",
          );
          // Layer acquisition discovers generation one, authenticates, acquires
          // its lease, and starts heartbeat before the fault is introduced.
          yield* Layer.buildWithScope(
            NodeHostActorDaemonConnection.layer({
              internalStateDirectory: directory,
              keyringServiceName: "ptools-daemon-reconnect-test",
              heartbeatIntervalMs: 25,
              startupTimeoutMs: 5_000,
              discoveryPollMs: 10,
            }).pipe(Layer.provide(spawnerLayer)),
            connectionOwnerScope,
          );

          // Simulate daemon loss. Its ownership finalizer removes the old ready
          // metadata before heartbeat recovery starts the next generation.
          yield* Fiber.interrupt(firstDaemon);
          const replacement = yield* Deferred.await(replacementStarted).pipe(
            Effect.timeoutOrElse({
              duration: "5 seconds",
              orElse: () =>
                Effect.fail(
                  new ReconnectTestError({
                    message: "Heartbeat did not start a replacement daemon.",
                  }),
                ),
            }),
          );
          const secondReady = yield* waitForReady(
            directory,
            Option.some(firstReady.ownerGeneration),
          );
          expect(secondReady.ownerGeneration).not.toBe(
            firstReady.ownerGeneration,
          );

          // The replacement's zero-lease grace is two seconds. Remaining alive
          // beyond it proves recovery acquired and heartbeat-renewed a new lease.
          yield* Effect.sleep("2200 millis");
          expect(starts).toBe(1);
          expect(
            Option.isNone(Option.fromNullishOr(replacement.pollUnsafe())),
          ).toBe(true);

          // The recovered lease belongs to the same connection owner and must be
          // released when that owner closes, allowing replacement shutdown.
          yield* Scope.close(connectionOwnerScope, Exit.void);
          yield* Fiber.join(replacement).pipe(
            Effect.timeoutOrElse({
              duration: "10 seconds",
              orElse: () =>
                Effect.fail(
                  new ReconnectTestError({
                    message:
                      "Replacement daemon did not exit after recovered lease release.",
                  }),
                ),
            }),
          );
        }),
      ),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);

/** Run one real daemon generation with timings that make lease ownership observable. */
const startDaemon = (internalStateDirectory: string) =>
  runNodeHostActorDaemon({
    internalStateDirectory,
    keyringServiceName: "ptools-daemon-reconnect-test",
    leases: {
      leaseTtlMs: 60_000,
      zeroLeaseGraceMs: 2_000,
      expirationSweepMs: 20,
      shutdownDrainTimeoutMs: 1_000,
    },
  }).pipe(Effect.provide(NodeServices.layer));

/** Poll for ready metadata, optionally requiring a generation replacement. */
const waitForReady = (
  directory: string,
  previousGeneration: Option.Option<string>,
): Effect.Effect<NodeHostActorDaemonReadyMetadata, ReconnectTestError> =>
  Effect.tryPromise({
    try: async () => {
      const path = join(directory, NODE_HOST_ACTOR_DAEMON_READY_FILE);
      const deadline = Date.now() + 5_000;
      let lastCause: unknown;

      while (Date.now() < deadline) {
        try {
          const parsed = JSON.parse(
            await readFile(path, "utf8"),
          ) as NodeHostActorDaemonReadyMetadata;
          if (
            parsed.origin.length > 0 &&
            Option.match(previousGeneration, {
              onNone: () => true,
              onSome: (previous) => parsed.ownerGeneration !== previous,
            })
          ) {
            return parsed;
          }
        } catch (cause) {
          lastCause = cause;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      throw new Error("Timed out waiting for replacement ready metadata.", {
        cause: lastCause,
      });
    },
    catch: (cause) =>
      new ReconnectTestError({
        message:
          cause instanceof Error
            ? cause.message
            : "Unable to wait for daemon ready metadata.",
        cause,
      }),
  });
