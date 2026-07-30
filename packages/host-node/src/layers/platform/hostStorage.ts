/**
 * Node implementations of the shared physical host-storage backend ports.
 *
 * These adapters receive a host ID through `forHost(...)`, derive Node-specific
 * filesystem/keyring namespaces, and return exact-key operations. Shared
 * `HostStateStorage.layer` and `HostSecretStorage.layer` own the step that
 * obtains `HostIdentity` and invokes these backends.
 */
import { KeyValueStore } from "effect/unstable/persistence";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { AsyncEntry } from "@napi-rs/keyring";
import {
  HostSecretStorageBackend,
  HostStateStorageBackend,
  HostStorageError,
  type HostStorageOperations,
} from "@ptools/config";
import { createHash } from "node:crypto";
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

      return KeyValueStore.layerFileSystem(hostDirectory).pipe(
        Layer.provide(NodeServices.layer),
        Layer.build,
        Effect.mapError(
          (cause) =>
            new HostStorageError({
              storage: "state",
              operation: "open",
              key: hostDirectory,
              cause,
            }),
        ),
        Effect.map((context) =>
          makeKeyValueStoreHostStorage(
            Context.get(context, KeyValueStore.KeyValueStore),
            "state",
          ),
        ),
      );
    },
  });

/**
 * Opaque keyring namespace for one daemon/profile state home.
 *
 * File-backed state is already partitioned by `internalStateDirectory`. The OS
 * keyring has no directory tree, so we hash that path into the account name:
 * different state homes get different prefixes (no secret collisions across
 * profiles), while the raw filesystem path never appears in keyring entries.
 */
export const nodeKeyringStateNamespaceDigest = (
  internalStateDirectory: string,
): string =>
  createHash("sha256").update(internalStateDirectory, "utf8").digest("hex");

/**
 * Physical keyring account prefix for one `(state home, hostId)` pair.
 *
 * Mirrors filesystem isolation (`<stateRoot>/<encodedHostId>/...`) as
 * `namespaces/v1/<digest>/hosts/<encodedHostId>/` so keyring secrets stay
 * partitioned on the same two axes as file state.
 */
export const nodeKeyringHostSecretAccountPrefix = (
  internalStateDirectory: string,
  hostId: string,
): string =>
  `namespaces/v1/${nodeKeyringStateNamespaceDigest(internalStateDirectory)}/hosts/${encodeHostId(hostId)}/`;

/**
 * OS-keyring implementation of `HostSecretStorageBackend`.
 *
 * Shared `HostSecretStorage.layer` resolves `HostIdentity` and calls
 * `forHost(...)`; this layer only owns Node-specific physical naming. Callers
 * use short logical keys; `physicalKey` prefixes them before `@napi-rs/keyring`
 * so get/put/delete stay isolated by state home and host ID without storing
 * the raw state path in account names.
 */
export const NodeKeyringHostSecretStorageBackendLayer = (options: {
  readonly serviceName: string;
  readonly internalStateDirectory: string;
}): Layer.Layer<HostSecretStorageBackend> => {
  const stateNamespaceDigest = nodeKeyringStateNamespaceDigest(
    options.internalStateDirectory,
  );

  return Layer.succeed(HostSecretStorageBackend, {
    forHost: (hostId) => {
      // Same prefix shape as `nodeKeyringHostSecretAccountPrefix`; inlined so
      // the digest is computed once per backend rather than per operation.
      const hostKeyPrefix = `namespaces/v1/${stateNamespaceDigest}/hosts/${encodeHostId(hostId)}/`;
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
          }).pipe(Effect.map(Option.fromNullishOr)),
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
};

const makeKeyValueStoreHostStorage = (
  store: KeyValueStore.KeyValueStore,
  storage: "state",
): HostStorageOperations => ({
  get: (key) =>
    store.get(key).pipe(
      Effect.map(Option.fromNullishOr),
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
