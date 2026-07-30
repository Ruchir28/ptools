/**
 * Schema-backed Code Mode response envelopes.
 *
 * This file owns successful Code Mode operation responses. It intentionally
 * does not model host-api protocol failures or operation runtime failures; a
 * host wraps these success envelopes in `@ptools/host-api` when Code Mode is
 * used as a host operation.
 */
import { McpAuthStatus } from "@ptools/auth/contracts";
import { Schema } from "effect";
import {
  CodeModeRunResult,
  CodeModeSearchProvidersResult,
  CodeModeSearchResult,
  CodeModeToolSchemaResult,
} from "./codeModeResult.js";

/** Successful response for the auth_status Code Mode operation. */
export const CodeModeAuthStatusResponse = Schema.Struct({
  operation: Schema.Literal("auth_status"),
  output: McpAuthStatus,
});
export type CodeModeAuthStatusResponse = Schema.Schema.Type<
  typeof CodeModeAuthStatusResponse
>;

/** Successful response for the refresh Code Mode operation. */
export const CodeModeRefreshResponse = Schema.Struct({
  operation: Schema.Literal("refresh"),
  output: Schema.Struct({ refreshed: Schema.Literal(true) }),
});
export type CodeModeRefreshResponse = Schema.Schema.Type<
  typeof CodeModeRefreshResponse
>;

/** Successful response for the search_providers Code Mode operation. */
export const CodeModeSearchProvidersResponse = Schema.Struct({
  operation: Schema.Literal("search_providers"),
  output: CodeModeSearchProvidersResult,
});
export type CodeModeSearchProvidersResponse = Schema.Schema.Type<
  typeof CodeModeSearchProvidersResponse
>;

/** Successful response for the search Code Mode operation. */
export const CodeModeSearchResponse = Schema.Struct({
  operation: Schema.Literal("search"),
  output: CodeModeSearchResult,
});
export type CodeModeSearchResponse = Schema.Schema.Type<
  typeof CodeModeSearchResponse
>;

/** Successful response for the get_tool_schema Code Mode operation. */
export const CodeModeToolSchemaResponse = Schema.Struct({
  operation: Schema.Literal("get_tool_schema"),
  output: CodeModeToolSchemaResult,
});
export type CodeModeToolSchemaResponse = Schema.Schema.Type<
  typeof CodeModeToolSchemaResponse
>;

/** Successful response for the execute Code Mode operation. */
export const CodeModeExecuteResponse = Schema.Struct({
  operation: Schema.Literal("execute"),
  output: CodeModeRunResult,
});
export type CodeModeExecuteResponse = Schema.Schema.Type<
  typeof CodeModeExecuteResponse
>;

/** Success-only response union returned by CodeModeServer/CodeModeClient. */
export const CodeModeResponse = Schema.Union([
  CodeModeAuthStatusResponse,
  CodeModeRefreshResponse,
  CodeModeSearchProvidersResponse,
  CodeModeSearchResponse,
  CodeModeToolSchemaResponse,
  CodeModeExecuteResponse,
]);
export type CodeModeResponse = Schema.Schema.Type<typeof CodeModeResponse>;
