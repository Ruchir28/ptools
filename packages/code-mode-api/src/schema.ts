/**
 * Schema-backed Code Mode request DTOs (see `./types.ts` for response/metadata
 * contracts). These are runtime boundary values decoded from unknown
 * JSON/HTTP/MCP/DO-RPC input and then consumed by Effect services, so they are
 * `Schema.Class` rather than hand-written unchecked interfaces.
 *
 * Decode unknown input with `Schema.decodeUnknown(...)` and construct owned
 * values with `.make(...)`. Optional fields that stay inside Effect-managed
 * code decode into `Option` via `Schema.optionalWith(..., { exact: true, as: "Option" })`,
 * so they are required `Option` fields internally and are omitted again when
 * encoded. This lets Code Mode adapt into the executor-domain `ExecuteRequest`
 * without `undefined` branching.
 */
import { Schema } from "effect";

const PositiveInteger = Schema.Number.pipe(
  Schema.int(),
  Schema.positive(),
);

const NonBlankString = Schema.String.pipe(
  Schema.filter((value) => value.trim() !== "", {
    message: () => "must be a non-blank string",
  }),
);

export class CodeModeSearchProvidersRequest extends Schema.Class<CodeModeSearchProvidersRequest>(
  "ptools.code-mode-api/CodeModeSearchProvidersRequest",
)({
  query: Schema.optionalWith(Schema.String, { exact: true, as: "Option" }),
  limit: Schema.optionalWith(PositiveInteger, { exact: true, as: "Option" }),
}) {}

export class CodeModeSearchRequest extends Schema.Class<CodeModeSearchRequest>(
  "ptools.code-mode-api/CodeModeSearchRequest",
)({
  query: NonBlankString,
  provider: Schema.optionalWith(Schema.String, { exact: true, as: "Option" }),
  limit: Schema.optionalWith(PositiveInteger, { exact: true, as: "Option" }),
}) {}

export class CodeModeToolSchemaRequest extends Schema.Class<CodeModeToolSchemaRequest>(
  "ptools.code-mode-api/CodeModeToolSchemaRequest",
)({
  toolIds: Schema.Array(NonBlankString).pipe(Schema.minItems(1)),
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
  timeoutMs: Schema.optionalWith(Schema.Number, {
    exact: true,
    as: "Option",
  }),
}) {}
