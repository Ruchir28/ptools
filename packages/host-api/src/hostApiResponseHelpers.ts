/**
 * Shared constructors and guards for host-api response envelopes.
 *
 * These helpers are transport-agnostic object helpers. Platform routes still
 * own HTTP, stdio, RPC, or other carrier parsing and serialization.
 */
import { Schema } from "effect";
import { HostApiProtocolFailureResponse } from "./contracts/hostApiEnvelope.js";

/** Create a top-level protocol failure for requests that cannot be dispatched. */
export const makeHostApiProtocolFailureResponse = (input: {
  readonly code: HostApiProtocolFailureResponse["error"]["code"];
  readonly message: string;
}): HostApiProtocolFailureResponse => ({
  _tag: "HostApiProtocolFailureResponse",
  error: { code: input.code, message: input.message },
});

/** True when a host-api response failed before operation dispatch. */
export const isHostApiProtocolFailureResponse: (
  value: unknown,
) => value is HostApiProtocolFailureResponse = Schema.is(
  HostApiProtocolFailureResponse,
);
