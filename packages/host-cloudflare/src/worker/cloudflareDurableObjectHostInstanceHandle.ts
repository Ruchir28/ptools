/** Caller-side handle bound to one named Cloudflare Durable Object. */
import type { HostOperationDispatchInput } from "@ptools/host-api";
import {
  HostOperationDispatchError,
  type HostInstanceHandle,
} from "@ptools/host-api/effect";
import { Effect } from "effect";
import type { CodeModeObjectRpc } from "../objects/codeModeObject/rpc.js";
import { callCodeModeObjectHostOperation } from "./codeModeObjectRpc.js";

export const makeCloudflareDurableObjectHostInstanceHandle = (options: {
  readonly hostId: string;
  readonly stub: CodeModeObjectRpc;
}): HostInstanceHandle => ({
  dispatch: (input: HostOperationDispatchInput) =>
    input.hostId !== options.hostId
      ? Effect.fail(
          new HostOperationDispatchError({
            message: `Host handle for ${options.hostId} cannot dispatch an operation for ${input.hostId}.`,
          }),
        )
      : callCodeModeObjectHostOperation({
          stub: options.stub,
          operation: input,
        }),
});
