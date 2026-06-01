import type {
  CodeModeClientHandle,
  CodeModeDiagnostic,
  CodeModeOperation,
  CodeModeToolName,
} from "@ptools/code-mode-api";

export type { CodeModeClientHandle, CodeModeOperation, CodeModeToolName };

export interface PtoolsSession {
  readonly callCodeModeTool: (
    name: CodeModeOperation,
    input: unknown,
  ) => Promise<unknown>;
  readonly diagnostics: () => Promise<ReadonlyArray<CodeModeDiagnostic>>;
  readonly close: () => Promise<void>;
}

export interface ToolNameOptions {
  readonly toolNamePrefix?: string | false;
}
