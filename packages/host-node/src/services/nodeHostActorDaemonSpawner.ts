/**
 * @file Package-owned service for starting the detached Node actor daemon.
 *
 * Connection/discovery owns the decision to start. This service owns only the
 * Node process mechanism and packaged entrypoint resolution, which lets tests
 * replace process creation without mixing executable callbacks into settings.
 */
import { Context, Data, Effect, Layer } from "effect";
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

/**
 * Parent-process capability for launching the detached daemon executable.
 *
 * Building this service does not build the daemon's services or transfer the
 * current Effect context to the child. `start` only spawns a fresh Node process
 * and passes machine settings as command-line arguments. The child entrypoint
 * constructs its own independent Effect runtime and service layers.
 *
 * A `ChildProcess` can emit an error after the initial spawn handshake, when
 * Node invokes a plain JavaScript callback outside the Effect that started it.
 * Effect v4 has no separate `Runtime` value to capture at this boundary;
 * `Effect.runForkWith` starts a root fiber from a captured `Context`. Capturing
 * the parent context therefore preserves its logger references and other
 * runtime configuration for that late log instead of silently falling back to
 * an empty context where `CurrentLoggers` resolves to its defaults.
 *
 * This context remains in the parent process. It is never transferred to the
 * daemon child, which constructs its own independent runtime and services.
 */
export class NodeHostActorDaemonSpawner extends Context.Service<NodeHostActorDaemonSpawner>()(
  "@ptools/host-node/NodeHostActorDaemonSpawner",
  {
    make: Effect.gen(function* () {
      const parentContext = yield* Effect.context<never>();
      const runInParentContext = Effect.runForkWith(parentContext);
      const reportLateError = (cause: unknown): void => {
        runInParentContext(
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
) {
  static readonly layer = Layer.effect(this, this.make);
}

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
  Effect.callback<void, NodeHostActorDaemonSpawnError>((resume) => {
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
