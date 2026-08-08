/**
 * @file Native cross-process ownership for one foreground Node control plane.
 *
 * The persistent lock is the only process-identity authority. A foreground
 * `start` command retains its descriptor for the complete Effect scope; closing
 * that scope releases ownership. No HTTP client receives lifecycle authority,
 * and no readiness or administration credential file is published.
 */
import { open, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { Data, Effect, Scope } from "effect";
import { NODE_HOST_ACTOR_DAEMON_LOCK_FILE } from "../../hostActorDaemon/ownership/nodeHostActorDaemonOwnership.js";

/** Persistent kernel-lock target retained across foreground process runs. */
export const NODE_HOST_CONTROL_PLANE_LOCK_FILE = "control-plane.owner.lock";

/** Typed failure for lock acquisition and quiescence probes. */
export class NodeHostControlPlaneOwnershipError extends Data.TaggedError(
  "NodeHostControlPlaneOwnershipError",
)<{ readonly message: string; readonly cause?: unknown }> {}

/**
 * Holds exclusive ownership until the surrounding Effect scope closes.
 * The lock file itself remains persistent; only its native lock and open file
 * descriptor represent live ownership.
 */
export const acquireNodeHostControlPlaneOwnership = (
  stateDirectory: string,
): Effect.Effect<void, NodeHostControlPlaneOwnershipError, Scope.Scope> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise({
      try: () => mkdir(stateDirectory, { recursive: true, mode: 0o700 }),
      catch: (cause) =>
        ownershipError(
          "Unable to create control-plane state directory.",
          cause,
        ),
    });
    const lockFile = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () =>
          open(
            join(stateDirectory, NODE_HOST_CONTROL_PLANE_LOCK_FILE),
            "a+",
            0o600,
          ),
        catch: (cause) =>
          ownershipError("Unable to open control-plane ownership lock.", cause),
      }),
      (file) => Effect.promise(() => file.close()).pipe(Effect.ignore),
    );
    const acquired = yield* Effect.try({
      try: () => loadNativeLock().tryLock(lockFile.fd),
      catch: (cause) =>
        ownershipError(
          "Unable to acquire control-plane ownership lock.",
          cause,
        ),
    });
    if (!acquired)
      return yield* new NodeHostControlPlaneOwnershipError({
        message: "The Node Host Control-Plane is already running.",
      });
  });

/**
 * Proves both deployment daemons are stopped before infrastructure settings may
 * change. Native lock probes are authoritative; PID and port guesses are not.
 */
export const assertNodeDeploymentStateQuiescent = (
  stateDirectory: string,
): Effect.Effect<void, NodeHostControlPlaneOwnershipError> =>
  Effect.all(
    [
      probeUnlocked(stateDirectory, NODE_HOST_CONTROL_PLANE_LOCK_FILE),
      probeUnlocked(stateDirectory, NODE_HOST_ACTOR_DAEMON_LOCK_FILE),
    ],
    { concurrency: "unbounded", discard: true },
  );

/** Opens the persistent lock target and closes it after the ownership probe. */
const probeUnlocked = (
  directory: string,
  fileName: string,
): Effect.Effect<void, NodeHostControlPlaneOwnershipError> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise({
      try: () => mkdir(directory, { recursive: true, mode: 0o700 }),
      catch: (cause) =>
        ownershipError("Unable to create deployment state directory.", cause),
    });
    yield* Effect.acquireUseRelease(
      Effect.tryPromise({
        try: () => open(join(directory, fileName), "a+", 0o600),
        catch: (cause) =>
          ownershipError(`Unable to open deployment lock ${fileName}.`, cause),
      }),
      (file) =>
        Effect.try({
          try: () => loadNativeLock().tryLock(file.fd),
          catch: (cause) =>
            ownershipError(`Unable to probe deployment lock ${fileName}.`, cause),
        }).pipe(
          Effect.flatMap((unlocked) =>
            unlocked
              ? Effect.void
              : Effect.fail(
                  new NodeHostControlPlaneOwnershipError({
                    message: `Deployment state is active (${fileName} is owned); stop it before configuring.`,
                  }),
                ),
          ),
        ),
      (file) => Effect.promise(() => file.close()).pipe(Effect.ignore),
    );
  });

type NativeLock = { readonly tryLock: (fd: number) => boolean };
const require = createRequire(import.meta.url);
const loadNativeLock = (): NativeLock =>
  require("fs-native-extensions") as NativeLock;
const ownershipError = (message: string, cause?: unknown) =>
  new NodeHostControlPlaneOwnershipError({ message, cause });
