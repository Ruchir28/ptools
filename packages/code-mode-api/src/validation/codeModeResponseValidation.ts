/**
 * Validation helpers for Code Mode response boundaries.
 *
 * This file decodes unknown response values into the schema-backed success-only
 * CodeModeResponse union. It does not parse requests or host-api envelopes.
 */
import { Effect, Schema } from "effect";
import { CodeModeInvalidResponseError } from "../codeModeErrors.js";
import { CodeModeResponse } from "../contracts/codeModeResponse.js";
import type { CodeModeRequest } from "../contracts/codeModeRequest.js";

/** Decode an unknown value into a successful Code Mode response envelope. */
export const parseCodeModeResponse = (
  value: unknown,
): Effect.Effect<CodeModeResponse, CodeModeInvalidResponseError> =>
  Schema.decodeUnknown(CodeModeResponse)(value, {
    errors: "all",
    onExcessProperty: "error",
  }).pipe(
    Effect.mapError(
      (cause) =>
        new CodeModeInvalidResponseError({
          message: "Invalid Code Mode response",
          cause,
        }),
    ),
  );

/**
 * Decode a response and verify that it belongs to the supplied request
 * operation. This protects transports from returning a valid response envelope
 * for the wrong Code Mode operation.
 */
export const parseCodeModeResponseForRequest = (
  request: CodeModeRequest,
  value: unknown,
): Effect.Effect<CodeModeResponse, CodeModeInvalidResponseError> =>
  Effect.gen(function* () {
    const response = yield* parseCodeModeResponse(value);

    if (response.operation !== request.operation) {
      return yield* new CodeModeInvalidResponseError({
        message: `Code Mode response operation ${response.operation} does not match request operation ${request.operation}`,
      });
    }

    return response;
  });
