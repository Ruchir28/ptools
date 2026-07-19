/**
 * @file Cross-process ownership for one Node host-actor daemon namespace.
 *
 * Created once before actors, leases, or the RPC listener. The returned
 * capability exists only while its scoped file keeps the kernel lock held. It
 * also owns credential rotation and generation-bound ready metadata.
 *
 * Effect Platform owns filesystem lifecycle. The narrow native seam exists
 * only because Node 22 and Effect Platform do not expose a cross-platform
 * kernel file-lock operation. This module does not start the listener or create
 * actor runtimes.
 */
import { FileSystem } from "@effect/platform";
import { createRequire } from "node:module";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { Effect, Schema, Scope } from "effect";
import {
  NodeHostActorDaemonAlreadyOwned,
  NodeHostActorDaemonOwnershipError,
  NodeHostActorDaemonReadyMetadataError,
} from "./nodeHostActorDaemonOwnershipError.js";

export const NODE_HOST_ACTOR_DAEMON_LOCK_FILE = "daemon.owner.lock";
export const NODE_HOST_ACTOR_DAEMON_READY_FILE = "daemon.ready.json";
export const NODE_HOST_ACTOR_DAEMON_CREDENTIAL_FILE = "daemon.credential";

/** Non-secret directions published only after the private listener is bound. */
export const NodeHostActorDaemonReadyMetadata = Schema.Struct({
  protocolVersion: Schema.String,
  ownerGeneration: Schema.String,
  pid: Schema.Number,
  startedAtEpochMs: Schema.Number,
  origin: Schema.String,
});
export type NodeHostActorDaemonReadyMetadata = Schema.Schema.Type<
  typeof NodeHostActorDaemonReadyMetadata
>;

/** Live capability produced only while this process holds the kernel lock. */
export interface NodeHostActorDaemonOwnership {
  readonly internalStateDirectory: string;
  readonly ownerGeneration: string;
  readonly pid: number;
  readonly startedAtEpochMs: number;
  /**
   * Atomically advertises the already-owning daemon's ready RPC listener. This
   * does not acquire, prove, or extend ownership; the hidden kernel lock does.
   */
  readonly publishReadyMetadata: (connection: {
    readonly origin: string;
    readonly protocolVersion: string;
  }) => Effect.Effect<void, NodeHostActorDaemonReadyMetadataError>;
}

type NativeLockModule = {
  readonly tryLock: (fd: number) => boolean;
};

const require = createRequire(import.meta.url);

/** Load and validate the untyped native addon at the smallest possible seam. */
const loadNativeLock = (): Effect.Effect<
  NativeLockModule,
  NodeHostActorDaemonOwnershipError
> =>
  Effect.try({
    try: () => {
      const candidate: unknown = require("fs-native-extensions");
      if (
        typeof candidate !== "object" ||
        candidate === null ||
        !("tryLock" in candidate) ||
        typeof candidate.tryLock !== "function"
      ) {
        throw new TypeError(
          "fs-native-extensions did not expose the expected tryLock function.",
        );
      }
      return candidate as NativeLockModule;
    },
    catch: (cause) =>
      new NodeHostActorDaemonOwnershipError({
        operation: "load-native-lock",
        message: "Unable to load the native daemon ownership lock.",
        cause,
      }),
  });

/**
 * Atomically acquire one state namespace and retain its scoped file descriptor.
 * The persistent lock file is deliberately never unlinked or replaced.
 */
export const acquireNodeHostActorDaemonOwnership = (
  internalStateDirectory: string,
): Effect.Effect<
  NodeHostActorDaemonOwnership,
  | NodeHostActorDaemonAlreadyOwned
  | NodeHostActorDaemonOwnershipError
  | NodeHostActorDaemonReadyMetadataError,
  FileSystem.FileSystem | Scope.Scope
> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem
      .makeDirectory(internalStateDirectory, { recursive: true, mode: 0o700 })
      .pipe(
        Effect.mapError(
          (cause) =>
            new NodeHostActorDaemonOwnershipError({
              operation: "open-lock-file",
              message: "Unable to create the daemon state directory.",
              cause,
            }),
        ),
      );

    const lockPath = join(
      internalStateDirectory,
      NODE_HOST_ACTOR_DAEMON_LOCK_FILE,
    );
    const lockFile = yield* fileSystem
      .open(lockPath, {
        flag: "a+",
        mode: 0o600,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new NodeHostActorDaemonOwnershipError({
              operation: "open-lock-file",
              message: "Unable to open the persistent daemon ownership file.",
              cause,
            }),
        ),
      );

    const nativeLock = yield* loadNativeLock();
    const acquired = yield* Effect.try({
      try: () => nativeLock.tryLock(Number(lockFile.fd)),
      catch: (cause) =>
        new NodeHostActorDaemonOwnershipError({
          operation: "acquire-lock",
          message: "The kernel daemon ownership lock failed.",
          cause,
        }),
    });
    if (typeof acquired !== "boolean") {
      return yield* new NodeHostActorDaemonOwnershipError({
        operation: "acquire-lock",
        message: "The native daemon ownership lock returned an invalid result.",
      });
    }
    if (!acquired) {
      return yield* new NodeHostActorDaemonAlreadyOwned({
        internalStateDirectory,
      });
    }

    const ownerGeneration = randomUUID();
    const pid = process.pid;
    const startedAtEpochMs = Date.now();

    // Registered after FileSystem.open, therefore this runs first (LIFO) while
    // the descriptor still owns the kernel lock.
    yield* Effect.addFinalizer(() =>
      invalidateReadyMetadata(
        fileSystem,
        internalStateDirectory,
        ownerGeneration,
      ).pipe(
        Effect.catchAll((error) =>
          Effect.logError(
            `Failed to invalidate Node daemon ready metadata: ${error.message}`,
          ),
        ),
      ),
    );

    // Any metadata left here belongs to a crashed previous generation. The
    // acquired kernel lock, not a PID check, makes removal safe.
    yield* removeFileIfPresent(
      fileSystem,
      join(internalStateDirectory, NODE_HOST_ACTOR_DAEMON_READY_FILE),
    );

    return {
      internalStateDirectory,
      ownerGeneration,
      pid,
      startedAtEpochMs,
      publishReadyMetadata: ({ origin, protocolVersion }) =>
        writeJsonAtomically(
          fileSystem,
          internalStateDirectory,
          NODE_HOST_ACTOR_DAEMON_READY_FILE,
          ownerGeneration,
          {
            protocolVersion,
            ownerGeneration,
            pid,
            startedAtEpochMs,
            origin,
          } satisfies NodeHostActorDaemonReadyMetadata,
          0o600,
        ),
    } satisfies NodeHostActorDaemonOwnership;
  });

/** Rotate and atomically publish the private daemon credential under the lock. */
export const publishNodeHostActorDaemonCredential = (
  ownership: NodeHostActorDaemonOwnership,
): Effect.Effect<
  string,
  NodeHostActorDaemonReadyMetadataError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const credential = randomBytes(32).toString("base64url");
    yield* writeBytesAtomically(
      fileSystem,
      ownership.internalStateDirectory,
      NODE_HOST_ACTOR_DAEMON_CREDENTIAL_FILE,
      ownership.ownerGeneration,
      new TextEncoder().encode(credential),
      0o600,
    );
    return credential;
  });

/** Read schema-validated ready metadata during daemon discovery/tests. */
export const readNodeHostActorDaemonReadyMetadata = (
  internalStateDirectory: string,
): Effect.Effect<
  NodeHostActorDaemonReadyMetadata,
  NodeHostActorDaemonReadyMetadataError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = join(
      internalStateDirectory,
      NODE_HOST_ACTOR_DAEMON_READY_FILE,
    );
    const text = yield* fileSystem.readFileString(path).pipe(
      Effect.mapError(
        (cause) =>
          new NodeHostActorDaemonReadyMetadataError({
            operation: "decode",
            message: "Unable to read daemon ready metadata.",
            cause,
          }),
      ),
    );
    const unknownValue = yield* Effect.try({
      try: () => JSON.parse(text) as unknown,
      catch: (cause) =>
        new NodeHostActorDaemonReadyMetadataError({
          operation: "decode",
          message: "Daemon ready metadata is not valid JSON.",
          cause,
        }),
    });
    return yield* Schema.decodeUnknown(NodeHostActorDaemonReadyMetadata)(
      unknownValue,
    ).pipe(
      Effect.mapError(
        (cause) =>
          new NodeHostActorDaemonReadyMetadataError({
            operation: "decode",
            message: "Daemon ready metadata does not match its schema.",
            cause,
          }),
      ),
    );
  });

const invalidateReadyMetadata = (
  fileSystem: FileSystem.FileSystem,
  internalStateDirectory: string,
  ownerGeneration: string,
): Effect.Effect<void, NodeHostActorDaemonReadyMetadataError> => {
  const path = join(internalStateDirectory, NODE_HOST_ACTOR_DAEMON_READY_FILE);
  return fileSystem.exists(path).pipe(
    Effect.mapError((cause) =>
      metadataError(
        "remove",
        "Unable to inspect daemon ready metadata.",
        cause,
      ),
    ),
    Effect.flatMap((exists) => {
      if (!exists) return Effect.void;
      return fileSystem.readFileString(path).pipe(
        Effect.flatMap((text) =>
          Effect.try({
            try: () => JSON.parse(text) as unknown,
            catch: () => undefined,
          }),
        ),
        Effect.flatMap((value) =>
          Schema.decodeUnknown(NodeHostActorDaemonReadyMetadata)(value).pipe(
            Effect.map(
              (metadata) => metadata.ownerGeneration === ownerGeneration,
            ),
            Effect.catchAll(() => Effect.succeed(true)),
          ),
        ),
        Effect.catchAll(() => Effect.succeed(true)),
        Effect.flatMap((shouldRemove) =>
          shouldRemove ? removeFileIfPresent(fileSystem, path) : Effect.void,
        ),
      );
    }),
  );
};

const writeJsonAtomically = (
  fileSystem: FileSystem.FileSystem,
  directory: string,
  fileName: string,
  generation: string,
  value: unknown,
  mode: number,
): Effect.Effect<void, NodeHostActorDaemonReadyMetadataError> =>
  writeBytesAtomically(
    fileSystem,
    directory,
    fileName,
    generation,
    new TextEncoder().encode(`${JSON.stringify(value)}\n`),
    mode,
  );

const writeBytesAtomically = (
  fileSystem: FileSystem.FileSystem,
  directory: string,
  fileName: string,
  generation: string,
  bytes: Uint8Array,
  mode: number,
): Effect.Effect<void, NodeHostActorDaemonReadyMetadataError> => {
  const target = join(directory, fileName);
  const temporary = join(
    directory,
    `${fileName}.${generation}.${randomUUID()}.tmp`,
  );
  return Effect.gen(function* () {
    yield* Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fileSystem.open(temporary, { flag: "wx", mode });
        yield* file.writeAll(bytes);
        yield* file.sync;
      }),
    );
    yield* fileSystem.rename(temporary, target);
  }).pipe(
    Effect.mapError((cause) =>
      metadataError(
        "write",
        `Unable to atomically publish ${fileName}.`,
        cause,
      ),
    ),
    Effect.ensuring(
      fileSystem.remove(temporary, { force: true }).pipe(Effect.ignore),
    ),
  );
};

const removeFileIfPresent = (
  fileSystem: FileSystem.FileSystem,
  path: string,
): Effect.Effect<void, NodeHostActorDaemonReadyMetadataError> =>
  fileSystem
    .remove(path, { force: true })
    .pipe(
      Effect.mapError((cause) =>
        metadataError(
          "remove",
          "Unable to remove stale daemon metadata.",
          cause,
        ),
      ),
    );

const metadataError = (
  operation: NodeHostActorDaemonReadyMetadataError["operation"],
  message: string,
  cause: unknown,
) => new NodeHostActorDaemonReadyMetadataError({ operation, message, cause });
