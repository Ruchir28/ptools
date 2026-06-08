import type { CodeModeRequest, CodeModeResponse } from "@ptools/code-mode-api";
import { DurableObject } from "cloudflare:workers";
import * as Effect from "effect/Effect";

export class CodeModeObject extends DurableObject {
  call(_request: CodeModeRequest): Promise<CodeModeResponse> {
    return Effect.runPromise(
      Effect.die(
        new Error("CodeModeObject runtime is implemented in the next task"),
      ),
    );
  }
}

export type CodeModeObjectRpc = Pick<CodeModeObject, "call">;
