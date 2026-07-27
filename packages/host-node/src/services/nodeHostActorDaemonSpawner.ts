/**
 * @file Package-owned service for starting the detached Node actor daemon.
 *
 * Connection/discovery owns the decision to start. This service owns only the
 * Node process mechanism and packaged entrypoint resolution, which lets tests
 * replace process creation without mixing executable callbacks into settings.
 */
import { Data, Effect, Runtime } from "effect";
import { spawn as spawnChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { NodeHostActorRuntimeOptions } from "../hostActorDaemon/actorRuntime/contracts/nodeHostActorRuntimeOptions.js";

export class NodeHostActorDaemonSpawnError extends Data.TaggedError(
  "NodeHostActorDaemonSpawnError",
)<{ readonly message: string; readonly cause?: unknown }> {}

export interface NodeHostActorDaemonSpawnerOperations {
  readonly start: (
    options: NodeHostActorRuntimeOptions,
  ) => Effect.Effect<void, NodeHostActorDaemonSpawnError>;
}

/** Package-owned detached-daemon spawner with an overridable default layer. */
export class NodeHostActorDaemonSpawner extends Effect.Service<NodeHostActorDaemonSpawner>()(
  "@ptools/host-node/NodeHostActorDaemonSpawner",
  {
    effect: Effect.gen(function* () {
      const runtime = yield* Effect.runtime<never>();
      const reportLateError = (cause: unknown): void => {
        void Runtime.runFork(runtime)(
          Effect.logError(
            "Detached Node host-actor daemon process error.",
          ).pipe(Effect.annotateLogs({ cause })),
        );
      };

      return {
        start: (options) => startDetachedDaemon(options, reportLateError),
      } satisfies NodeHostActorDaemonSpawnerOperations;
    }),
  },
) {}

/**
 * Wait for Node's launch handshake instead of treating `spawn()` returning as
 * success. The uninterruptible region is intentionally narrow: once process
 * creation starts, its `spawn` or `error` event must retain an observer so an
 * interrupted caller cannot leave an unhandled ChildProcess error behind.
 */
const startDetachedDaemon = (
  options: NodeHostActorRuntimeOptions,
  reportLateError: (cause: unknown) => void,
): Effect.Effect<void, NodeHostActorDaemonSpawnError> =>
  Effect.async<void, NodeHostActorDaemonSpawnError>((resume) => {
    try {
      const runningFromTypeScript = import.meta.url.endsWith(".ts");
      const entrypoint = fileURLToPath(
        new URL(
          `../hostActorDaemon/daemonProcess/nodeHostActorDaemonEntrypoint.${runningFromTypeScript ? "ts" : "js"}`,
          import.meta.url,
        ),
      );
      const loader = runningFromTypeScript
        ? [fileURLToPath(import.meta.resolve("tsx/cli")), entrypoint]
        : [entrypoint];
      const child = spawnChildProcess(
        process.execPath,
        [
          ...loader,
          "--internal-state-directory",
          options.internalStateDirectory,
          "--keyring-service-name",
          options.keyringServiceName,
          ...(options.denoExecutable === undefined
            ? []
            : ["--deno-executable", options.denoExecutable]),
        ],
        { detached: true, stdio: "ignore" },
      );
      let started = false;

      child.once("error", (cause) => {
        if (started) {
          reportLateError(cause);
          return;
        }
        resume(
          Effect.fail(
            new NodeHostActorDaemonSpawnError({
              message: "Unable to start the detached Node host-actor daemon.",
              cause,
            }),
          ),
        );
      });
      child.once("spawn", () => {
        started = true;
        child.unref();
        resume(Effect.void);
      });
    } catch (cause) {
      resume(
        Effect.fail(
          new NodeHostActorDaemonSpawnError({
            message: "Unable to start the detached Node host-actor daemon.",
            cause,
          }),
        ),
      );
    }
  }).pipe(Effect.uninterruptible);
