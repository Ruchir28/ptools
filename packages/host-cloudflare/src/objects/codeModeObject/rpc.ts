/** Plain Worker -> Durable Object host-operation RPC contract. */
import {
  HostOperationDispatchInput,
  type EncodedHostOperationDispatchInput,
  type HostOperationResponse,
} from "@ptools/host-api";
import { Schema } from "effect";

/** Shared encoded dispatch value carried unchanged over Workers RPC. */
export type CloudflareHostOperationRpcInput = EncodedHostOperationDispatchInput;

export type CloudflareHostOperationRpcResponse = HostOperationResponse;

/** Validate and restore the shared domain value after the Workers RPC boundary. */
export const decodeCloudflareHostOperationRpcInput = (input: unknown) =>
  Schema.decodeUnknownEffect(HostOperationDispatchInput)(input, {
    errors: "all",
    onExcessProperty: "error",
  });

/** The one callable host-operation surface exposed by a named CodeModeObject. */
export interface CodeModeObjectRpc {
  readonly handleHostOperation: (
    input: CloudflareHostOperationRpcInput,
  ) => Promise<CloudflareHostOperationRpcResponse>;
}
