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
  Exit,
  Layer,
  Scope,
  ScopedCache,
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
    effect: Effect.Effect<A, E, ConfiguredHostOperationServices>,
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
  // Capacity one implements first-release origin latching: the normal case
  // stays warm indefinitely, while a different public origin replaces the old
  // scoped Context. Failed builds receive zero TTL so a corrected config or
  // transient dependency can be retried immediately.
  const cache = yield* ScopedCache.makeWith<
    string,
    Context.Context<ConfiguredHostOperationServices>,
    ConfiguredHostContextError
  >({
    capacity: 1,
    lookup: (origin) => buildConfiguredContext(origin, stableLayer),
    timeToLive: (exit) =>
      Exit.isSuccess(exit) ? Duration.infinity : Duration.zero,
  });

  return {
    run: (binding, effect) =>
      // The cache owns each Context and its resource scope. `cache.get` also
      // needs a fresh, per-operation scope: it registers a temporary lease
      // there while `effect` uses the Context. Closing this scope releases only
      // that lease; eviction or invalidation closes MCP connections only after
      // every active lease has been released.
      Effect.scoped(
        cache
          .get(hostRuntimeBindingCacheKey(binding))
          .pipe(
            Effect.flatMap((context) => effect.pipe(Effect.provide(context))),
          ),
      ),
    // `ScopedCache.invalidateAll` is a getter that snapshots current keys when
    // accessed. Defer that access until this Effect runs; capturing it here
    // would permanently capture the cache's initially empty key set.
    invalidateAll: Effect.suspend(() => cache.invalidateAll),
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
 * `.Default` is scoped because the cache owns scoped resources and must be
 * finalized when the platform-owned stable `ManagedRuntime` is disposed.
 */
export class ConfiguredHostContextRunner extends Effect.Service<ConfiguredHostContextRunner>()(
  "@ptools/host-runtime/ConfiguredHostContextRunner",
  {
    scoped: makeConfiguredHostContextRunner,
  },
) {}

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
