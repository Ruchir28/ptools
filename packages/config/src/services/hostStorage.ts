/**
 * Storage capabilities for configured host instances.
 *
 * These primitives are intentionally boring: they store and load string values by
 * exact key, return `Option.none()` for missing keys, and do not know which keys
 * represent config blobs, configured secrets, credentials, or OAuth state. The
 * services that consume storage own their schemas, key names, and replacement
 * protocols.
 */
import { Context, Data, Effect, Option } from "effect";

export class HostStorageError extends Data.TaggedError("HostStorageError")<{
  readonly storage: "state" | "secret";
  readonly operation: "get" | "put" | "delete";
  readonly key: string;
  readonly cause?: unknown;
}> {}

/** Minimal exact-key string operations shared by host state and secret storage. */
export interface HostStorageOperations {
  /** Load one exact key; missing keys are meaningful absence. */
  readonly get: (
    key: string,
  ) => Effect.Effect<Option.Option<string>, HostStorageError>;
  /** Store one exact key as an opaque string value. */
  readonly put: (
    key: string,
    value: string,
  ) => Effect.Effect<void, HostStorageError>;
  /** Delete one exact key. Missing keys must be success-equivalent. */
  readonly delete: (key: string) => Effect.Effect<void, HostStorageError>;
}

/** Non-secret configured host state such as stored config blobs and indexes. */
export interface HostStateStorageService extends HostStorageOperations {}

/** Secret configured host values such as resolved config secrets and credentials. */
export interface HostSecretStorageService extends HostStorageOperations {}

export class HostStateStorage extends Context.Tag("@ptools/HostStateStorage")<
  HostStateStorage,
  HostStateStorageService
>() {}

export class HostSecretStorage extends Context.Tag("@ptools/HostSecretStorage")<
  HostSecretStorage,
  HostSecretStorageService
>() {}
