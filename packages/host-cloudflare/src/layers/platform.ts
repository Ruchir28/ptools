import { Context, Data, Effect, Layer, Option } from "effect";
import {
  CodeModeObjectWorkerLoader,
  type CodeModeObjectWorkerLoaderService,
} from "./executor/workerLoaderService.js";

export class CodeModeObjectStorageError extends Data.TaggedError(
  "CodeModeObjectStorageError",
)<{
  readonly operation: "get" | "put" | "delete" | "list";
  readonly key?: string;
  readonly cause: unknown;
}> {}

export class CodeModeObjectStorage extends Context.Tag(
  "@ptools/host-cloudflare/CodeModeObjectStorage",
)<
  CodeModeObjectStorage,
  {
    readonly get: <Value>(
      key: string,
    ) => Effect.Effect<Option.Option<Value>, CodeModeObjectStorageError>;
    readonly put: <Value>(
      key: string,
      value: Value,
    ) => Effect.Effect<void, CodeModeObjectStorageError>;
    readonly delete: (
      key: string | ReadonlyArray<string>,
    ) => Effect.Effect<void, CodeModeObjectStorageError>;
    readonly list: <Value>(
      options?: DurableObjectListOptions,
    ) => Effect.Effect<ReadonlyMap<string, Value>, CodeModeObjectStorageError>;
  }
>() {}

export type CodeModeObjectStorageService = Context.Tag.Service<
  typeof CodeModeObjectStorage
>;

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
 * `CodeModeObject` constructs stable adapters once and reuses this
 * Layer.succeed graph for platform-only workflows and the config-derived host
 * runtime. Request-derived values such as public origin stay in separate
 * request-scoped layers. If platform services later acquire scoped resources or
 * start background fibers, move their acquisition into a managed layer and
 * revisit whether a dedicated runtime/shared MemoMap is required.
 */
export const CodeModeObjectPlatformLayer = (options: {
  readonly storage: CodeModeObjectStorageService;
  readonly hostId: string;
  readonly workerLoader: CodeModeObjectWorkerLoaderService;
}): Layer.Layer<
  CodeModeObjectStorage | CodeModeObjectIdentity | CodeModeObjectWorkerLoader
> =>
  Layer.mergeAll(
    Layer.succeed(CodeModeObjectStorage, options.storage),
    Layer.succeed(CodeModeObjectIdentity, {
      hostId: options.hostId,
    }),
    Layer.succeed(CodeModeObjectWorkerLoader, options.workerLoader),
  );

export const CodeModeObjectRequestOriginLayer = (
  origin: string,
): Layer.Layer<CodeModeObjectRequestOrigin> =>
  Layer.succeed(CodeModeObjectRequestOrigin, { origin });

export const makeCodeModeObjectStorage = (
  storage: DurableObjectStorage,
): CodeModeObjectStorageService => ({
  get: <Value>(key: string) =>
    Effect.tryPromise({
      try: () => storage.get<Value>(key),
      catch: (cause) =>
        new CodeModeObjectStorageError({ operation: "get", key, cause }),
    }).pipe(Effect.map(Option.fromNullable)),
  put: <Value>(key: string, value: Value) =>
    Effect.tryPromise({
      try: () => storage.put(key, value),
      catch: (cause) =>
        new CodeModeObjectStorageError({ operation: "put", key, cause }),
    }),
  delete: (key) =>
    typeof key === "string"
      ? Effect.tryPromise({
          try: () => storage.delete(key),
          catch: (cause) =>
            new CodeModeObjectStorageError({
              operation: "delete",
              key,
              cause,
            }),
        }).pipe(Effect.asVoid)
      : Effect.tryPromise({
          try: () => storage.delete([...key]),
          catch: (cause) =>
            new CodeModeObjectStorageError({
              operation: "delete",
              cause,
            }),
        }).pipe(Effect.asVoid),
  list: <Value>(options?: DurableObjectListOptions) =>
    Effect.tryPromise({
      try: () => storage.list<Value>(options),
      catch: (cause) =>
        new CodeModeObjectStorageError({ operation: "list", cause }),
    }),
});
