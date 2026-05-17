import type { CapturedLog } from "@ptools/executor";

/**
 * Request for discovering the currently available Code Mode API surface.
 */
export interface CodeModeSearchRequest {
  /**
   * Optional text query used to filter servers/tools by name, title, or
   * description. Blank or missing means "return everything".
   */
  readonly query?: string;
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
 * Model-facing discovery payload returned by `search`.
 */
export interface CodeModeContext {
  /**
   * Grouped server/tool metadata for the matching API surface.
   */
  readonly servers: ReadonlyArray<CodeModeServerMetadata>;
  /**
   * TypeScript declarations describing the sandbox-visible provider APIs.
   */
  readonly declarations: string;
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
   * Optional MCP tool annotations.
   */
  readonly annotations?: unknown;
}
