import { Schema } from "effect";
import { HostOperationRequest } from "./hostOperationEnvelope.js";

/**
 * Trusted caller principal produced after ingress verifies its carrier
 * credential. The original credential is not included in dispatch data.
 */
export const HostApiCaller = Schema.Struct({
  kind: Schema.Literal("HostApiTokenCaller"),
});

export type HostApiCaller = Schema.Schema.Type<typeof HostApiCaller>;

/**
 * Complete logical operation passed from ingress to one selected host instance.
 *
 * The decoded form keeps caller absence as `Option`; the encoded form uses an
 * omitted plain property so platform carriers can transfer ordinary data.
 */
export const HostOperationDispatchInput = Schema.Struct({
  hostId: Schema.String,
  publicOrigin: Schema.String,
  caller: Schema.OptionFromOptionalKey(HostApiCaller),
  request: HostOperationRequest,
});

export type HostOperationDispatchInput = Schema.Schema.Type<
  typeof HostOperationDispatchInput
>;

/** Plain carrier representation produced by encoding the dispatch input. */
export type EncodedHostOperationDispatchInput =
  (typeof HostOperationDispatchInput)["Encoded"];
