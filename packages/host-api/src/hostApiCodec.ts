/**
 * Explicit JSON text helpers for host-api values.
 *
 * The host-api protocol is object-level and transport-agnostic. This file only
 * owns optional JSON-string convenience helpers that compose JSON.parse/stringify
 * with the schema validation helpers.
 */
import { Effect, Schema } from "effect";
import {
  HostApiRequest,
  HostApiResponse,
} from "./contracts/hostApiEnvelope.js";
import {
  HostApiEncodeError,
  HostApiInvalidRequestError,
  HostApiInvalidResponseError,
  parseHostApiRequest,
  parseHostApiResponse,
} from "./hostApiValidation.js";

/** Parse JSON text and decode it as a HostApiRequest. */
export const parseHostApiRequestJson = (
  text: string,
): Effect.Effect<HostApiRequest, HostApiInvalidRequestError> =>
  Effect.try({
    try: () => JSON.parse(text) as unknown,
    catch: (cause) =>
      new HostApiInvalidRequestError({
        message: "Invalid host-api request JSON",
        cause,
      }),
  }).pipe(Effect.flatMap(parseHostApiRequest));

/** Parse JSON text and decode it as a HostApiResponse. */
export const parseHostApiResponseJson = (
  text: string,
): Effect.Effect<HostApiResponse, HostApiInvalidResponseError> =>
  Effect.try({
    try: () => JSON.parse(text) as unknown,
    catch: (cause) =>
      new HostApiInvalidResponseError({
        message: "Invalid host-api response JSON",
        cause,
      }),
  }).pipe(Effect.flatMap(parseHostApiResponse));

/** Encode and stringify a HostApiRequest for JSON carriers. */
export const stringifyHostApiRequestJson = (
  request: HostApiRequest,
): Effect.Effect<string, HostApiEncodeError> =>
  Schema.encode(HostApiRequest)(request).pipe(
    Effect.flatMap((encoded) =>
      Effect.try({
        try: () => JSON.stringify(encoded),
        catch: (cause) =>
          new HostApiEncodeError({
            message: "Failed to stringify host-api request JSON",
            cause,
          }),
      }),
    ),
    Effect.mapError((cause) =>
      cause instanceof HostApiEncodeError
        ? cause
        : new HostApiEncodeError({
            message: "Failed to encode host-api request",
            cause,
          }),
    ),
  );

/** Encode and stringify a HostApiResponse for JSON carriers. */
export const stringifyHostApiResponseJson = (
  response: HostApiResponse,
): Effect.Effect<string, HostApiEncodeError> =>
  Schema.encode(HostApiResponse)(response).pipe(
    Effect.flatMap((encoded) =>
      Effect.try({
        try: () => JSON.stringify(encoded),
        catch: (cause) =>
          new HostApiEncodeError({
            message: "Failed to stringify host-api response JSON",
            cause,
          }),
      }),
    ),
    Effect.mapError((cause) =>
      cause instanceof HostApiEncodeError
        ? cause
        : new HostApiEncodeError({
            message: "Failed to encode host-api response",
            cause,
          }),
    ),
  );
