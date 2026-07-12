/**
 * Plain input passed to the configured host context runner for one operation.
 *
 * These values are not stable host identity. They are runtime/request facts that
 * can change which configured context should be used or built. Today only the
 * public origin is included because auth URLs and OAuth callback URLs depend on
 * it.
 */
export interface HostRuntimeBinding {
  readonly origin: string;
}

/**
 * Stable string cache key for a runtime binding.
 *
 * Do not use the binding object itself as a cache key: callers pass fresh plain
 * objects, and object identity would turn every call into a miss.
 */
export const hostRuntimeBindingCacheKey = (
  binding: HostRuntimeBinding,
): string => binding.origin;
