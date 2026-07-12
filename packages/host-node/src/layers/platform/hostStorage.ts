/**
 * Node implementations of the shared physical host-storage backend ports.
 *
 * These adapters receive a host ID through `forHost(...)`, derive Node-specific
 * filesystem/keyring namespaces, and return exact-key operations. Shared
 * `HostStateStorage.Default` and `HostSecretStorage.Default` own the step that
 * obtains `HostIdentity` and invokes these backends.
 */
import * as KeyValueStore from "@effect/platform/KeyValueStore";
import * as NodeKeyValueStore from "@effect/platform-node/NodeKeyValueStore";
import { AsyncEntry } from "@napi-rs/keyring";
import {
  HostSecretStorageBackend,
  HostStateStorageBackend,
  HostStorageError,
  type HostStorageOperations,
} from "@ptools/config";
import { join } from "node:path";
import { Context, Effect, Layer, Option } from "effect";

/**
 * File-backed state backend rooted under `<root>/<encodedHostId>`.
 *
 * Callers provide the common host-state root. The shared final storage service
 * supplies the selected host ID to this backend.
 */
export const NodeFileHostStateStorageBackendLayer = (
  rootDirectory: string,
): Layer.Layer<HostStateStorageBackend> =>
  Layer.succeed(HostStateStorageBackend, {
    forHost: (hostId) => {
      const hostDirectory = join(rootDirectory, encodeHostId(hostId));

      return NodeKeyValueStore.layerFileSystem(hostDirectory).pipe(
        Layer.mapError(
          (cause) =>
            new HostStorageError({
              storage: "state",
              operation: "open",
              key: hostDirectory,
              cause,
            }),
        ),
        Layer.build,
        Effect.map((context) =>
          makeKeyValueStoreHostStorage(
            Context.get(context, KeyValueStore.KeyValueStore),
            "state",
          ),
        ),
      );
    },
  });

/** Keyring backend that physically prefixes secrets by the requested host ID. */
export const NodeKeyringHostSecretStorageBackendLayer = (options: {
  readonly serviceName: string;
}): Layer.Layer<HostSecretStorageBackend> =>
  Layer.succeed(HostSecretStorageBackend, {
    forHost: (hostId) => {
      const hostKeyPrefix = `hosts/${encodeHostId(hostId)}/`;
      const physicalKey = (logicalKey: string) =>
        `${hostKeyPrefix}${logicalKey}`;

      return Effect.succeed({
        get: (key) =>
          Effect.tryPromise({
            try: () =>
              new AsyncEntry(
                options.serviceName,
                physicalKey(key),
              ).getPassword(),
            catch: (cause) =>
              new HostStorageError({
                storage: "secret",
                operation: "get",
                key,
                cause,
              }),
          }).pipe(Effect.map(Option.fromNullable)),
        put: (key, value) =>
          Effect.tryPromise({
            try: () =>
              new AsyncEntry(options.serviceName, physicalKey(key)).setPassword(
                value,
              ),
            catch: (cause) =>
              new HostStorageError({
                storage: "secret",
                operation: "put",
                key,
                cause,
              }),
          }),
        delete: (key) =>
          Effect.tryPromise({
            try: async () => {
              await new AsyncEntry(options.serviceName, physicalKey(key))
                .deleteCredential()
                .catch(() => false);
            },
            catch: (cause) =>
              new HostStorageError({
                storage: "secret",
                operation: "delete",
                key,
                cause,
              }),
          }),
      } satisfies HostStorageOperations);
    },
  });

const makeKeyValueStoreHostStorage = (
  store: KeyValueStore.KeyValueStore,
  storage: "state",
): HostStorageOperations => ({
  get: (key) =>
    store
      .get(key)
      .pipe(
        Effect.mapError(
          (cause) =>
            new HostStorageError({ storage, operation: "get", key, cause }),
        ),
      ),
  put: (key, value) =>
    store
      .set(key, value)
      .pipe(
        Effect.mapError(
          (cause) =>
            new HostStorageError({ storage, operation: "put", key, cause }),
        ),
      ),
  delete: (key) =>
    store.has(key).pipe(
      Effect.flatMap((exists) => (exists ? store.remove(key) : Effect.void)),
      Effect.mapError(
        (cause) =>
          new HostStorageError({ storage, operation: "delete", key, cause }),
      ),
    ),
});

/** Encode one host ID for filesystem and keyring namespace components. */
export const encodeHostId = (hostId: string): string =>
  encodeURIComponent(hostId).replaceAll(".", "%2E");
