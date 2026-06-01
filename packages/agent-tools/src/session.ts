import {
  parseCodeModeToolCall,
  type CodeModeClientHandle,
  type CodeModeOperation,
  type CodeModeRequest,
  type CodeModeResponse,
} from "@ptools/code-mode-api";
import { Effect } from "effect";
import type { PtoolsSession } from "./types.js";

type ClientCallResult<Operation extends CodeModeResponse["operation"]> =
  Extract<CodeModeResponse, { readonly operation: Operation }>["output"];

export const makePtoolsSession = (
  client: CodeModeClientHandle,
): PtoolsSession => ({
  callCodeModeTool: async (name, input) => {
    const request = await parseToolCall(name, input);
    return await callClient(client, request);
  },
  diagnostics: async () => {
    const output = await callClient(client, { operation: "search_providers" });

    return output.diagnostics;
  },
  close: () => client.close(),
});

const parseToolCall = (
  name: CodeModeOperation,
  input: unknown,
): Promise<CodeModeRequest> =>
  Effect.runPromise(parseCodeModeToolCall(name, input));

const callClient = async <Operation extends CodeModeRequest["operation"]>(
  client: CodeModeClientHandle,
  request: Extract<CodeModeRequest, { readonly operation: Operation }>,
): Promise<ClientCallResult<Operation>> => {
  const response = await client.call(request);

  if (response.operation !== request.operation) {
    throw new Error(
      `Code Mode client returned ${response.operation} for ${request.operation}`,
    );
  }

  return (
    response as Extract<CodeModeResponse, { readonly operation: Operation }>
  ).output as ClientCallResult<Operation>;
};
