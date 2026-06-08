import type { CodeModeRequest, CodeModeResponse } from "@ptools/code-mode-api";
import { DurableObject } from "cloudflare:workers";
import worker from "../src/worker/entry.js";
import {
  codeModeObjectTestFailure,
  codeModeObjectTestResponse,
  recordCodeModeObjectCall,
} from "./codeModeObjectTestState.js";

export class TestCodeModeObject extends DurableObject {
  call(request: CodeModeRequest): Promise<CodeModeResponse> {
    recordCodeModeObjectCall({
      hostId: this.ctx.id.name,
      request,
    });

    const failure = codeModeObjectTestFailure();

    return failure === undefined
      ? Promise.resolve(codeModeObjectTestResponse())
      : Promise.reject(failure);
  }
}

export default worker;
