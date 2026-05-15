import { Data } from "effect";
import type { SerializedSandboxError } from "./types.js";

export class ExecutorStartError extends Data.TaggedError(
  "ExecutorStartError",
)<{
  readonly cause: unknown;
}> {}

export class ExecutorProtocolError extends Data.TaggedError(
  "ExecutorProtocolError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class ExecutorTimeoutError extends Data.TaggedError(
  "ExecutorTimeoutError",
)<{
  readonly timeoutMs: number;
}> {}

export class InvalidExecutorCode extends Data.TaggedError(
  "InvalidExecutorCode",
)<{
  readonly error: SerializedSandboxError;
}> {}

export class ExecutorRuntimeError extends Data.TaggedError(
  "ExecutorRuntimeError",
)<{
  readonly error: SerializedSandboxError;
}> {}

export type ExecutorError =
  | ExecutorStartError
  | ExecutorProtocolError
  | ExecutorTimeoutError
  | InvalidExecutorCode
  | ExecutorRuntimeError;
