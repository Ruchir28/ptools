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
export const HostApiRequest = Schema.Union(
  HostCodeModeRequest,
  ConfigureHostRequest,
  ConfigureHostSecretsRequest,
  HostMcpAuthStatusRequest,
  StartHostMcpAuthRequest,
  CompleteHostMcpOAuthCallbackRequest,
);
export type HostApiRequest = Schema.Schema.Type<typeof HostApiRequest>;

/** Any response for a successfully dispatched host-api operation. */
export const HostApiOperationResponse = Schema.Union(
  HostCodeModeResponse,
  ConfigureHostResponse,
  ConfigureHostSecretsResponse,
  HostMcpAuthStatusResponse,
  StartHostMcpAuthResponse,
  CompleteHostMcpOAuthCallbackResponse,
);
export type HostApiOperationResponse = Schema.Schema.Type<
  typeof HostApiOperationResponse
>;

/**
 * Failure before a specific host operation can own the result, such as invalid
 * envelope, unauthorized caller, unknown operation, or host unavailability.
 */
export const HostApiProtocolFailureResponse = Schema.TaggedStruct(
  "HostApiProtocolFailureResponse",
  {
    error: Schema.Struct({
      code: Schema.Literal(
        "invalid_host_api_request",
        "unauthorized",
        "unknown_operation",
        "host_unavailable",
      ),
      message: Schema.String,
    }),
  },
);
export type HostApiProtocolFailureResponse = Schema.Schema.Type<
  typeof HostApiProtocolFailureResponse
>;

/** Top-level host-api response: operation response or protocol failure. */
export const HostApiResponse = Schema.Union(
  HostApiOperationResponse,
  HostApiProtocolFailureResponse,
);
export type HostApiResponse = Schema.Schema.Type<typeof HostApiResponse>;
