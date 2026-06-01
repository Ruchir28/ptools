import { Context, Effect } from "effect";
import type {
  CodeModeClientError,
  CodeModeServerError,
} from "./errors.js";
import type { CodeModeRequest, CodeModeResponse } from "./types.js";

export class CodeModeClient extends Context.Tag("@ptools/CodeModeClient")<
  CodeModeClient,
  {
    readonly call: (
      request: CodeModeRequest,
    ) => Effect.Effect<CodeModeResponse, CodeModeClientError>;
  }
>() {}

export class CodeModeServer extends Context.Tag("@ptools/CodeModeServer")<
  CodeModeServer,
  {
    readonly handle: (
      request: CodeModeRequest,
    ) => Effect.Effect<CodeModeResponse, CodeModeServerError>;
  }
>() {}
