/**
 * Shared constructors and guards for host-api response envelopes.
 *
 * These helpers are transport-agnostic object helpers. Platform routes still
 * own HTTP, stdio, RPC, or other carrier parsing and serialization.
 */
import { Schema } from "effect";
import { HostOperationProtocolFailureResponse } from "./contracts/hostOperationEnvelope.js";

/** Create a top-level protocol failure for requests that cannot be dispatched. */
export const makeHostOperationProtocolFailureResponse = (input: {
  readonly code: HostOperationProtocolFailureResponse["error"]["code"];
  readonly message: string;
}): HostOperationProtocolFailureResponse => ({
  _tag: "HostOperationProtocolFailureResponse",
  error: { code: input.code, message: input.message },
});

/** True when a host-api response failed before operation dispatch. */
export const isHostOperationProtocolFailureResponse: (
  value: unknown,
) => value is HostOperationProtocolFailureResponse = Schema.is(
  HostOperationProtocolFailureResponse,
);
