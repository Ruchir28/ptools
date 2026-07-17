import { HostIdentityLayer } from "@ptools/host-context";
import {
  Context,
  Deferred,
  Effect,
  Either,
  Fiber,
  Layer,
  Option,
} from "effect";
import { describe, expect, it } from "vitest";
import {
  CONFIGURED_SECRET_INDEX_KEY,
  ConfiguredSecretStore,
  HostSecretStorage,
  HostSecretStorageBackend,
  HostStateStorage,
  HostStateStorageBackend,
  HostStorageError,
  configuredSecretValueKey,
  type HostStorageOperations,
} from "../src/services/index.js";

describe("ConfiguredSecretStore replacement serialization", () => {
  it("prevents two replacements from interleaving their index protocols", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const firstReadEntered = yield* Deferred.make<void>();
          const releaseFirstRead = yield* Deferred.make<void>();
          const secondStarted = yield* Deferred.make<void>();
          const stateValues = new Map<string, string>();
          const secretValues = new Map<string, string>();
          let indexReads = 0;

          // The fake state backend lets this test pause the first replacement
          // exactly after it has entered the index-read step. This is the
          // interleaving that a store-instance semaphore must prevent a second
          // replacement from joining.
          const state = memoryStorage(stateValues, "state", {
            beforeGet: (key) =>
              key !== CONFIGURED_SECRET_INDEX_KEY
                ? Effect.void
                : Effect.gen(function* () {
                    indexReads += 1;
                    if (indexReads === 1) {
                      yield* Deferred.succeed(firstReadEntered, undefined);
                      yield* Deferred.await(releaseFirstRead);
                    }
                  }),
          });
          const secrets = memoryStorage(secretValues, "secret");
          const store = Context.get(
            yield* Layer.build(configuredSecretStoreLayer(state, secrets)),
            ConfiguredSecretStore,
          );

          const first = yield* store
            .replaceAll({ secrets: { FIRST: "one" } })
            .pipe(Effect.fork);
          yield* Deferred.await(firstReadEntered);

          const second = yield* Effect.gen(function* () {
            yield* Deferred.succeed(secondStarted, undefined);
            return yield* store.replaceAll({ secrets: { SECOND: "two" } });
          }).pipe(Effect.fork);
          yield* Deferred.await(secondStarted);
          // The second fiber has started, but the store-instance semaphore keeps
          // it outside the index protocol until the first replacement finishes.
          yield* Effect.yieldNow();
          yield* Effect.yieldNow();
          expect(indexReads).toBe(1);

          yield* Deferred.succeed(releaseFirstRead, undefined);
          yield* Fiber.join(first);
          yield* Fiber.join(second);

          return { stateValues, secretValues, indexReads };
        }),
      ),
    );

    expect(result.indexReads).toBe(2);
    expect(
      JSON.parse(result.stateValues.get(CONFIGURED_SECRET_INDEX_KEY)!),
    ).toEqual([configuredSecretValueKey("SECOND")]);
    expect(result.secretValues).toEqual(
      new Map([[configuredSecretValueKey("SECOND"), "two"]]),
    );
  });

  it("releases the permit when a replacement fails", async () => {
    const stateValues = new Map<string, string>();
    const secretValues = new Map<string, string>();
    let failNextIndexRead = true;
    const state = memoryStorage(stateValues, "state", {
      // Fail only the first index read. The following replacement proves the
      // semaphore released its permit after that failed protected operation.
      beforeGet: (key) =>
        key === CONFIGURED_SECRET_INDEX_KEY && failNextIndexRead
          ? Effect.sync(() => {
              failNextIndexRead = false;
            }).pipe(
              Effect.zipRight(
                Effect.fail(
                  new HostStorageError({
                    storage: "state",
                    operation: "get",
                    key,
                    cause: new Error("first read failed"),
                  }),
                ),
              ),
            )
          : Effect.void,
    });
    const secrets = memoryStorage(secretValues, "secret");

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* ConfiguredSecretStore;
        const failed = yield* store
          .replaceAll({ secrets: { FIRST: "one" } })
          .pipe(Effect.either);
        const succeeded = yield* store.replaceAll({
          secrets: { SECOND: "two" },
        });
        return { failed, succeeded };
      }).pipe(Effect.provide(configuredSecretStoreLayer(state, secrets))),
    );

    expect(Either.isLeft(result.failed)).toBe(true);
    expect(result.succeeded.secretCount).toBe(1);
    expect(secretValues.get(configuredSecretValueKey("SECOND"))).toBe("two");
  });

  it("does not share a semaphore between store instances", async () => {
    const secondSecrets = new Map<string, string>();

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const firstReadEntered = yield* Deferred.make<void>();
          const releaseFirstRead = yield* Deferred.make<void>();
          const firstState = memoryStorage(new Map(), "state", {
            // Pause this store at its index read. The second independently
            // constructed store must not wait on this instance's semaphore.
            beforeGet: (key) =>
              key === CONFIGURED_SECRET_INDEX_KEY
                ? Deferred.succeed(firstReadEntered, undefined).pipe(
                    Effect.zipRight(Deferred.await(releaseFirstRead)),
                  )
                : Effect.void,
          });
          const firstSecrets = memoryStorage(new Map(), "secret");
          const firstFiber = yield* Effect.gen(function* () {
            const store = yield* ConfiguredSecretStore;
            yield* store.replaceAll({ secrets: { FIRST: "one" } });
          }).pipe(
            Effect.provide(
              configuredSecretStoreLayer(firstState, firstSecrets),
            ),
            Effect.fork,
          );
          yield* Deferred.await(firstReadEntered);

          // A separate store instance must complete while the first instance is
          // blocked in its own replacement protocol.
          yield* Effect.gen(function* () {
            const store = yield* ConfiguredSecretStore;
            yield* store.replaceAll({ secrets: { SECOND: "two" } });
          }).pipe(
            Effect.provide(
              configuredSecretStoreLayer(
                memoryStorage(new Map(), "state"),
                memoryStorage(secondSecrets, "secret"),
              ),
            ),
          );

          yield* Deferred.succeed(releaseFirstRead, undefined);
          yield* Fiber.join(firstFiber);
        }),
      ),
    );

    expect(secondSecrets.get(configuredSecretValueKey("SECOND"))).toBe("two");
  });
});

const memoryStorage = (
  values: Map<string, string>,
  storage: "state" | "secret",
  hooks: {
    // Test-only interception point: runs before this fake backend reads the
    // requested key from `values`.
    readonly beforeGet?: (key: string) => Effect.Effect<void, HostStorageError>;
  } = {},
): HostStorageOperations => ({
  get: (key) =>
    (hooks.beforeGet?.(key) ?? Effect.void).pipe(
      Effect.zipRight(
        Effect.sync(() => Option.fromNullable(values.get(key))),
      ),
    ),
  put: (key, value) =>
    Effect.sync(() => {
      values.set(key, value);
    }),
  delete: (key) =>
    Effect.sync(() => {
      values.delete(key);
    }),
});

const configuredSecretStoreLayer = (
  state: HostStorageOperations,
  secrets: HostStorageOperations,
) =>
  ConfiguredSecretStore.Default.pipe(
    Layer.provide(
      Layer.merge(HostStateStorage.Default, HostSecretStorage.Default).pipe(
        Layer.provide(
          Layer.mergeAll(
            HostIdentityLayer("test-host"),
            Layer.succeed(HostStateStorageBackend, {
              forHost: () => Effect.succeed(state),
            }),
            Layer.succeed(HostSecretStorageBackend, {
              forHost: () => Effect.succeed(secrets),
            }),
          ),
        ),
      ),
    ),
  );
