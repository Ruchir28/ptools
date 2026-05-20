import type { CodeModeDiagnostic } from "@ptools/code-mode";
import type { LocalSandboxExecutorOptions } from "@ptools/executor";
import type { UpstreamMcpServers } from "@ptools/mcp-registry";

export type CodeModeToolName = "search" | "get_tool_schema" | "execute";

export interface CreatePtoolsSessionOptions {
  readonly mcpServers: UpstreamMcpServers;
  readonly executor?: LocalSandboxExecutorOptions;
}

export interface CreatePtoolsSessionFromConfigFileOptions {
  readonly cwd?: string;
  readonly env?: Record<string, string | undefined>;
}

export interface PtoolsSession {
  readonly callCodeModeTool: (
    name: CodeModeToolName,
    input: unknown,
  ) => Promise<unknown>;
  readonly diagnostics: () => Promise<ReadonlyArray<CodeModeDiagnostic>>;
  readonly close: () => Promise<void>;
}

export interface ToolNameOptions {
  readonly toolNamePrefix?: string | false;
}
