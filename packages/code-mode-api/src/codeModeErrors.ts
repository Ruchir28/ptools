/**
 * Typed Code Mode API errors shared by clients, transports, and servers.
 *
 * These errors describe failures at the Code Mode contract boundary. Host-api
 * protocol failures and platform HTTP errors are owned by their respective
 * packages and should be mapped into these errors only at adapter seams.
 */
import { Data } from "effect";

/** Request value failed Code Mode schema validation or operation parsing. */
export class CodeModeInvalidRequestError extends Data.TaggedError(
  "CodeModeInvalidRequestError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Response value failed Code Mode schema validation or operation matching. */
export class CodeModeInvalidResponseError extends Data.TaggedError(
  "CodeModeInvalidResponseError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Transport carrier failed before a valid Code Mode response was received. */
export class CodeModeTransportError extends Data.TaggedError(
  "CodeModeTransportError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Remote host returned a structured Code Mode operation failure. */
export class CodeModeRemoteError extends Data.TaggedError(
  "CodeModeRemoteError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Host-side Code Mode runtime failed while handling a valid request. */
export class CodeModeServerFailure extends Data.TaggedError(
  "CodeModeServerFailure",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Error channel for Effect-native Code Mode clients. */
export type CodeModeClientError =
  | CodeModeInvalidRequestError
  | CodeModeInvalidResponseError
  | CodeModeTransportError
  | CodeModeRemoteError;

/** Error channel for Effect-native Code Mode servers. */
export type CodeModeServerError =
  | CodeModeInvalidRequestError
  | CodeModeServerFailure;
