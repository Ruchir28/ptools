/**
 * Effect service for host-api transports.
 *
 * This file owns the platform-provided message pipe. Implementations may use
 * HTTP, Workers RPC, stdio, in-process calls, or custom carriers; this service
 * owns none of those carrier details itself.
 */
import type {
  HostApiRequest,
  HostApiResponse,
} from "../contracts/hostApiEnvelope.js";
import { Context, Data, Effect } from "effect";

/** Error raised when the carrier cannot move a host-api request/response. */
export class HostTransportError extends Data.TaggedError("HostTransportError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Platform-provided pipe for one HostApiRequest to one HostApiResponse. */
export class HostTransport extends Context.Tag("@ptools/HostTransport")<
  HostTransport,
  {
    readonly call: (
      request: HostApiRequest,
    ) => Effect.Effect<HostApiResponse, HostTransportError>;
  }
>() {}
