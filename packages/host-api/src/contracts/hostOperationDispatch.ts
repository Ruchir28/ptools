import { Schema } from "effect";
import { HostOperationRequest } from "./hostOperationEnvelope.js";

/**
 * Trusted operation carrier passed from admitted ingress to one selected Host.
 *
 * Credentialed operations cross this boundary only after shared Host admission;
 * public credentials, caller identity, tokens, and effective permissions are
 * deliberately withheld. OAuth callbacks use the same carrier because their
 * signed, single-use workflow state is validated by the callback operation.
 */
export const HostOperationDispatchInput = Schema.Struct({
  hostId: Schema.String,
  publicOrigin: Schema.String,
  request: HostOperationRequest,
});

export type HostOperationDispatchInput = Schema.Schema.Type<
  typeof HostOperationDispatchInput
>;

/** Plain carrier representation produced by encoding the dispatch input. */
export type EncodedHostOperationDispatchInput =
  (typeof HostOperationDispatchInput)["Encoded"];
