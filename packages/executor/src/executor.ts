import { Context, Effect } from "effect";
import type { ExecutorError } from "./errors.js";
import type { ExecuteRequest, ExecuteResult } from "./types.js";

export class CodeExecutor extends Context.Tag("@ptools/CodeExecutor")<
  CodeExecutor,
  {
    readonly execute: (
      request: ExecuteRequest,
    ) => Effect.Effect<ExecuteResult, ExecutorError>;
  }
>() {}
