/**
 * Integration coverage for the caller-side daemon connection lifecycle.
 *
 * Background — a connection owns RPC resources, one renewable server lease,
 * and a heartbeat fiber beneath a replaceable child Scope. Its enclosing layer
 * scope is the safety-net owner: closing that parent must cascade through the
 * child, interrupt heartbeat, release the lease while RPC is still usable, and
 * let a zero-lease daemon shut down.
 *
 * What this proves end-to-end:
 *   1. A real daemon stays alive while a connection holds a heartbeat lease.
 *   2. Closing the connection's owner scope releases that lease.
 *   3. With zero leases left, the daemon exits after its short grace window.
 *
 * The daemon, loopback RPC transport, heartbeat lease, and connection service
 * are real. Only actor activation is omitted — this test cares about lease
 * ownership and scoped cleanup, not Host operations.
 *
 * Spawn is intentionally blocked: the test starts the daemon in-process, then
 * the connection must discover that already-ready daemon. `connectOrStart`
 * tries discovery first and only calls `spawner.start` when discovery fails;
 * the dying spawner stub makes accidental spawn paths fail loudly.
 */
import * as NodeContext from "@effect/platform-node/NodeContext";
import {
  Data,
  Effect,
  ExecutionStrategy,
  Exit,
  Fiber,
  Layer,
  Option,
  Scope,
} from "effect";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
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

class ConnectionLifecycleTestError extends Data.TaggedError(
  "ConnectionLifecycleTestError",
)<{ readonly message: string; readonly cause?: unknown }> {}

it("releases the real daemon lease when the connection owner scope closes", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "ptools-daemon-connection-scope-"),
  );

  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          // Run the daemon in this test process (not via the detached spawner).
          // Short zero-lease grace / sweep intervals keep shutdown fast once the
          // connection later releases its lease.
          const daemon = yield* runNodeHostActorDaemon({
            internalStateDirectory: directory,
            keyringServiceName: "ptools-daemon-connection-scope-test",
            leases: {
              leaseTtlMs: 60_000,
              zeroLeaseGraceMs: 2_000,
              expirationSweepMs: 20,
              shutdownDrainTimeoutMs: 1_000,
            },
          }).pipe(Effect.forkScoped);

          // Ready metadata (origin, generation, …) must exist before the
          // connection layer tries discovery.
          yield* waitForReady(directory);

          // Child scope that will own the connection layer. Closing it mid-test
          // is how we simulate "the connection owner went away" without ending
          // the whole Effect.scoped test scope (which still holds the daemon).
          const parentScope = yield* Effect.scope;
          const connectionOwnerScope = yield* Scope.fork(
            parentScope,
            ExecutionStrategy.sequential,
          );

          // Tripwire: start must never run. Discovery should succeed against the
          // in-process daemon above; if connectOrStart fell through to spawn,
          // this die would fail the test immediately.
          const unexpectedSpawnLayer = Layer.succeed(
            NodeHostActorDaemonSpawner,
            NodeHostActorDaemonSpawner.make({
              start: () =>
                Effect.die(
                  "the already-running test daemon must be discovered",
                ),
            }),
          );

          // Builds the real connection into connectionOwnerScope: discover ready
          // metadata → RPC health → AcquireServerLease → fork heartbeat renewals.
          // Finalizers for lease release / heartbeat interrupt are registered on
          // that owner scope (and its forked children), not on the test parent.
          yield* Layer.buildWithScope(
            NodeHostActorDaemonConnection.Default({
              internalStateDirectory: directory,
              keyringServiceName: "ptools-daemon-connection-scope-test",
              heartbeatIntervalMs: 25,
              startupTimeoutMs: 1_000,
              discoveryPollMs: 10,
            }).pipe(Layer.provide(unexpectedSpawnLayer)),
            connectionOwnerScope,
          );

          // Layer construction acquired a real lease; the daemon fiber must
          // still be running before we close the connection owner.
          expect(Option.isNone(yield* Fiber.poll(daemon))).toBe(true);

          // Close only the connection owner. That cascades into the connection's
          // child scope → interrupts heartbeat → ReleaseServerLease. The daemon
          // then sees zero leases, waits zeroLeaseGraceMs, and exits.
          yield* Scope.close(connectionOwnerScope, Exit.void);
          yield* Fiber.join(daemon).pipe(
            Effect.timeoutFail({
              duration: "10 seconds",
              onTimeout: () =>
                new ConnectionLifecycleTestError({
                  message:
                    "Daemon did not exit after the connection scope released its lease.",
                }),
            }),
          );
        }).pipe(Effect.provide(NodeContext.layer)),
      ),
    );

    // Daemon shutdown should have cleaned up ownership on disk too.
    await expect(
      access(join(directory, NODE_HOST_ACTOR_DAEMON_READY_FILE)),
    ).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

/** Poll until the daemon writes ready metadata with a non-empty origin. */
const waitForReady = (
  directory: string,
): Effect.Effect<void, ConnectionLifecycleTestError> =>
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
          if (typeof parsed.origin === "string" && parsed.origin.length > 0) {
            return;
          }
        } catch (cause) {
          lastCause = cause;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      throw new Error("Timed out waiting for daemon ready metadata.", {
        cause: lastCause,
      });
    },
    catch: (cause) =>
      new ConnectionLifecycleTestError({
        message:
          cause instanceof Error
            ? cause.message
            : "Unable to wait for daemon ready metadata.",
        cause,
      }),
  });
