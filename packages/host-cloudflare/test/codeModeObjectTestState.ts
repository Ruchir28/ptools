import type { CodeModeRequest } from "@ptools/code-mode-api";
import type { HostApiCaller } from "@ptools/host-api";

/** Operation facts recorded at the receiving Durable Object boundary. */
export interface CodeModeObjectTestCall {
  readonly hostId: string | undefined;
  readonly request: CodeModeRequest;
  readonly origin: string;
  readonly caller: HostApiCaller | undefined;
}

/**
 * Calls are partitioned by the named Durable Object host ID so integration
 * files can run concurrently without resetting or erasing each other's state.
 * Tests use unique host IDs and inspect only the instance they invoked.
 */
const callsByHost = new Map<string, Array<CodeModeObjectTestCall>>();

export const recordCodeModeObjectCall = (
  call: CodeModeObjectTestCall,
): void => {
  if (call.hostId === undefined) return;
  const calls = callsByHost.get(call.hostId) ?? [];
  calls.push(call);
  callsByHost.set(call.hostId, calls);
};

export const codeModeObjectTestCallsForHost = (
  hostId: string,
): ReadonlyArray<CodeModeObjectTestCall> => callsByHost.get(hostId) ?? [];
