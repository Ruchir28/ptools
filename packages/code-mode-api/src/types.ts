export type CodeModeOperation =
  | "auth_status"
  | "refresh"
  | "search_providers"
  | "search"
  | "get_tool_schema"
  | "execute";

export type CodeModeToolName = Exclude<
  CodeModeOperation,
  "auth_status" | "refresh"
>;

export type LogLevel = "debug" | "error" | "info" | "log" | "warn";

export interface CapturedLog {
  readonly level: LogLevel;
  readonly message: string;
  readonly args: ReadonlyArray<unknown>;
}

export type CodeModeAuthStatusValue =
  | "connected"
  | "requires_auth"
  | "auth_in_progress"
  | "auth_failed"
  | "needs_config"
  | "static_credentials"
  | "unsupported_auth"
  | "disabled";

export interface CodeModeAuthServerStatus {
  readonly serverName: string;
  readonly jsServerName: string;
  readonly transport: "http" | "stdio";
  readonly status: CodeModeAuthStatusValue;
  readonly authUrl?: string;
  readonly authorizeUrl?: string;
  readonly reauthorizeUrl?: string;
  readonly setupUrl?: string;
  readonly message?: string;
  readonly lastError?: string;
}

export interface CodeModeAuthStatusResult {
  readonly authUrl: string;
  readonly servers: ReadonlyArray<CodeModeAuthServerStatus>;
}

export type CodeModeDiagnostic =
  | {
      readonly code: "McpConnectionFailed";
      readonly severity: "error";
      readonly serverName: string;
      readonly message: string;
    }
  | {
      readonly code: "UpstreamAuthRequired";
      readonly severity: "warning";
      readonly serverName: string;
      readonly message: string;
      readonly authUrl: string;
      readonly authorizeUrl?: string;
    }
  | {
      readonly code: "UpstreamAuthNeedsConfig";
      readonly severity: "warning";
      readonly serverName: string;
      readonly message: string;
      readonly authUrl: string;
      readonly setupUrl?: string;
    }
  | {
      readonly code: "McpDiscoveryFailed";
      readonly severity: "error";
      readonly serverName: string;
      readonly message: string;
    }
  | {
      readonly code: "InvalidInputSchema";
      readonly severity: "error";
      readonly serverName: string;
      readonly toolName: string;
      readonly message: string;
    }
  | {
      readonly code: "InvalidOutputSchema";
      readonly severity: "warning";
      readonly serverName: string;
      readonly toolName: string;
      readonly message: string;
    };

export interface CodeModeSearchProvidersRequest {
  readonly query?: string;
  readonly limit?: number;
}

export interface CodeModeSearchRequest {
  readonly query: string;
  readonly provider?: string;
  readonly limit?: number;
}

export interface CodeModeToolSchemaRequest {
  readonly toolIds: ReadonlyArray<string>;
}

export interface CodeModeExecuteRequest {
  readonly code: string;
  readonly timeoutMs?: number;
}

export interface CodeModeRunResult {
  readonly value: unknown;
  readonly logs: ReadonlyArray<CapturedLog>;
}

export interface CodeModeSearchProvidersResult {
  readonly providers: ReadonlyArray<CodeModeProviderSummary>;
  readonly diagnostics: ReadonlyArray<CodeModeDiagnostic>;
}

export interface CodeModeSearchResult {
  readonly actions: ReadonlyArray<CodeModeActionCandidate>;
  readonly diagnostics: ReadonlyArray<CodeModeDiagnostic>;
}

export interface CodeModeToolSchemaResult {
  readonly tools: ReadonlyArray<CodeModeToolSchema>;
  readonly declarationsByServer: ReadonlyArray<CodeModeServerDeclaration>;
  readonly diagnostics: ReadonlyArray<CodeModeDiagnostic>;
}

export interface CodeModeServerDeclaration {
  readonly serverName: string;
  readonly jsServerName: string;
  readonly declaration: string;
}

export interface CodeModeProviderSummary {
  readonly provider: string;
  readonly displayName: string;
  readonly toolCount: number;
  readonly description?: string;
  readonly exampleQueries: ReadonlyArray<string>;
}

export interface CodeModeActionCandidate {
  readonly toolId: string;
  readonly provider: string;
  readonly action: string;
  readonly call: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputFields: ReadonlyArray<string>;
}

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

export interface CodeModeServerSummary {
  readonly serverName: string;
  readonly jsServerName: string;
  readonly tools: ReadonlyArray<CodeModeToolSummary>;
}

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

export interface CodeModeServerMetadata {
  readonly serverName: string;
  readonly jsServerName: string;
  readonly tools: ReadonlyArray<CodeModeToolMetadata>;
}

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

export type CodeModeRequest =
  | { readonly operation: "auth_status"; readonly input?: undefined }
  | { readonly operation: "refresh"; readonly input?: undefined }
  | {
      readonly operation: "search_providers";
      readonly input?: CodeModeSearchProvidersRequest;
    }
  | { readonly operation: "search"; readonly input: CodeModeSearchRequest }
  | {
      readonly operation: "get_tool_schema";
      readonly input: CodeModeToolSchemaRequest;
    }
  | { readonly operation: "execute"; readonly input: CodeModeExecuteRequest };

export type CodeModeResponse =
  | {
      readonly operation: "auth_status";
      readonly output: CodeModeAuthStatusResult;
    }
  | {
      readonly operation: "refresh";
      readonly output: { readonly refreshed: true };
    }
  | {
      readonly operation: "search_providers";
      readonly output: CodeModeSearchProvidersResult;
    }
  | { readonly operation: "search"; readonly output: CodeModeSearchResult }
  | {
      readonly operation: "get_tool_schema";
      readonly output: CodeModeToolSchemaResult;
    }
  | { readonly operation: "execute"; readonly output: CodeModeRunResult };

export interface CodeModeClientHandle {
  readonly call: (request: CodeModeRequest) => Promise<CodeModeResponse>;
  readonly close: () => Promise<void>;
}
