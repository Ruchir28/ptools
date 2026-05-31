import type { CapturedLog } from "@ptools/executor";
import type { McpAuthStatus } from "@ptools/auth";
import type { McpRegistryDiagnostic } from "@ptools/mcp-registry";

/**
 * Request for discovering configured provider namespaces.
 */
export interface CodeModeSearchProvidersRequest {
  /**
   * Optional text query used to filter providers by name or capability hints.
   * Blank or missing means "return every provider".
   */
  readonly query?: string;
  /**
   * Optional maximum number of provider rows to return.
   */
  readonly limit?: number;
}

/**
 * Request for discovering callable Code Mode actions.
 */
export interface CodeModeSearchRequest {
  /**
   * Text query used to filter actions by provider, name, title, description,
   * or top-level input fields. Must be non-blank.
   */
  readonly query: string;
  /**
   * Optional generated-code provider namespace used to narrow action search.
   */
  readonly provider?: string;
  /**
   * Optional maximum number of action rows to return.
   */
  readonly limit?: number;
}

/**
 * Request for fetching full schema/declaration details for selected tools.
 */
export interface CodeModeToolSchemaRequest {
  /**
   * Copy-safe tool IDs returned by action search, e.g. `github.create_issue`.
   */
  readonly toolIds?: ReadonlyArray<string>;
  /**
   * Batched list of sanitized provider/tool names selected from action search.
   */
  readonly tools?: ReadonlyArray<{
    readonly jsServerName: string;
    readonly jsToolName: string;
  }>;
}

/**
 * Request for executing generated JavaScript against the provider API surface.
 */
export interface CodeModeExecuteRequest {
  /**
   * JavaScript function expression evaluated and called by the executor.
   *
   * Use an async arrow function for provider calls:
   *
   * ```ts
   * async () => {
   *   const result = await exa.web_search_exa({ query: "example" });
   *   return result;
   * }
   * ```
   *
   * Do not send a script body, top-level await, top-level return, or a
   * function declaration.
   */
  readonly code: string;
  /**
   * Optional per-run timeout override in milliseconds.
   */
  readonly timeoutMs?: number;
}

/**
 * Result returned after generated code finishes executing.
 */
export interface CodeModeRunResult {
  /**
   * Value returned by the generated code.
   */
  readonly value: unknown;
  /**
   * Console logs captured from sandbox execution.
   */
  readonly logs: ReadonlyArray<CapturedLog>;
}

/**
 * Model-facing provider discovery payload returned by `search_providers`.
 */
export interface CodeModeSearchProvidersResult {
  /**
   * Compact provider summaries for matching upstream MCP servers.
   */
  readonly providers: ReadonlyArray<CodeModeProviderSummary>;
  /**
   * Registry diagnostics collected while connecting and discovering upstream
   * MCP servers. Empty means every configured upstream loaded cleanly.
   */
  readonly diagnostics: ReadonlyArray<CodeModeDiagnostic>;
}

/**
 * Model-facing action discovery payload returned by `search`.
 */
export interface CodeModeSearchResult {
  /**
   * Flat action candidates for the matching callable API surface.
   */
  readonly actions: ReadonlyArray<CodeModeActionCandidate>;
  /**
   * Registry diagnostics collected while connecting and discovering upstream
   * MCP servers. Empty means every configured upstream loaded cleanly.
   */
  readonly diagnostics: ReadonlyArray<CodeModeDiagnostic>;
}

export type CodeModeDiagnostic = McpRegistryDiagnostic;

export type CodeModeAuthStatusResult = McpAuthStatus;

/**
 * Full schema/declaration payload returned for selected tools.
 */
export interface CodeModeToolSchemaResult {
  readonly tools: ReadonlyArray<CodeModeToolSchema>;
  readonly declarationsByServer: ReadonlyArray<CodeModeServerDeclaration>;
  readonly diagnostics: ReadonlyArray<CodeModeDiagnostic>;
}

/**
 * TypeScript declaration bundle for requested tools under one provider
 * namespace.
 */
export interface CodeModeServerDeclaration {
  readonly serverName: string;
  readonly jsServerName: string;
  /**
   * Self-contained TypeScript declaration snippet for only the requested tools
   * from this server. It uses the real provider namespace exposed to generated
   * code and includes referenced input/output types.
   */
  readonly declaration: string;
}

/**
 * Compact provider summary used by provider discovery.
 */
export interface CodeModeProviderSummary {
  /**
   * Generated-code provider namespace.
   */
  readonly provider: string;
  /**
   * Human-facing provider display name.
   */
  readonly displayName: string;
  /**
   * Number of actions available under this provider.
   */
  readonly toolCount: number;
  /**
   * Optional provider description from real upstream/server metadata when
   * available. Omitted rather than filled with generic boilerplate.
   */
  readonly description?: string;
  /**
   * Short query examples derived from discovered action names.
   */
  readonly exampleQueries: ReadonlyArray<string>;
}

/**
 * Flat schema-free action row used by action discovery.
 */
export interface CodeModeActionCandidate {
  /**
   * Copy-safe selector accepted by `get_tool_schema`.
   */
  readonly toolId: string;
  /**
   * Generated-code provider namespace.
   */
  readonly provider: string;
  /**
   * Generated-code action/function name.
   */
  readonly action: string;
  /**
   * Short code-shaped call hint.
   */
  readonly call: string;
  readonly title?: string;
  readonly description?: string;
  /**
   * Best-effort top-level input field names from the input schema.
   */
  readonly inputFields: ReadonlyArray<string>;
}

/**
 * Full selected-tool schema data.
 */
export interface CodeModeToolSchema {
  readonly serverName: string;
  readonly jsServerName: string;
  readonly originalToolName: string;
  readonly jsToolName: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema: unknown;
  readonly outputSchema?: unknown;
  readonly outputSchemaInvalid?: true;
  readonly annotations?: unknown;
}

/**
 * One upstream MCP server represented in model-facing search results.
 */
export interface CodeModeServerSummary {
  /**
   * Original MCP server name from user configuration.
   */
  readonly serverName: string;
  /**
   * Sanitized JavaScript namespace exposed to generated code.
   */
  readonly jsServerName: string;
  /**
   * Schema-free tool summaries available under this provider namespace.
   */
  readonly tools: ReadonlyArray<CodeModeToolSummary>;
}

/**
 * Schema-free summary for one upstream MCP tool.
 */
export interface CodeModeToolSummary {
  /**
   * Original upstream MCP tool name.
   */
  readonly originalToolName: string;
  /**
   * Sanitized JavaScript function name exposed to generated code.
   */
  readonly jsToolName: string;
  /**
   * Optional MCP tool title.
   */
  readonly title?: string;
  /**
   * Optional MCP tool description.
   */
  readonly description?: string;
  /**
   * Present when a full input schema is available via `get_tool_schema`.
   */
  readonly inputSchemaAvailable: true;
  /**
   * Present when a full output schema is available via `get_tool_schema`.
   */
  readonly outputSchemaAvailable?: true;
  /**
   * Present when the upstream advertised an output schema that could not be
   * compiled. The tool remains callable, but declarations use `unknown`.
   */
  readonly outputSchemaInvalid?: true;
  /**
   * Optional MCP tool annotations.
   */
  readonly annotations?: unknown;
}

/**
 * One upstream MCP server represented as one sandbox provider namespace.
 */
export interface CodeModeServerMetadata {
  /**
   * Original MCP server name from user configuration.
   */
  readonly serverName: string;
  /**
   * Sanitized JavaScript namespace exposed to generated code.
   */
  readonly jsServerName: string;
  /**
   * Tools available under this provider namespace.
   */
  readonly tools: ReadonlyArray<CodeModeToolMetadata>;
}

/**
 * One upstream MCP tool represented as one sandbox provider function.
 */
export interface CodeModeToolMetadata {
  /**
   * Original upstream MCP tool name.
   */
  readonly originalToolName: string;
  /**
   * Sanitized JavaScript function name exposed to generated code.
   */
  readonly jsToolName: string;
  /**
   * Optional MCP tool title.
   */
  readonly title?: string;
  /**
   * Optional MCP tool description.
   */
  readonly description?: string;
  /**
   * MCP input schema. Kept unknown at the boundary until declaration generation.
   */
  readonly inputSchema: unknown;
  /**
   * Optional MCP output schema describing structuredContent.
   */
  readonly outputSchema?: unknown;
  /**
   * Present when the upstream advertised an output schema that could not be
   * compiled. The tool remains callable, but declarations use `unknown`.
   */
  readonly outputSchemaInvalid?: true;
  /**
   * Optional MCP tool annotations.
   */
  readonly annotations?: unknown;
}
