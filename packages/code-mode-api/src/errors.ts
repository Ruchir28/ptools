import { Data } from "effect";

export class CodeModeInvalidRequestError extends Data.TaggedError(
  "CodeModeInvalidRequestError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class CodeModeTransportError extends Data.TaggedError(
  "CodeModeTransportError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class CodeModeRemoteError extends Data.TaggedError(
  "CodeModeRemoteError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class CodeModeServerFailure extends Data.TaggedError(
  "CodeModeServerFailure",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export type CodeModeClientError =
  | CodeModeInvalidRequestError
  | CodeModeTransportError
  | CodeModeRemoteError;

export type CodeModeServerError =
  | CodeModeInvalidRequestError
  | CodeModeServerFailure;
