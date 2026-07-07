/**
 * Node platform adapters for shared host storage primitives.
 *
 * The primitives keep logical keys exact and platform-neutral. Node owns the
 * physical filesystem/keyring namespace, including host-id scoping for secret
 * values.
 */
import * as KeyValueStore from "@effect/platform/KeyValueStore";
import * as NodeKeyValueStore from "@effect/platform-node/NodeKeyValueStore";
import { AsyncEntry } from "@napi-rs/keyring";
import {
  HostSecretStorage,
  HostStateStorage,
  HostStorageError,
  type HostStorageOperations,
} from "@ptools/config";
import { Effect, Layer, Option } from "effect";
import { NodeHostIdentity } from "./hostIdentity.js";

export const NodeFileHostStateStorageLive = (directory: string): Layer.Layer<
  HostStateStorage,
  HostStorageError
> =>
  Layer.effect(
    HostStateStorage,
    Effect.gen(function* () {
      const store = yield* KeyValueStore.KeyValueStore;
      return makeKeyValueStoreHostStorage(store, "state");
    }),
  ).pipe(
    Layer.provide(
      NodeKeyValueStore.layerFileSystem(directory).pipe(
        Layer.mapError(
          (cause) =>
            new HostStorageError({
              storage: "state",
              operation: "get",
              key: directory,
              cause,
            }),
        ),
      ),
    ),
  );

/** Keyring-backed secret storage scoped by Node host id. */
export const NodeKeyringHostSecretStorageLive = (options: {
  readonly serviceName: string;
}): Layer.Layer<HostSecretStorage, never, NodeHostIdentity> =>
  Layer.effect(
    HostSecretStorage,
    Effect.gen(function* () {
      const identity = yield* NodeHostIdentity;
      const hostKeyPrefix = `hosts/${encodeHostId(identity.hostId)}/`;
      const physicalKey = (logicalKey: string) => `${hostKeyPrefix}${logicalKey}`;

      return HostSecretStorage.of({
        get: (key) =>
          Effect.tryPromise({
            try: () => new AsyncEntry(options.serviceName, physicalKey(key)).getPassword(),
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
      });
    }),
  );

const makeKeyValueStoreHostStorage = (
  store: KeyValueStore.KeyValueStore,
  storage: "state",
): HostStorageOperations => ({
  get: (key) =>
    store.get(key).pipe(
      Effect.mapError(
        (cause) =>
          new HostStorageError({ storage, operation: "get", key, cause }),
      ),
    ),
  put: (key, value) =>
    store.set(key, value).pipe(
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

export const encodeHostId = (hostId: string): string =>
  encodeURIComponent(hostId);
