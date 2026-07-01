/**
 * Explicit JSON text helpers for host-api values.
 *
 * The host-api protocol is object-level and transport-agnostic. This file only
 * owns optional JSON-string convenience helpers that compose JSON.parse/stringify
 * with the schema validation helpers.
 */
import { Effect, Schema } from "effect";
import {
  HostOperationRequest,
  HostOperationResponse,
} from "./contracts/hostOperationEnvelope.js";
import {
  HostOperationEncodeError,
  HostOperationInvalidRequestError,
  HostOperationInvalidResponseError,
  parseHostOperationRequest,
  parseHostOperationResponse,
} from "./hostOperationValidation.js";

/** Parse JSON text and decode it as a HostOperationRequest. */
export const parseHostOperationRequestJson = (
  text: string,
): Effect.Effect<HostOperationRequest, HostOperationInvalidRequestError> =>
  Effect.try({
    try: () => JSON.parse(text) as unknown,
    catch: (cause) =>
      new HostOperationInvalidRequestError({
        message: "Invalid host-api request JSON",
        cause,
      }),
  }).pipe(Effect.flatMap(parseHostOperationRequest));

/** Parse JSON text and decode it as a HostOperationResponse. */
export const parseHostOperationResponseJson = (
  text: string,
): Effect.Effect<HostOperationResponse, HostOperationInvalidResponseError> =>
  Effect.try({
    try: () => JSON.parse(text) as unknown,
    catch: (cause) =>
      new HostOperationInvalidResponseError({
        message: "Invalid host-api response JSON",
        cause,
      }),
  }).pipe(Effect.flatMap(parseHostOperationResponse));

/** Encode and stringify a HostOperationRequest for JSON carriers. */
export const stringifyHostOperationRequestJson = (
  request: HostOperationRequest,
): Effect.Effect<string, HostOperationEncodeError> =>
  Schema.encode(HostOperationRequest)(request).pipe(
    Effect.flatMap((encoded) =>
      Effect.try({
        try: () => JSON.stringify(encoded),
        catch: (cause) =>
          new HostOperationEncodeError({
            message: "Failed to stringify host-api request JSON",
            cause,
          }),
      }),
    ),
    Effect.mapError((cause) =>
      cause instanceof HostOperationEncodeError
        ? cause
        : new HostOperationEncodeError({
            message: "Failed to encode host-api request",
            cause,
          }),
    ),
  );

/** Encode and stringify a HostOperationResponse for JSON carriers. */
export const stringifyHostOperationResponseJson = (
  response: HostOperationResponse,
): Effect.Effect<string, HostOperationEncodeError> =>
  Schema.encode(HostOperationResponse)(response).pipe(
    Effect.flatMap((encoded) =>
      Effect.try({
        try: () => JSON.stringify(encoded),
        catch: (cause) =>
          new HostOperationEncodeError({
            message: "Failed to stringify host-api response JSON",
            cause,
          }),
      }),
    ),
    Effect.mapError((cause) =>
      cause instanceof HostOperationEncodeError
        ? cause
        : new HostOperationEncodeError({
            message: "Failed to encode host-api response",
            cause,
          }),
    ),
  );
