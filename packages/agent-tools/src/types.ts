import type {
  CodeModeDiagnostic,
  CodeModeToolName,
} from "@ptools/code-mode-api";
import type { LocalSandboxExecutorOptions } from "@ptools/executor";
import type { UpstreamMcpServers } from "@ptools/mcp-registry";

export type { CodeModeToolName };

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
