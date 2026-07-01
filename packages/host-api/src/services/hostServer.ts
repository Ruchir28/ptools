/**
 * Effect service for host-side request dispatch.
 *
 * This file owns handling already-decoded HostOperationRequest values. It does not
 * own the platform carrier that received the request or the inner services that
 * execute each operation.
 */
import type {
  HostOperationRequest,
  HostOperationResponse,
} from "../contracts/hostOperationEnvelope.js";
import { Context, Data, Effect } from "effect";

/** Error raised when a host cannot dispatch a decoded host-api request. */
export class HostServerError extends Data.TaggedError("HostServerError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Host-side dispatcher for decoded HostOperationRequest values. */
export class HostServer extends Context.Tag("@ptools/HostServer")<
  HostServer,
  {
    readonly handle: (
      request: HostOperationRequest,
    ) => Effect.Effect<HostOperationResponse, HostServerError>;
  }
>() {}
