import { Effect, Option, Schema } from "effect";
import { CodeModeInvalidRequestError } from "./errors.js";
import {
  CodeModeExecuteRequest,
  CodeModeSearchProvidersRequest,
  CodeModeSearchRequest,
  CodeModeToolSchemaRequest,
} from "./schema.js";
import type {
  CodeModeOperation,
  CodeModeRequest,
} from "./types.js";

/**
 * Decode unknown API input into a typed {@link CodeModeRequest}, mapping
 * schema parse failures to {@link CodeModeInvalidRequestError}. A thin
 * schema-decode wrapper around the per-operation `parse*Input` helpers.
 */
export const parseCodeModeRequest = (
  value: unknown,
): Effect.Effect<CodeModeRequest, CodeModeInvalidRequestError> =>
  Effect.gen(function* () {
    const request = yield* expectRecord(value, "Code Mode request");

    if (typeof request.operation !== "string") {
      return yield* invalid("Code Mode request.operation must be a string");
    }

    return yield* parseCodeModeToolCall(request.operation, request.input);
  });

export const parseCodeModeToolCall = (
  operation: string,
  input: unknown,
): Effect.Effect<CodeModeRequest, CodeModeInvalidRequestError> => {
  switch (operation as CodeModeOperation | string) {
    case "auth_status":
      return expectAbsentInput(input, "auth_status").pipe(
        Effect.as({ operation: "auth_status" as const }),
      );
    case "refresh":
      return expectAbsentInput(input, "refresh").pipe(
        Effect.as({ operation: "refresh" as const }),
      );
    case "search_providers":
      return parseSearchProvidersInput(input).pipe(
        Effect.map((parsed) =>
          input === undefined
            ? { operation: "search_providers" as const }
            : { operation: "search_providers" as const, input: parsed },
        ),
      );
    case "search":
      return parseSearchInput(input).pipe(
        Effect.map((parsed) => ({ operation: "search" as const, input: parsed })),
      );
    case "get_tool_schema":
      return parseToolSchemaInput(input).pipe(
        Effect.map((parsed) => ({
          operation: "get_tool_schema" as const,
          input: parsed,
        })),
      );
    case "execute":
      return parseExecuteInput(input).pipe(
        Effect.map((parsed) => ({
          operation: "execute" as const,
          input: parsed,
        })),
      );
    default:
      return Effect.fail(invalid(`Unknown Code Mode operation: ${operation}`));
  }
};

export const parseSearchProvidersInput = (
  input: unknown,
): Effect.Effect<CodeModeSearchProvidersRequest, CodeModeInvalidRequestError> =>
  input === undefined
    ? Effect.succeed(
        CodeModeSearchProvidersRequest.make({
          query: Option.none(),
          limit: Option.none(),
        }),
      )
    : decode(CodeModeSearchProvidersRequest, input, "search_providers input");

export const parseSearchInput = (
  input: unknown,
): Effect.Effect<CodeModeSearchRequest, CodeModeInvalidRequestError> =>
  decode(CodeModeSearchRequest, input, "search input");

export const parseToolSchemaInput = (
  input: unknown,
): Effect.Effect<CodeModeToolSchemaRequest, CodeModeInvalidRequestError> =>
  decode(CodeModeToolSchemaRequest, input, "get_tool_schema input");

export const parseExecuteInput = (
  input: unknown,
): Effect.Effect<CodeModeExecuteRequest, CodeModeInvalidRequestError> =>
  decode(CodeModeExecuteRequest, input, "execute input");

const decode = <A, I, R>(
  schema: Schema.Schema<A, I, R>,
  input: unknown,
  label: string,
): Effect.Effect<A, CodeModeInvalidRequestError, R> =>
  Schema.decodeUnknown(schema)(input).pipe(
    Effect.mapError(
      (cause) =>
        new CodeModeInvalidRequestError({
          message: `Invalid ${label}`,
          cause,
        }),
    ),
  );

const expectRecord = (
  value: unknown,
  label: string,
): Effect.Effect<Record<string, unknown>, CodeModeInvalidRequestError> =>
  value === null || typeof value !== "object" || Array.isArray(value)
    ? Effect.fail(invalid(`${label} must be an object`))
    : Effect.succeed(value as Record<string, unknown>);

const expectAbsentInput = (
  input: unknown,
  operation: string,
): Effect.Effect<void, CodeModeInvalidRequestError> =>
  input === undefined
    ? Effect.void
    : Effect.fail(invalid(`${operation} input must be absent`));

const invalid = (
  message: string,
  cause?: unknown,
): CodeModeInvalidRequestError =>
  cause === undefined
    ? new CodeModeInvalidRequestError({ message })
    : new CodeModeInvalidRequestError({ message, cause });
