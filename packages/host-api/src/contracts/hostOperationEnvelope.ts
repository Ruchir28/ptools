/**
 * Top-level host-api request/response envelopes.
 *
 * This file owns the transport-agnostic message contract shared by host
 * clients, transports, and servers. It intentionally does not own HTTP, stdio,
 * Workers RPC, or platform-specific carrier behavior.
 */
import { Schema } from "effect";
import {
  ConfigureHostRequest,
  ConfigureHostResponse,
} from "./configureHost.js";
import {
  ConfigureHostSecretsRequest,
  ConfigureHostSecretsResponse,
} from "./hostSecrets.js";
import {
  CompleteHostMcpOAuthCallbackRequest,
  CompleteHostMcpOAuthCallbackResponse,
  HostMcpAuthStatusRequest,
  HostMcpAuthStatusResponse,
  StartHostMcpAuthRequest,
  StartHostMcpAuthResponse,
} from "./hostMcpAuth.js";
import { HostCodeModeRequest, HostCodeModeResponse } from "./hostCodeMode.js";

/** Any host-api operation request a transport can carry. */
export const HostOperationRequest = Schema.Union([
  HostCodeModeRequest,
  ConfigureHostRequest,
  ConfigureHostSecretsRequest,
  HostMcpAuthStatusRequest,
  StartHostMcpAuthRequest,
  CompleteHostMcpOAuthCallbackRequest,
]);
export type HostOperationRequest = Schema.Schema.Type<
  typeof HostOperationRequest
>;

/** Any response for a successfully dispatched host-api operation. */
export const HostOperationResultResponse = Schema.Union([
  HostCodeModeResponse,
  ConfigureHostResponse,
  ConfigureHostSecretsResponse,
  HostMcpAuthStatusResponse,
  StartHostMcpAuthResponse,
  CompleteHostMcpOAuthCallbackResponse,
]);
export type HostOperationResultResponse = Schema.Schema.Type<
  typeof HostOperationResultResponse
>;

/**
 * Failure inside the trusted actor protocol before a specific operation can
 * own the result: malformed input, an unknown operation, or a wrong/unavailable
 * selected Host. Public authentication and authorization finish before this
 * boundary and therefore are not actor protocol failures.
 */
export const HostOperationProtocolFailureResponse = Schema.TaggedStruct(
  "HostOperationProtocolFailureResponse",
  {
    error: Schema.Struct({
      code: Schema.Literals([
        "invalid_host_api_request",
        "unknown_operation",
        "host_unavailable",
      ]),
      message: Schema.String,
    }),
  },
);
export type HostOperationProtocolFailureResponse = Schema.Schema.Type<
  typeof HostOperationProtocolFailureResponse
>;

/** Top-level host-api response: operation response or protocol failure. */
export const HostOperationResponse = Schema.Union([
  HostOperationResultResponse,
  HostOperationProtocolFailureResponse,
]);
export type HostOperationResponse = Schema.Schema.Type<
  typeof HostOperationResponse
>;
