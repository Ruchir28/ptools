/**
 * @file Error boundary for building or acquiring a configured host Context.
 *
 * Distinct from errors returned by the host operation itself. Low-level auth,
 * registry, executor, and config failures stay in `cause` so platform shells can
 * map the chain to HTTP/RPC domain errors when needed; callers that only need a
 * single failure type get `ConfiguredHostContextError`.
 */
import { Data } from "effect";

/**
 * Failed to build or acquire the configured services for a host operation.
 *
 * This is a Context-lifecycle failure, not an operation result. When
 * `ConfiguredHostContextRunner.run` succeeds in acquiring a Context, the
 * caller's own Effect errors are preserved separately and are not wrapped here.
 */
export class ConfiguredHostContextError extends Data.TaggedError(
  "ConfiguredHostContextError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}
