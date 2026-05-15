import type { Effect } from "effect";

// Generated sandbox code can pass anything, so host handlers must validate
// before trusting the input shape.
export type ExecutorProviderInput = unknown;
export type ExecutorProviderOutput = unknown;
export type ExecutorProviderFailure = unknown;

export type ExecutorProviderResult = Effect.Effect<
  ExecutorProviderOutput,
  ExecutorProviderFailure
>;

export type ExecutorProviderHandler = (
  input: ExecutorProviderInput,
) => ExecutorProviderResult;

export interface ExecutorProvider {
  readonly name: string;
  readonly fns: Readonly<Record<string, ExecutorProviderHandler>>;
}

export type ExecutorProviders = ReadonlyArray<ExecutorProvider>;

export interface ExecuteRequest {
  readonly code: string;
  readonly globals?: Record<string, unknown>;
  readonly providers?: ExecutorProviders;
  readonly timeoutMs?: number;
}

export type LogLevel = "debug" | "error" | "info" | "log" | "warn";

export interface CapturedLog {
  readonly level: LogLevel;
  readonly message: string;
  readonly args: ReadonlyArray<unknown>;
}

export interface ExecuteResult {
  readonly value: unknown;
  readonly logs: ReadonlyArray<CapturedLog>;
}

export interface LocalSandboxExecutorOptions {
  readonly defaultTimeoutMs?: number;
}

export interface SerializedSandboxError {
  readonly name?: string;
  readonly message: string;
  readonly stack?: string;
  readonly code?: string;
}

export type RpcCallRequest = {
  readonly provider: string;
  readonly tool: string;
  readonly input: unknown;
};

export type RpcCallResponse =
  | {
      readonly ok: true;
      readonly value?: unknown;
    }
  | {
      readonly ok: false;
      readonly error: SerializedSandboxError;
    };

export type SandboxCompleteRequest =
  | {
      readonly ok: true;
      readonly value?: unknown;
      readonly logs: ReadonlyArray<CapturedLog>;
    }
  | {
      readonly ok: false;
      readonly error: SerializedSandboxError;
      readonly logs: ReadonlyArray<CapturedLog>;
    };
