/**
 * Exercises the filesystem boundary that elects one daemon process per state
 * directory. These tests use real temporary files and real kernel locks; the
 * Effect scope stands in for the lifetime of the daemon process.
 */
import { FileSystem } from "@effect/platform";
import * as NodeContext from "@effect/platform-node/NodeContext";
import { Effect, Exit } from "effect";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireNodeHostActorDaemonOwnership,
  NODE_HOST_ACTOR_DAEMON_LOCK_FILE,
  NODE_HOST_ACTOR_DAEMON_READY_FILE,
} from "../src/hostActorDaemon/ownership/nodeHostActorDaemonOwnership.js";

const directories: Array<string> = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Node host-actor daemon ownership", () => {
  it("allows exactly one scoped owner and releases on scope close", async () => {
    // Flow:
    // 1. the outer scope acquires the directory's kernel lock
    // 2. a second owner targets the same directory and receives the typed
    //    already-owned failure
    // 3. closing the outer scope releases the lock but keeps its stable file
    // 4. a new scope proves another daemon can subsequently become owner
    const directory = await makeDirectory();

    await run(
      Effect.scoped(
        Effect.gen(function* () {
          yield* acquireNodeHostActorDaemonOwnership(directory);
          const contender = yield* Effect.scoped(
            acquireNodeHostActorDaemonOwnership(directory),
          ).pipe(Effect.exit);

          expect(Exit.isFailure(contender)).toBe(true);
          if (Exit.isFailure(contender)) {
            const error = contender.cause.pipe(
              // The expected typed failure is the only failure in this branch.
              (cause) => cause,
            );
            expect(String(error)).toContain("NodeHostActorDaemonAlreadyOwned");
          }
        }),
      ),
    );

    // The persistent inode remains, but its kernel lock is available again.
    await expect(
      access(join(directory, NODE_HOST_ACTOR_DAEMON_LOCK_FILE)),
    ).resolves.toBeUndefined();
    await run(Effect.scoped(acquireNodeHostActorDaemonOwnership(directory)));
  });

  it("publishes complete ready metadata and removes it before releasing ownership", async () => {
    // The owner publishes the listener address only after startup. Read the
    // actual JSON file while its scope is alive, then close the scope and prove
    // the finalizer removed that discoverable address.
    const directory = await makeDirectory();

    await run(
      Effect.scoped(
        Effect.gen(function* () {
          const ownership =
            yield* acquireNodeHostActorDaemonOwnership(directory);
          yield* ownership.publishReadyMetadata({
            origin: "http://127.0.0.1:43123",
            protocolVersion: "1",
          });
          const metadata = JSON.parse(
            yield* Effect.promise(() =>
              readFile(
                join(directory, NODE_HOST_ACTOR_DAEMON_READY_FILE),
                "utf8",
              ),
            ),
          ) as Record<string, unknown>;
          expect(metadata.ownerGeneration).toBe(ownership.ownerGeneration);
          expect(metadata.origin).toBe("http://127.0.0.1:43123");
        }),
      ),
    );

    await expect(
      access(join(directory, NODE_HOST_ACTOR_DAEMON_READY_FILE)),
    ).rejects.toThrow();
  });

  it("removes stale ready metadata only after acquiring ownership", async () => {
    // Simulate metadata left by a process that died without running finalizers.
    // Successful lock acquisition establishes that no daemon still owns the
    // namespace, at which point acquisition must remove the stale generation.
    const directory = await makeDirectory();
    const readyPath = join(directory, NODE_HOST_ACTOR_DAEMON_READY_FILE);
    await import("node:fs/promises").then(({ writeFile }) =>
      writeFile(readyPath, '{"ownerGeneration":"stale"}\n'),
    );

    await run(
      Effect.scoped(
        Effect.gen(function* () {
          yield* acquireNodeHostActorDaemonOwnership(directory);
          const exists = yield* Effect.promise(() =>
            access(readyPath).then(
              () => true,
              () => false,
            ),
          );
          expect(exists).toBe(false);
        }),
      ),
    );
  });
});

const makeDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "ptools-daemon-owner-"));
  directories.push(directory);
  return directory;
};

const run = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem>,
): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeContext.layer)));
