/**
 * Unit coverage for the detached daemon spawner's launch handshake.
 *
 * Background — Node's spawn gotcha:
 *   `child_process.spawn(...)` returns a ChildProcess object immediately, but
 *   that does not mean the OS actually launched the process. Node finishes the
 *   handshake later by emitting one of:
 *     - `spawn`  — launch succeeded
 *     - `error`  — launch failed (bad path, EAGAIN, permissions, etc.)
 *   So there is a gap between "got an object back" and "daemon is running."
 *
 *   This daemon is started with `{ detached: true }`. The parent wants to hand
 *   off and not stay coupled to the child. `unref()` tells Node not to keep the
 *   parent alive for that child — but that handoff is only safe after launch
 *   actually succeeded. The Effect adapts this with `Effect.async`, parking
 *   until `spawn` or `error` instead of trusting the synchronous return value.
 *
 * What this proves:
 *   1. `start` does not succeed merely because `spawn()` returned a ChildProcess.
 *      An asynchronous `error` event before `spawn` fails through the Effect
 *      channel as NodeHostActorDaemonSpawnError. Failed launches must not call
 *      `unref()` — there is nothing healthy to detach/orphan.
 *   2. Success and `unref()` happen only after Node emits the `spawn` event —
 *      the process was actually launched, so the caller can detach safely.
 *      Before that event, the Effect stays parked and `unref` must not run.
 *
 * `node:child_process.spawn` is mocked; no real daemon process is started.
 */
import { EventEmitter } from "node:events";
import { Effect, Either } from "effect";
import { beforeEach, expect, it, vi } from "vitest";

const { spawnChildProcess } = vi.hoisted(() => ({
  spawnChildProcess: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: spawnChildProcess,
}));

import {
  NodeHostActorDaemonSpawner,
  NodeHostActorDaemonSpawnError,
} from "../src/services/nodeHostActorDaemonSpawner.js";

beforeEach(() => {
  spawnChildProcess.mockReset();
});

it("fails through the Effect channel when ChildProcess emits an asynchronous launch error", async () => {
  // Fake child: EventEmitter stands in for ChildProcess so we can emit events.
  const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
  spawnChildProcess.mockReturnValue(child);

  // Kick off start without awaiting — it parks until spawn/error.
  const resultPromise = runStart();
  await vi.waitFor(() => expect(spawnChildProcess).toHaveBeenCalledOnce());
  const cause = new Error("spawn EAGAIN");
  child.emit("error", cause);

  const result = await resultPromise;
  expect(Either.isLeft(result)).toBe(true);
  if (Either.isLeft(result)) {
    expect(result.left).toBeInstanceOf(NodeHostActorDaemonSpawnError);
    expect(result.left.cause).toBe(cause);
  }
  // Failed launch must not detach/unref; there is nothing healthy to orphan.
  expect(child.unref).not.toHaveBeenCalled();
});

it("succeeds and unreferences the child only after Node emits spawn", async () => {
  const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
  spawnChildProcess.mockReturnValue(child);

  const resultPromise = runStart();
  await vi.waitFor(() => expect(spawnChildProcess).toHaveBeenCalledOnce());
  // Still waiting on the launch handshake — unref would be premature here.
  expect(child.unref).not.toHaveBeenCalled();
  child.emit("spawn");

  expect(Either.isRight(await resultPromise)).toBe(true);
  expect(child.unref).toHaveBeenCalledOnce();
});

/** Run Default spawner.start and capture success/failure as Either. */
const runStart = () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const spawner = yield* NodeHostActorDaemonSpawner;
      return yield* spawner
        .start({
          internalStateDirectory: "/tmp/ptools-spawner-test",
          keyringServiceName: "ptools-spawner-test",
        })
        .pipe(Effect.either);
    }).pipe(Effect.provide(NodeHostActorDaemonSpawner.Default)),
  );
