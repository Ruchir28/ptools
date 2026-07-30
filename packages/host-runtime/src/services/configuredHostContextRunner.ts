/**
 * @file Stable service that caches and runs config-derived host Contexts.
 *
 * Lives inside the platform-owned stable `ManagedRuntime`. Callers enter with
 * `run({ origin }, effect)`; this service turns that plain binding into a cache
 * key, lazily builds `ConfiguredHostContextLayer`, leases the scoped Context
 * while the operation runs, and finalizes it after invalidation or eviction.
 *
 * This is the lifecycle owner for configured services. Platform shells should
 * not implement their own origin cache, Context rebuild, or finalizer logic —
 * pass origin/config changes here instead.
 *
 * There are three related lifetimes:
 *
 * 1. The stable host runtime owns this runner and the `RcMap`.
 * 2. Each cached key owns a configured Context and its scoped resources.
 * 3. Each `run` temporarily leases that Context while its operation executes.
 *
 * Invalidation immediately removes an entry from the map, so later calls cannot
 * acquire it. It does not interrupt existing users: the entry's resources close
 * only after the last `run` holding a lease finishes. This is why the runner
 * uses `RcMap` rather than storing a bare Context in a mutable reference.
 */
import {
  HostIdentity,
  HostPublicOriginLayer,
  hostRuntimeBindingCacheKey,
  type HostRuntimeBinding,
} from "@ptools/host-context";
import { SandboxRuntime } from "@ptools/executor";
import { McpConnector } from "@ptools/mcp-registry";
import {
  Context,
  Duration,
  Effect,
  Layer,
  RcMap,
  Scope,
  Semaphore,
} from "effect";
import { ConfiguredHostContextError } from "../errors.js";
import {
  ConfiguredHostContextLayer,
  type ConfiguredHostOperationServices,
} from "../layers/configuredHostContextLayer.js";
import type { HostStableSharedStores } from "../layers/hostStableSharedStoresLayer.js";

/**
 * Plain method shape of the constructed runner value.
 *
 * This is not an Effect service tag. `ConfiguredHostContextRunner` below is the
 * `Effect.Service`; Effect stores a value matching this interface under that tag.
 */
export interface ConfiguredHostContextRunnerOperations {
  /**
   * Run an Effect against the configured Context for this binding.
   *
   * Builds from current persisted config/secrets on a cache miss. Fresh plain
   * `{ origin }` objects with the same origin reuse one Context because the
   * runner derives a string key instead of relying on object identity.
   */
  readonly run: <A, E>(
    binding: HostRuntimeBinding,
    make: Effect.Effect<A, E, ConfiguredHostOperationServices>,
  ) => Effect.Effect<A, E | ConfiguredHostContextError>;
  /**
   * Drop every cached configured Context after config or secrets are replaced.
   *
   * In-flight operations keep their lease until completion; the next `run`
   * rebuilds from current persisted values.
   */
  readonly invalidateAll: Effect.Effect<void>;
}

/**
 * Stable values captured once from the host runtime and reused on every
 * configured Context build (stores, identity, connector, sandbox).
 */
type ConfiguredHostContextRunnerRequirements =
  | HostStableSharedStores
  | HostIdentity
  | McpConnector
  | SandboxRuntime;

const makeConfiguredHostContextRunner: Effect.Effect<
  ConfiguredHostContextRunnerOperations,
  never,
  ConfiguredHostContextRunnerRequirements | Scope.Scope
> = Effect.gen(function* () {
  // Capture the already-built service objects from the stable host runtime.
  // Layer.succeedContext reuses those exact values for every configured Context;
  // it does not rebuild store/default/platform layers on each cache miss.
  const stableContext =
    yield* Effect.context<ConfiguredHostContextRunnerRequirements>();
  const stableLayer = Layer.succeedContext(stableContext);
  // RcMap is the v4 reference-counted resource cache. `RcMap.get` does more
  // than read a value: it registers a lease in the caller's Scope. Invalidating
  // a key removes it from this map immediately, but its private resource Scope
  // stays open until all leases on that specific entry have been released.
  //
  // `idleTimeToLive` is infinite because a successfully built Context should be
  // reused until config/secrets are explicitly invalidated or a different
  // origin replaces it. The stable runtime's Scope remains the ultimate owner
  // and closes all remaining entries during runtime disposal.
  const cache = yield* RcMap.make<
    string,
    Context.Context<ConfiguredHostOperationServices>,
    ConfiguredHostContextError,
    Scope.Scope
  >({
    lookup: (origin) => buildConfiguredContext(origin, stableLayer),
    idleTimeToLive: Duration.infinity,
  });
  // Selecting a Context is a multi-step transition: inspect the cached keys,
  // invalidate keys for older origins, and then acquire the requested key. An
  // RcMap deduplicates concurrent `get`s for one key, but it does not make that
  // whole cross-key transition atomic. Without this permit, concurrent calls
  // for origins A and B could interleave and invalidate the entry that the
  // other call has just selected.
  //
  // The permit therefore linearizes only that short selection/acquisition
  // phase. `RcMap.get` registers a lease before the permit is released. The
  // caller's operation then runs outside the permit, protected by that lease,
  // so long-running configured work does not block another operation from
  // selecting or leasing a Context.
  const selection = yield* Semaphore.make(1);

  // Invalidation is intentionally non-blocking with respect to in-flight
  // operations. `RcMap.invalidate` removes each key from future selection now;
  // if an entry is still leased, its finalizer runs later when that entry's
  // final lease is released. `discard` only ignores the `void` results from the
  // loop—it does not discard or prematurely close leased Contexts.
  const invalidateAll = Effect.suspend(() =>
    RcMap.keys(cache).pipe(
      Effect.flatMap((keys) =>
        Effect.forEach(keys, (key) => RcMap.invalidate(cache, key), {
          discard: true,
        }),
      ),
    ),
  );

  return {
    run: (binding, effect) => {
      // The key is stable across fresh `{ origin }` objects. This avoids RcMap's
      // reference-identity behavior for ordinary object keys.
      const key = hostRuntimeBindingCacheKey(binding);

      // This Scope lasts through the caller's entire operation. `RcMap.get`
      // attaches its lease finalizer to this Scope, so the Context cannot be
      // finalized while `effect` is still using services from it.
      return Effect.scoped(
        selection
          .withPermit(
            RcMap.keys(cache).pipe(
              // The runner intentionally latches one origin. Remove entries for
              // older origins before selecting the requested one. Removal only
              // prevents future leases; in-flight operations retain their old
              // Context until their own `run` Scopes close.
              Effect.flatMap((keys) =>
                Effect.forEach(
                  keys,
                  (cachedKey) =>
                    cachedKey === key
                      ? Effect.void
                      : RcMap.invalidate(cache, cachedKey),
                  { discard: true },
                ),
              ),
              // This returns the configured Context—not the key—and registers
              // its reference-counted lease in the surrounding `Effect.scoped`.
              Effect.andThen(RcMap.get(cache, key)),
            ),
          )
          .pipe(
            // The semaphore covers only origin selection and lease acquisition.
            // It is released before the user operation runs, so concurrent
            // operations are not serialized once each has a safe lease.
            //
            // RcMap retains failed acquisitions like successful idle entries.
            // Remove only a failed lookup so corrected persisted config or a
            // transient dependency can retry; operation failures occur after
            // this tap and do not invalidate a healthy configured Context.
            Effect.tapError(() => RcMap.invalidate(cache, key)),
            Effect.flatMap((context) => effect.pipe(Effect.provide(context))),
          ),
      );
    },
    invalidateAll,
  } satisfies ConfiguredHostContextRunnerOperations;
});

/**
 * Stable service that owns the configured-context cache.
 *
 * Provides `run` and `invalidateAll` on the stable runtime surface. Callers
 * pass plain `HostRuntimeBinding` data such as `{ origin }`; the runner derives
 * the cache key, builds `ConfiguredHostContextLayer` on a miss, and provides
 * that Context to the caller's Effect.
 *
 * Its Layer is scoped because the cache owns scoped resources and must be
 * finalized when the platform-owned stable `ManagedRuntime` is disposed.
 */
export class ConfiguredHostContextRunner extends Context.Service<ConfiguredHostContextRunner>()(
  "@ptools/host-runtime/ConfiguredHostContextRunner",
  {
    make: makeConfiguredHostContextRunner,
  },
) {
  static readonly layer = Layer.effect(this, this.make);
}

/**
 * Build one scoped configured Context for a public origin.
 *
 * Returns a `Context`, not another `ManagedRuntime`. `HostPublicOriginLayer`
 * supplies the cache-entry-specific origin; `stableLayer` supplies the exact
 * service instances captured from the one stable host runtime.
 */
const buildConfiguredContext = (
  origin: string,
  stableLayer: Layer.Layer<ConfiguredHostContextRunnerRequirements>,
): Effect.Effect<
  Context.Context<ConfiguredHostOperationServices>,
  ConfiguredHostContextError,
  Scope.Scope
> =>
  Layer.build(
    ConfiguredHostContextLayer.pipe(
      Layer.provide(stableLayer),
      Layer.provide(HostPublicOriginLayer(origin)),
    ),
  ).pipe(
    Effect.mapError((cause) =>
      cause instanceof ConfiguredHostContextError
        ? cause
        : new ConfiguredHostContextError({
            message: "Failed to build configured host context.",
            cause,
          }),
    ),
  );
