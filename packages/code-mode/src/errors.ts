import { Data } from "effect";

export class CodeModeInvariantError extends Data.TaggedError(
  "CodeModeInvariantError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class CodeModeExecuteError extends Data.TaggedError(
  "CodeModeExecuteError",
)<{
  readonly cause: unknown;
}> {}

export type CodeModeError = CodeModeInvariantError | CodeModeExecuteError;
