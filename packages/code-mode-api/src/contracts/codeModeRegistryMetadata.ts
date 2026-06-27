/**
 * Code Mode registry metadata contracts derived from upstream MCP discovery.
 *
 * These plain interfaces are internal/public helper shapes used to build search
 * results, generated declarations, and tool metadata. They are not wire DTOs;
 * request/response wire contracts live in the neighboring schema files.
 */

/** Lightweight tool summary used by Code Mode registry metadata helpers. */
export interface CodeModeToolSummary {
  readonly originalToolName: string;
  readonly jsToolName: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchemaAvailable: true;
  readonly outputSchemaAvailable?: true;
  readonly outputSchemaInvalid?: true;
  readonly annotations?: unknown;
}

/** Lightweight server summary used by Code Mode registry metadata helpers. */
export interface CodeModeServerSummary {
  readonly serverName: string;
  readonly jsServerName: string;
  readonly tools: ReadonlyArray<CodeModeToolSummary>;
}

/** Tool metadata used internally to build Code Mode search and declarations. */
export interface CodeModeToolMetadata {
  readonly originalToolName: string;
  readonly jsToolName: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema: unknown;
  readonly outputSchema?: unknown;
  readonly outputSchemaInvalid?: true;
  readonly annotations?: unknown;
}

/** Server metadata used internally to build Code Mode search and declarations. */
export interface CodeModeServerMetadata {
  readonly serverName: string;
  readonly jsServerName: string;
  readonly tools: ReadonlyArray<CodeModeToolMetadata>;
}
