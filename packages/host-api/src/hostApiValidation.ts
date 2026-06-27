/**
 * Object-level host-api validation helpers.
 *
 * This file decodes unknown JavaScript values into host-api DTOs. It
 * intentionally does not parse bytes, JSON text, HTTP requests, or stdio
 * frames; carriers own those conversions before calling these helpers.
 */
import { Data, Effect, Schema } from "effect";
import {
  HostApiRequest,
  HostApiResponse,
} from "./contracts/hostApiEnvelope.js";

/** Invalid host-api request object at a transport or server boundary. */
export class HostApiInvalidRequestError extends Data.TaggedError(
  "HostApiInvalidRequestError",
)<{ readonly message: string; readonly cause?: unknown }> {}

/** Invalid host-api response object at a transport or client boundary. */
export class HostApiInvalidResponseError extends Data.TaggedError(
  "HostApiInvalidResponseError",
)<{ readonly message: string; readonly cause?: unknown }> {}

/** Failure while encoding a host-api value for a carrier. */
export class HostApiEncodeError extends Data.TaggedError("HostApiEncodeError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Decode an unknown JS value into a HostApiRequest. */
export const parseHostApiRequest = (
  value: unknown,
): Effect.Effect<HostApiRequest, HostApiInvalidRequestError> =>
  Schema.decodeUnknown(HostApiRequest)(value, {
    errors: "all",
    onExcessProperty: "error",
  }).pipe(
    Effect.mapError(
      (cause) =>
        new HostApiInvalidRequestError({
          message: "Invalid host-api request",
          cause,
        }),
    ),
  );

/** Decode an unknown JS value into a HostApiResponse. */
export const parseHostApiResponse = (
  value: unknown,
): Effect.Effect<HostApiResponse, HostApiInvalidResponseError> =>
  Schema.decodeUnknown(HostApiResponse)(value, {
    errors: "all",
    onExcessProperty: "error",
  }).pipe(
    Effect.mapError(
      (cause) =>
        new HostApiInvalidResponseError({
          message: "Invalid host-api response",
          cause,
        }),
    ),
  );
