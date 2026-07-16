/** Worker-side carrier adapter for the single CodeModeObject operation RPC. */
import {
  HostOperationDispatchInput,
  HostOperationResponse,
} from "@ptools/host-api";
import { HostOperationDispatchError } from "@ptools/host-api/effect";
import { Effect, Schema } from "effect";
import type {
  CloudflareHostOperationRpcInput,
  CodeModeObjectRpc,
} from "../objects/codeModeObject/rpc.js";

export interface CodeModeObjectNamespace {
  readonly getByName: (hostId: string) => CodeModeObjectRpc;
}

export const toCloudflareHostOperationRpcInput = (
  input: HostOperationDispatchInput,
): Effect.Effect<CloudflareHostOperationRpcInput, HostOperationDispatchError> =>
  Schema.encode(HostOperationDispatchInput)(input).pipe(
    Effect.mapError(
      (cause) =>
        new HostOperationDispatchError({
          message: `Failed to encode host operation for ${input.hostId}.`,
          cause,
        }),
    ),
  );

export const callCodeModeObjectHostOperation = (input: {
  readonly stub: CodeModeObjectRpc;
  readonly operation: HostOperationDispatchInput;
}): Effect.Effect<HostOperationResponse, HostOperationDispatchError> =>
  toCloudflareHostOperationRpcInput(input.operation).pipe(
    Effect.flatMap((rpcInput) =>
      Effect.tryPromise({
        try: () => input.stub.handleHostOperation(rpcInput),
        catch: (cause) =>
          new HostOperationDispatchError({
            message: `Cloudflare host operation RPC failed for ${input.operation.hostId}.`,
            cause,
          }),
      }),
    ),
    // Workers RPC is an isolate boundary. Its TypeScript stub type is not runtime
    // proof, so validate the returned logical protocol before shared HTTP code
    // trusts or projects the operation-specific response.
    Effect.flatMap((response) =>
      Schema.decodeUnknown(HostOperationResponse)(response, {
        errors: "all",
      }).pipe(
        Effect.mapError(
          (cause) =>
            new HostOperationDispatchError({
              message: `Cloudflare host operation RPC returned an invalid response for ${input.operation.hostId}.`,
              cause,
            }),
        ),
      ),
    ),
  );
