import { HostIdentity, HostIdentityLayer } from "@ptools/host-context";
import {
  HostSecretStorageBackend,
  HostStateStorageBackend,
  HostStorageError,
  type HostStorageOperations,
} from "@ptools/config";
import { Effect, Layer, Option } from "effect";
import {
  CodeModeObjectWorkerLoader,
  type CodeModeObjectWorkerLoaderService,
} from "./executor/workerLoaderService.js";

/**
 * Supplies stable, object-lifetime Cloudflare primitive values.
 *
 * Identity and both storage backends derive from one `DurableObjectState`, so a
 * caller cannot pair one host ID with another object's storage. Shared
 * `HostStateStorage.layer` and `HostSecretStorage.layer` later validate and
 * select these backends using the same `HostIdentity`.
 */
export const CodeModeObjectPlatformLayer = (options: {
  readonly state: DurableObjectState;
  readonly workerLoader: CodeModeObjectWorkerLoaderService;
}): Layer.Layer<
  | HostStateStorageBackend
  | HostSecretStorageBackend
  | HostIdentity
  | CodeModeObjectWorkerLoader
> => {
  const hostId = requireDurableObjectHostId(options.state);

  return Layer.mergeAll(
    HostIdentityLayer(hostId),
    CodeModeObjectHostStorageBackendLayer(options.state),
    Layer.succeed(CodeModeObjectWorkerLoader, options.workerLoader),
  );
};

/** Fail fast unless the Durable Object was selected by a stable host name. */
export const requireDurableObjectHostId = (state: DurableObjectState): string =>
  Option.fromNullishOr(state.id.name).pipe(
    Option.getOrThrowWith(
      () => new Error("CodeModeObject must be addressed by name."),
    ),
  );

/**
 * Cloudflare implementations of both physical storage backend ports.
 *
 * A Durable Object cannot dynamically open another object's storage. Each
 * backend therefore accepts only the ID of the current object and fails if
 * shared storage construction requests another host.
 */
export const CodeModeObjectHostStorageBackendLayer = (
  state: DurableObjectState,
): Layer.Layer<HostStateStorageBackend | HostSecretStorageBackend> => {
  const objectHostId = requireDurableObjectHostId(state);

  return Layer.merge(
    Layer.succeed(HostStateStorageBackend, {
      forHost: (hostId) =>
        requireCurrentObjectHost(hostId, objectHostId, "state").pipe(
          Effect.as(makeDurableObjectHostStorage(state.storage, "state")),
        ),
    }),
    Layer.succeed(HostSecretStorageBackend, {
      forHost: (hostId) =>
        requireCurrentObjectHost(hostId, objectHostId, "secret").pipe(
          Effect.as(makeDurableObjectHostStorage(state.storage, "secret")),
        ),
    }),
  );
};

const requireCurrentObjectHost = (
  requestedHostId: string,
  objectHostId: string,
  storage: "state" | "secret",
): Effect.Effect<void, HostStorageError> =>
  requestedHostId === objectHostId
    ? Effect.void
    : Effect.fail(
        new HostStorageError({
          storage,
          operation: "open",
          key: requestedHostId,
          cause: new Error(
            `Durable Object ${objectHostId} cannot provide storage for ${requestedHostId}.`,
          ),
        }),
      );

/** Durable Object implementation of the shared host storage operations. */
export const makeDurableObjectHostStorage = (
  storage: DurableObjectStorage,
  storageKind: "state" | "secret",
): HostStorageOperations => ({
  get: (key) =>
    Effect.tryPromise({
      try: () => storage.get<unknown>(key),
      catch: (cause) =>
        new HostStorageError({
          storage: storageKind,
          operation: "get",
          key,
          cause,
        }),
    }).pipe(
      Effect.flatMap((value) => {
        if (value === undefined || value === null) {
          return Effect.succeed(Option.none<string>());
        }

        if (typeof value === "string") {
          return Effect.succeed(Option.some(value));
        }

        return Effect.fail(
          new HostStorageError({
            storage: storageKind,
            operation: "get",
            key,
            cause: new TypeError(
              `Expected stored ${storageKind} value ${key} to be a string.`,
            ),
          }),
        );
      }),
    ),
  put: (key, value) =>
    Effect.tryPromise({
      try: () => storage.put(key, value),
      catch: (cause) =>
        new HostStorageError({
          storage: storageKind,
          operation: "put",
          key,
          cause,
        }),
    }),
  delete: (key) =>
    Effect.tryPromise({
      try: () => storage.delete(key),
      catch: (cause) =>
        new HostStorageError({
          storage: storageKind,
          operation: "delete",
          key,
          cause,
        }),
    }).pipe(Effect.asVoid),
});
