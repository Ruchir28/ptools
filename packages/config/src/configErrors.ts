/**
 * Typed errors raised while parsing and resolving ptools configuration.
 *
 * These errors are shared by config parsing helpers and Effect services without
 * belonging to the DTO-only contract surface.
 */
import { Data } from "effect";

/** Failure while reading, validating, normalizing, or resolving config. */
export class ServerConfigError extends Data.TaggedError("ServerConfigError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}
