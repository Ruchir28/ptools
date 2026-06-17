/**
 * Typed executor errors. All failures surfaced by the executor kernel are
 * `Data.TaggedError`s collected in {@link ExecutorError}. `InvalidExecutorCode`
 * and `ExecutorRuntimeError` carry a {@link SerializedSandboxError} captured
 * from the sandbox via `decodeSandboxCompleteResult`; `ExecutorProtocolError`
 * covers request-preparation and backend protocol contract failures.
 */
import { Data } from "effect";
import type { SerializedSandboxError } from "./schema.js";

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
