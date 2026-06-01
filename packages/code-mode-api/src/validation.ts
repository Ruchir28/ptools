import { Effect } from "effect";
import { CodeModeInvalidRequestError } from "./errors.js";
import type {
  CodeModeExecuteRequest,
  CodeModeOperation,
  CodeModeRequest,
  CodeModeSearchProvidersRequest,
  CodeModeSearchRequest,
  CodeModeToolSchemaRequest,
} from "./types.js";

export const parseCodeModeRequest = (
  value: unknown,
): Effect.Effect<CodeModeRequest, CodeModeInvalidRequestError> =>
  parseSync(() => {
    const request = expectRecord(value, "Code Mode request");

    if (typeof request.operation !== "string") {
      throw invalid("Code Mode request.operation must be a string");
    }

    return parseCodeModeToolCallSync(request.operation, request.input);
  });

export const parseCodeModeToolCall = (
  operation: string,
  input: unknown,
): Effect.Effect<CodeModeRequest, CodeModeInvalidRequestError> =>
  parseSync(() => parseCodeModeToolCallSync(operation, input));

export const parseSearchProvidersInput = (
  input: unknown,
): Effect.Effect<CodeModeSearchProvidersRequest, CodeModeInvalidRequestError> =>
  parseSync(() => parseSearchProvidersInputSync(input));

export const parseSearchInput = (
  input: unknown,
): Effect.Effect<CodeModeSearchRequest, CodeModeInvalidRequestError> =>
  parseSync(() => parseSearchInputSync(input));

export const parseToolSchemaInput = (
  input: unknown,
): Effect.Effect<CodeModeToolSchemaRequest, CodeModeInvalidRequestError> =>
  parseSync(() => parseToolSchemaInputSync(input));

export const parseExecuteInput = (
  input: unknown,
): Effect.Effect<CodeModeExecuteRequest, CodeModeInvalidRequestError> =>
  parseSync(() => parseExecuteInputSync(input));

const parseCodeModeToolCallSync = (
  operation: string,
  input: unknown,
): CodeModeRequest => {
  switch (operation as CodeModeOperation | string) {
    case "auth_status":
      expectAbsentInput(input, "auth_status");
      return { operation: "auth_status" };
    case "refresh":
      expectAbsentInput(input, "refresh");
      return { operation: "refresh" };
    case "search_providers": {
      const parsed = parseSearchProvidersInputSync(input);
      return input === undefined
        ? { operation: "search_providers" }
        : { operation: "search_providers", input: parsed };
    }
    case "search":
      return { operation: "search", input: parseSearchInputSync(input) };
    case "get_tool_schema":
      return {
        operation: "get_tool_schema",
        input: parseToolSchemaInputSync(input),
      };
    case "execute":
      return { operation: "execute", input: parseExecuteInputSync(input) };
    default:
      throw invalid(`Unknown Code Mode operation: ${operation}`);
  }
};

const parseSearchProvidersInputSync = (
  input: unknown,
): CodeModeSearchProvidersRequest => {
  if (input === undefined) {
    return {};
  }

  const value = expectRecord(input, "search_providers input");

  if (value.query !== undefined && typeof value.query !== "string") {
    throw invalid("search_providers.query must be a string when provided");
  }

  if (value.limit !== undefined && !isPositiveInteger(value.limit)) {
    throw invalid(
      "search_providers.limit must be a positive integer when provided",
    );
  }

  return {
    ...(value.query === undefined ? {} : { query: value.query }),
    ...(value.limit === undefined ? {} : { limit: value.limit }),
  };
};

const parseSearchInputSync = (input: unknown): CodeModeSearchRequest => {
  const value = expectRecord(input, "search input");

  if (typeof value.query !== "string" || value.query.trim() === "") {
    throw invalid("search.query must be a non-blank string");
  }

  if (value.provider !== undefined && typeof value.provider !== "string") {
    throw invalid("search.provider must be a string when provided");
  }

  if (value.limit !== undefined && !isPositiveInteger(value.limit)) {
    throw invalid("search.limit must be a positive integer when provided");
  }

  return {
    query: value.query,
    ...(value.provider === undefined ? {} : { provider: value.provider }),
    ...(value.limit === undefined ? {} : { limit: value.limit }),
  };
};

const parseToolSchemaInputSync = (
  input: unknown,
): CodeModeToolSchemaRequest => {
  const value = expectRecord(input, "get_tool_schema input");

  if (!Array.isArray(value.toolIds)) {
    throw invalid("get_tool_schema.toolIds must be an array");
  }

  if (value.toolIds.length === 0) {
    throw invalid("get_tool_schema requires at least one toolId");
  }

  return {
    toolIds: value.toolIds.map((toolId, index) => {
      if (typeof toolId !== "string" || toolId.trim() === "") {
        throw invalid(
          `get_tool_schema.toolIds[${index}] must be a non-blank string`,
        );
      }

      return toolId;
    }),
  };
};

const parseExecuteInputSync = (input: unknown): CodeModeExecuteRequest => {
  const value = expectRecord(input, "execute input");

  if (typeof value.code !== "string") {
    throw invalid("execute.code must be a string");
  }

  if (value.timeoutMs !== undefined && typeof value.timeoutMs !== "number") {
    throw invalid("execute.timeoutMs must be a number when provided");
  }

  return value.timeoutMs === undefined
    ? { code: value.code }
    : { code: value.code, timeoutMs: value.timeoutMs };
};

const parseSync = <A>(
  parse: () => A,
): Effect.Effect<A, CodeModeInvalidRequestError> =>
  Effect.try({
    try: parse,
    catch: (cause) =>
      cause instanceof CodeModeInvalidRequestError
        ? cause
        : invalid("Invalid Code Mode request", cause),
  });

const expectRecord = (
  value: unknown,
  label: string,
): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalid(`${label} must be an object`);
  }

  return value as Record<string, unknown>;
};

const expectAbsentInput = (input: unknown, operation: string): void => {
  if (input !== undefined) {
    throw invalid(`${operation} input must be absent`);
  }
};

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

const invalid = (
  message: string,
  cause?: unknown,
): CodeModeInvalidRequestError =>
  cause === undefined
    ? new CodeModeInvalidRequestError({ message })
    : new CodeModeInvalidRequestError({ message, cause });
