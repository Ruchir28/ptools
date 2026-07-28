/**
 * Schema-backed Code Mode response payload DTOs.
 *
 * This file owns the plain result objects returned by successful Code Mode
 * operations. It intentionally does not own request parsing or host-api
 * envelopes; those live in `codeModeRequest.ts`, validation helpers, and
 * `@ptools/host-api`.
 */
import { Schema } from "effect";

const UnknownArray = Schema.Array(Schema.Unknown);

/** Console log captured while executing generated Code Mode code. */
export const CapturedLog = Schema.Struct({
  level: Schema.Literal("debug", "error", "info", "log", "warn"),
  message: Schema.String,
  args: UnknownArray,
});
export type CapturedLog = Schema.Schema.Type<typeof CapturedLog>;

/** Diagnostic emitted while discovering or using MCP tools. */
export const CodeModeDiagnostic = Schema.Union(
  Schema.Struct({
    code: Schema.Literal("McpRegistryRefreshFailed"),
    severity: Schema.Literal("error"),
    serverName: Schema.String,
    message: Schema.String,
  }),
  Schema.Struct({
    code: Schema.Literal("McpConnectionFailed"),
    severity: Schema.Literal("error"),
    serverName: Schema.String,
    message: Schema.String,
  }),
  Schema.Struct({
    code: Schema.Literal("UpstreamAuthRequired"),
    severity: Schema.Literal("warning"),
    serverName: Schema.String,
    message: Schema.String,
    authUrl: Schema.String,
    authorizeUrl: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    code: Schema.Literal("UpstreamAuthNeedsConfig"),
    severity: Schema.Literal("warning"),
    serverName: Schema.String,
    message: Schema.String,
    authUrl: Schema.String,
    setupUrl: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    code: Schema.Literal("McpDiscoveryFailed"),
    severity: Schema.Literal("error"),
    serverName: Schema.String,
    message: Schema.String,
  }),
  Schema.Struct({
    code: Schema.Literal("InvalidInputSchema"),
    severity: Schema.Literal("error"),
    serverName: Schema.String,
    toolName: Schema.String,
    message: Schema.String,
  }),
  Schema.Struct({
    code: Schema.Literal("InvalidOutputSchema"),
    severity: Schema.Literal("warning"),
    serverName: Schema.String,
    toolName: Schema.String,
    message: Schema.String,
  }),
);
export type CodeModeDiagnostic = Schema.Schema.Type<typeof CodeModeDiagnostic>;

const ProviderError = Schema.Struct({
  name: Schema.optional(Schema.String),
  message: Schema.String,
  stack: Schema.optional(Schema.String),
  code: Schema.optional(Schema.String),
});

/** Warning emitted when provider calls are still being observed at return. */
export const CodeModeExecutionWarning = Schema.Union(
  Schema.Struct({
    code: Schema.Literal("ProviderCallPendingAtReturn"),
    callId: Schema.String,
    provider: Schema.String,
    tool: Schema.String,
    outcome: Schema.Literal("succeeded"),
  }),
  Schema.Struct({
    code: Schema.Literal("ProviderCallPendingAtReturn"),
    callId: Schema.String,
    provider: Schema.String,
    tool: Schema.String,
    outcome: Schema.Literal("failed"),
    error: ProviderError,
  }),
);
export type CodeModeExecutionWarning = Schema.Schema.Type<
  typeof CodeModeExecutionWarning
>;

/** Output of the execute operation. */
export const CodeModeRunResult = Schema.Struct({
  value: Schema.Unknown,
  logs: Schema.Array(CapturedLog),
  warnings: Schema.Array(CodeModeExecutionWarning),
});
export type CodeModeRunResult = Schema.Schema.Type<typeof CodeModeRunResult>;

/** Summary of one MCP provider exposed to Code Mode search. */
export const CodeModeProviderSummary = Schema.Struct({
  provider: Schema.String,
  displayName: Schema.String,
  toolCount: Schema.Number,
  description: Schema.optional(Schema.String),
  exampleQueries: Schema.Array(Schema.String),
});
export type CodeModeProviderSummary = Schema.Schema.Type<
  typeof CodeModeProviderSummary
>;

/** One search candidate returned for a natural-language query. */
export const CodeModeActionCandidate = Schema.Struct({
  toolId: Schema.String,
  provider: Schema.String,
  action: Schema.String,
  call: Schema.String,
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  inputFields: Schema.Array(Schema.String),
});
export type CodeModeActionCandidate = Schema.Schema.Type<
  typeof CodeModeActionCandidate
>;

/** Tool schema metadata exposed by Code Mode. */
export const CodeModeToolSchema = Schema.Struct({
  serverName: Schema.String,
  jsServerName: Schema.String,
  originalToolName: Schema.String,
  jsToolName: Schema.String,
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  inputSchema: Schema.Unknown,
  outputSchema: Schema.optional(Schema.Unknown),
  outputSchemaInvalid: Schema.optional(Schema.Literal(true)),
  annotations: Schema.optional(Schema.Unknown),
});
export type CodeModeToolSchema = Schema.Schema.Type<typeof CodeModeToolSchema>;

/** Generated TypeScript declaration for one server. */
export const CodeModeServerDeclaration = Schema.Struct({
  serverName: Schema.String,
  jsServerName: Schema.String,
  declaration: Schema.String,
});
export type CodeModeServerDeclaration = Schema.Schema.Type<
  typeof CodeModeServerDeclaration
>;

/** Provider-list operation result. */
export const CodeModeSearchProvidersResult = Schema.Struct({
  providers: Schema.Array(CodeModeProviderSummary),
  diagnostics: Schema.Array(CodeModeDiagnostic),
});
export type CodeModeSearchProvidersResult = Schema.Schema.Type<
  typeof CodeModeSearchProvidersResult
>;

/** Search operation result. */
export const CodeModeSearchResult = Schema.Struct({
  actions: Schema.Array(CodeModeActionCandidate),
  diagnostics: Schema.Array(CodeModeDiagnostic),
});
export type CodeModeSearchResult = Schema.Schema.Type<
  typeof CodeModeSearchResult
>;

/** Tool-schema operation result. */
export const CodeModeToolSchemaResult = Schema.Struct({
  tools: Schema.Array(CodeModeToolSchema),
  declarationsByServer: Schema.Array(CodeModeServerDeclaration),
  diagnostics: Schema.Array(CodeModeDiagnostic),
});
export type CodeModeToolSchemaResult = Schema.Schema.Type<
  typeof CodeModeToolSchemaResult
>;
