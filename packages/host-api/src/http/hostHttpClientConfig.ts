/**
 * Caller-owned connection facts for the shared Host HTTP API.
 *
 * This module is transport configuration only: it contains no server lifecycle,
 * actor handle, fetch capability, or platform-specific deployment settings.
 */
import { Data, Effect, Redacted } from "effect";

/** Serializable connection facts for an already-running Host HTTP API. */
export interface HostHttpClientConfig {
  readonly baseUrl: string;
  readonly hostId: string;
  readonly accessToken: string;
}

/** Invalid caller-owned Host HTTP connection facts. */
export class HostHttpClientConfigError extends Data.TaggedError(
  "HostHttpClientConfigError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Validated connection facts captured by the Effect-native client layer. */
export interface NormalizedHostHttpClientConfig {
  readonly baseUrl: URL;
  readonly hostId: string;
  readonly accessToken: Redacted.Redacted<string>;
}

/**
 * Validate public connection data once for both Effect and Promise callers.
 * Invalid URLs are typed failures rather than defects from `new URL(...)`.
 */
export const normalizeHostHttpClientConfig = (
  config: HostHttpClientConfig,
): Effect.Effect<
  NormalizedHostHttpClientConfig,
  HostHttpClientConfigError
> =>
  Effect.gen(function* () {
    if (config.baseUrl.trim() === "") {
      return yield* new HostHttpClientConfigError({
        message: "Host HTTP baseUrl must not be empty.",
      });
    }

    const baseUrl = yield* Effect.try({
      try: () => new URL(config.baseUrl),
      catch: (cause) =>
        new HostHttpClientConfigError({
          message: "Host HTTP baseUrl must be a valid absolute URL.",
          cause,
        }),
    });

    if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
      return yield* new HostHttpClientConfigError({
        message: "Host HTTP baseUrl must use http: or https:.",
      });
    }

    if (config.hostId.trim() === "") {
      return yield* new HostHttpClientConfigError({
        message: "Host HTTP hostId must not be empty.",
      });
    }

    if (config.accessToken.trim() === "") {
      return yield* new HostHttpClientConfigError({
        message: "Host HTTP accessToken must not be empty.",
      });
    }

    return {
      baseUrl,
      hostId: config.hostId,
      accessToken: Redacted.make(config.accessToken),
    };
  });
