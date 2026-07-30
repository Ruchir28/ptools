/**
 * Object-level host-api validation helpers.
 *
 * This file decodes unknown JavaScript values into host-api DTOs. It
 * intentionally does not parse bytes, JSON text, HTTP requests, or stdio
 * frames; carriers own those conversions before calling these helpers.
 */
import { Data, Effect, Schema } from "effect";
import {
  HostOperationRequest,
  HostOperationResponse,
} from "./contracts/hostOperationEnvelope.js";

/** Invalid host-api request object at a transport or server boundary. */
export class HostOperationInvalidRequestError extends Data.TaggedError(
  "HostOperationInvalidRequestError",
)<{ readonly message: string; readonly cause?: unknown }> {}

/** Invalid host-api response object at a transport or client boundary. */
export class HostOperationInvalidResponseError extends Data.TaggedError(
  "HostOperationInvalidResponseError",
)<{ readonly message: string; readonly cause?: unknown }> {}

/** Failure while encoding a host-api value for a carrier. */
export class HostOperationEncodeError extends Data.TaggedError(
  "HostOperationEncodeError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Decode an unknown JS value into a HostOperationRequest. */
export const parseHostOperationRequest = (
  value: unknown,
): Effect.Effect<HostOperationRequest, HostOperationInvalidRequestError> =>
  Schema.decodeUnknownEffect(HostOperationRequest)(value, {
    errors: "all",
    onExcessProperty: "error",
  }).pipe(
    Effect.mapError(
      (cause) =>
        new HostOperationInvalidRequestError({
          message: "Invalid host-api request",
          cause,
        }),
    ),
  );

/** Decode an unknown JS value into a HostOperationResponse. */
export const parseHostOperationResponse = (
  value: unknown,
): Effect.Effect<HostOperationResponse, HostOperationInvalidResponseError> =>
  Schema.decodeUnknownEffect(HostOperationResponse)(value, {
    errors: "all",
    onExcessProperty: "error",
  }).pipe(
    Effect.mapError(
      (cause) =>
        new HostOperationInvalidResponseError({
          message: "Invalid host-api response",
          cause,
        }),
    ),
  );
