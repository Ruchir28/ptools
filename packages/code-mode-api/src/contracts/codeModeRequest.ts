/**
 * Schema-backed Code Mode request DTOs.
 *
 * These are runtime boundary values decoded from unknown
 * JSON/HTTP/MCP/DO-RPC input and then consumed by Effect services, so they are
 * `Schema.Class` rather than hand-written unchecked interfaces.
 *
 * Decode unknown input with `Schema.decodeUnknownEffect(...)` and construct owned
 * values with `.make(...)`. Optional fields that stay inside Effect-managed
 * code decode into `Option` via `Schema.OptionFromOptionalKey(...)`,
 * so they are required `Option` fields internally and are omitted again when
 * encoded. This lets Code Mode adapt into the executor-domain `ExecuteRequest`
 * without `undefined` branching.
 */
import { Schema } from "effect";

const PositiveInteger = Schema.Number.pipe(
  Schema.check(Schema.isInt()),
  Schema.check(Schema.isGreaterThan(0)),
);

const NonBlankString = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value) => value.trim() !== "", {
      message: "must be a non-blank string",
    }),
  ),
);

/** Optional input for listing Code Mode providers. */
export class CodeModeSearchProvidersRequest extends Schema.Class<CodeModeSearchProvidersRequest>(
  "ptools.code-mode-api/CodeModeSearchProvidersRequest",
)({
  query: Schema.OptionFromOptionalKey(Schema.String),
  limit: Schema.OptionFromOptionalKey(PositiveInteger),
}) {}

/** Natural-language search input for discovering callable actions. */
export class CodeModeSearchRequest extends Schema.Class<CodeModeSearchRequest>(
  "ptools.code-mode-api/CodeModeSearchRequest",
)({
  query: NonBlankString,
  provider: Schema.OptionFromOptionalKey(Schema.String),
  limit: Schema.OptionFromOptionalKey(PositiveInteger),
}) {}

/** Input for requesting schemas and declarations for specific tools. */
export class CodeModeToolSchemaRequest extends Schema.Class<CodeModeToolSchemaRequest>(
  "ptools.code-mode-api/CodeModeToolSchemaRequest",
)({
  toolIds: Schema.Array(NonBlankString).pipe(
    Schema.check(Schema.isMinLength(1)),
  ),
}) {}

/**
 * Execute request DTO. The important one for executor integration: its
 * `Option<number>` `timeoutMs` adapts directly into the executor-domain
 * `ExecuteRequest` without `undefined` branching. `code` is the generated
 * function expression to evaluate in the sandbox.
 */
export class CodeModeExecuteRequest extends Schema.Class<CodeModeExecuteRequest>(
  "ptools.code-mode-api/CodeModeExecuteRequest",
)({
  code: Schema.String,
  timeoutMs: Schema.OptionFromOptionalKey(Schema.Number),
}) {}

/** Schema for the full Code Mode request envelope crossing API boundaries. */
export const CodeModeRequest = Schema.Union([
  Schema.Struct({
    operation: Schema.Literal("auth_status"),
    input: Schema.optional(Schema.Undefined),
  }),
  Schema.Struct({
    operation: Schema.Literal("refresh"),
    input: Schema.optional(Schema.Undefined),
  }),
  Schema.Struct({
    operation: Schema.Literal("search_providers"),
    input: Schema.optional(CodeModeSearchProvidersRequest),
  }),
  Schema.Struct({
    operation: Schema.Literal("search"),
    input: CodeModeSearchRequest,
  }),
  Schema.Struct({
    operation: Schema.Literal("get_tool_schema"),
    input: CodeModeToolSchemaRequest,
  }),
  Schema.Struct({
    operation: Schema.Literal("execute"),
    input: CodeModeExecuteRequest,
  }),
]);
export type CodeModeRequest = Schema.Schema.Type<typeof CodeModeRequest>;
