/**
 * Validation helpers for Code Mode request boundaries.
 *
 * This file decodes unknown API and MCP-tool inputs into schema-backed Code Mode
 * request DTOs. It owns parsing only; the request schemas live in
 * `../contracts/codeModeRequest.ts`.
 */
import { Effect, Option, Schema } from "effect";
import { CodeModeInvalidRequestError } from "../codeModeErrors.js";
import {
  CodeModeExecuteRequest,
  CodeModeRequest,
  CodeModeSearchProvidersRequest,
  CodeModeSearchRequest,
  CodeModeToolSchemaRequest,
} from "../contracts/codeModeRequest.js";

/**
 * Decode unknown API input into a typed {@link CodeModeRequest}. The schema is
 * authoritative for the request envelope; per-tool helpers remain for MCP tool
 * calls that receive `(operation, input)` separately.
 */
export const parseCodeModeRequest = (
  value: unknown,
): Effect.Effect<CodeModeRequest, CodeModeInvalidRequestError> =>
  decode(CodeModeRequest, value, "Code Mode request");

/** Parse an MCP tool call represented as separate operation and input values. */
export const parseCodeModeToolCall = (
  operation: string,
  input: unknown,
): Effect.Effect<CodeModeRequest, CodeModeInvalidRequestError> => {
  switch (operation) {
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
        Effect.map((parsed) => ({
          operation: "search" as const,
          input: parsed,
        })),
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

/** Parse input for the search_providers Code Mode operation. */
export const parseSearchProvidersInput = (
  input: unknown,
): Effect.Effect<
  CodeModeSearchProvidersRequest,
  CodeModeInvalidRequestError
> =>
  input === undefined
    ? Effect.succeed(
        CodeModeSearchProvidersRequest.make({
          query: Option.none(),
          limit: Option.none(),
        }),
      )
    : decode(CodeModeSearchProvidersRequest, input, "search_providers input");

/** Parse input for the search Code Mode operation. */
export const parseSearchInput = (
  input: unknown,
): Effect.Effect<CodeModeSearchRequest, CodeModeInvalidRequestError> =>
  decode(CodeModeSearchRequest, input, "search input");

/** Parse input for the get_tool_schema Code Mode operation. */
export const parseToolSchemaInput = (
  input: unknown,
): Effect.Effect<CodeModeToolSchemaRequest, CodeModeInvalidRequestError> =>
  decode(CodeModeToolSchemaRequest, input, "get_tool_schema input");

/** Parse input for the execute Code Mode operation. */
export const parseExecuteInput = (
  input: unknown,
): Effect.Effect<CodeModeExecuteRequest, CodeModeInvalidRequestError> =>
  decode(CodeModeExecuteRequest, input, "execute input");

const decode = <S extends Schema.Constraint>(
  schema: S,
  input: unknown,
  label: string,
): Effect.Effect<
  S["Type"],
  CodeModeInvalidRequestError,
  S["DecodingServices"]
> =>
  Schema.decodeUnknownEffect(schema)(input).pipe(
    Effect.mapError(
      (cause) =>
        new CodeModeInvalidRequestError({
          message: `Invalid ${label}`,
          cause,
        }),
    ),
  );

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
