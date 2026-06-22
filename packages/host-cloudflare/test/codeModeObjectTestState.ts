import type { CodeModeRequest, CodeModeResponse } from "@ptools/code-mode-api";

export interface CodeModeObjectTestCall {
  readonly hostId: string | undefined;
  readonly request: CodeModeRequest;
  readonly origin: string;
}

interface CodeModeObjectTestState {
  readonly calls: Array<CodeModeObjectTestCall>;
  response: CodeModeResponse;
  failure: unknown;
}

const defaultResponse = (): CodeModeResponse => ({
  operation: "search_providers",
  output: { providers: [], diagnostics: [] },
});

const state: CodeModeObjectTestState = {
  calls: [],
  response: defaultResponse(),
  failure: undefined,
};

export const resetCodeModeObjectTestState = (): void => {
  state.calls.length = 0;
  state.response = defaultResponse();
  state.failure = undefined;
};

export const recordCodeModeObjectCall = (
  call: CodeModeObjectTestCall,
): void => {
  state.calls.push(call);
};

export const codeModeObjectTestCalls = (): ReadonlyArray<CodeModeObjectTestCall> =>
  state.calls;

export const codeModeObjectTestResponse = (): CodeModeResponse =>
  state.response;

export const codeModeObjectTestFailure = (): unknown => state.failure;

export const setCodeModeObjectTestResponse = (
  response: CodeModeResponse,
): void => {
  state.response = response;
  state.failure = undefined;
};

export const setCodeModeObjectTestFailure = (failure: unknown): void => {
  state.failure = failure;
};
