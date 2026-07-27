/** Caller-side HostInstanceHandle backed only by the private daemon transport. */
import {
  HostOperationDispatchInput,
  HostOperationResponse,
  type EncodedHostOperationDispatchInput,
  type HostOperationDispatchInput as HostOperationDispatchInputType,
} from "@ptools/host-api";
import {
  HostOperationDispatchError,
  type HostInstanceHandle,
} from "@ptools/host-api/effect";
import { Effect, Schema } from "effect";
import type { NodeHostActorDaemonConnectionOperations } from "./services/nodeHostActorDaemonConnection.js";

export const makeNodeDaemonHostInstanceHandle = (options: {
  readonly hostId: string;
  readonly connection: NodeHostActorDaemonConnectionOperations;
}): HostInstanceHandle => ({
  dispatch: (input: HostOperationDispatchInputType) => {
    if (input.hostId !== options.hostId) {
      return Effect.fail(
        new HostOperationDispatchError({
          message: `Host handle for ${options.hostId} cannot dispatch an operation for ${input.hostId}.`,
        }),
      );
    }

    return Schema.encode(HostOperationDispatchInput)(input).pipe(
      Effect.mapError(
        (cause) =>
          new HostOperationDispatchError({
            message: `Failed to encode host operation for ${input.hostId}.`,
            cause,
          }),
      ),
      Effect.flatMap((encoded: EncodedHostOperationDispatchInput) =>
        options.connection.handleHostOperation(encoded).pipe(
          Effect.mapError(
            (cause) =>
              new HostOperationDispatchError({
                message: cause.message,
                cause,
              }),
          ),
        ),
      ),
      Effect.flatMap((response) =>
        Schema.decodeUnknown(HostOperationResponse)(response, {
          errors: "all",
        }).pipe(
          Effect.mapError(
            (cause) =>
              new HostOperationDispatchError({
                message: `Node daemon returned an invalid response for ${input.hostId}.`,
                cause,
              }),
          ),
        ),
      ),
    );
  },
});
