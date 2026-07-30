/**
 * Host-scoped storage services and the platform backends that open them.
 *
 * Platforms provide only backend ports capable of selecting physical storage
 * for a requested host ID. The package-owned `Effect.Service` defaults combine
 * those backends with `HostIdentity`, producing final storage capabilities that
 * have already closed over exactly one host. Semantic stores therefore use only
 * logical exact keys and never participate in host selection.
 */
import { HostIdentity } from "@ptools/host-context";
import { Context, Data, Effect, Layer, Option, Scope } from "effect";

export class HostStorageError extends Data.TaggedError("HostStorageError")<{
  readonly storage: "state" | "secret";
  readonly operation: "open" | "get" | "put" | "delete";
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

/**
 * Platform port that opens non-secret physical storage for one requested host.
 * The returned operations omit host metadata; the shared final service adds it
 * from the same `HostIdentity` used for selection.
 */
export interface HostStateStorageBackendService {
  readonly forHost: (
    hostId: string,
  ) => Effect.Effect<HostStorageOperations, HostStorageError, Scope.Scope>;
}

/** Platform implementation required by `HostStateStorage.layer`. */
export class HostStateStorageBackend extends Context.Service<
  HostStateStorageBackend,
  HostStateStorageBackendService
>()("@ptools/HostStateStorageBackend") {}

/** Platform port that opens secret physical storage for one requested host. */
export interface HostSecretStorageBackendService {
  readonly forHost: (
    hostId: string,
  ) => Effect.Effect<HostStorageOperations, HostStorageError, Scope.Scope>;
}

/** Platform implementation required by `HostSecretStorage.layer`. */
export class HostSecretStorageBackend extends Context.Service<
  HostSecretStorageBackend,
  HostSecretStorageBackendService
>()("@ptools/HostSecretStorageBackend") {}

/** Non-secret exact-key storage selected for one stable host identity. */
export interface HostStateStorageService extends HostStorageOperations {
  /** Host selected by the shared service during construction. */
  readonly hostId: string;
}

/**
 * Final non-secret host storage service.
 *
 * Its package-owned Layer requires `HostIdentity` and the platform's
 * `HostStateStorageBackend`, making host selection part of shared composition
 * rather than a convention repeated by each platform.
 */
export class HostStateStorage extends Context.Service<HostStateStorage>()(
  "@ptools/HostStateStorage",
  {
    make: Effect.gen(function* () {
      const identity = yield* HostIdentity;
      const backend = yield* HostStateStorageBackend;
      const operations = yield* backend.forHost(identity.hostId);

      return {
        ...operations,
        hostId: identity.hostId,
      } satisfies HostStateStorageService;
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make);
}

/** Secret exact-key storage selected for one stable host identity. */
export interface HostSecretStorageService extends HostStorageOperations {
  /** Host selected by the shared service during construction. */
  readonly hostId: string;
}

/** Shared final secret storage; its Layer performs identity-based selection. */
export class HostSecretStorage extends Context.Service<HostSecretStorage>()(
  "@ptools/HostSecretStorage",
  {
    make: Effect.gen(function* () {
      const identity = yield* HostIdentity;
      const backend = yield* HostSecretStorageBackend;
      const operations = yield* backend.forHost(identity.hostId);

      return {
        ...operations,
        hostId: identity.hostId,
      } satisfies HostSecretStorageService;
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make);
}
