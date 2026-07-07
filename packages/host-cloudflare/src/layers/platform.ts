import { McpOAuthStateStore } from "@ptools/auth";
import {
  HostSecretStorage,
  HostStateStorage,
  HostStorageError,
  type HostStorageOperations,
} from "@ptools/config";
import { Context, Effect, Layer, Option } from "effect";
import {
  CodeModeObjectWorkerLoader,
  type CodeModeObjectWorkerLoaderService,
} from "./executor/workerLoaderService.js";

export class CodeModeObjectIdentity extends Context.Tag(
  "@ptools/host-cloudflare/CodeModeObjectIdentity",
)<
  CodeModeObjectIdentity,
  {
    readonly hostId: string;
  }
>() {}

export class CodeModeObjectRequestOrigin extends Context.Tag(
  "@ptools/host-cloudflare/CodeModeObjectRequestOrigin",
)<
  CodeModeObjectRequestOrigin,
  {
    readonly origin: string;
  }
>() {}

/**
 * Supplies stable, object-lifetime platform values.
 *
 * `CodeModeObject` constructs stable storage/loader adapters once and reuses
 * this platform graph for platform-only workflows and the config-derived host
 * runtime. Shared services derived from those adapters, such as
 * `McpOAuthStateStore.Default`, are composed here with `Layer.provideMerge` so
 * callers do not wire them ad hoc. Request-derived values such as public origin
 * stay in separate request-scoped layers.
 */
export const CodeModeObjectPlatformLayer = (options: {
  readonly storage: DurableObjectStorage;
  readonly hostId: string;
  readonly workerLoader: CodeModeObjectWorkerLoaderService;
}): Layer.Layer<
  | HostStateStorage
  | HostSecretStorage
  | McpOAuthStateStore
  | CodeModeObjectIdentity
  | CodeModeObjectWorkerLoader
> => {
  const stateStorage = makeDurableObjectHostStorage(options.storage, "state");
  const secretStorage = makeDurableObjectHostStorage(options.storage, "secret");

  const stablePlatformLayer = Layer.mergeAll(
    Layer.succeed(HostStateStorage, stateStorage),
    Layer.succeed(HostSecretStorage, secretStorage),
    Layer.succeed(CodeModeObjectIdentity, {
      hostId: options.hostId,
    }),
    Layer.succeed(CodeModeObjectWorkerLoader, options.workerLoader),
  );

  return McpOAuthStateStore.Default.pipe(
    Layer.provideMerge(stablePlatformLayer),
  );
};

export const CodeModeObjectRequestOriginLayer = (
  origin: string,
): Layer.Layer<CodeModeObjectRequestOrigin> =>
  Layer.succeed(CodeModeObjectRequestOrigin, { origin });

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
