/**
 * Platform-owned interpreter for decoded host operations.
 *
 * HTTP, Workers RPC, stdio, and in-process carriers should decode their own
 * request shape first, then call this service with the selected host id and
 * normalized ingress facts. The dispatcher owns platform host selection and
 * operation execution; it does not parse HTTP requests or headers.
 */
import type {
  HostApiRequest,
  HostApiResponse,
} from "../contracts/hostApiEnvelope.js";
import { Context, Data, Effect, Option } from "effect";

/** Normalized identity for callers accepted by Host API access middleware. */
export interface HostApiCaller {
  readonly kind: "HostApiTokenCaller";
}

/** Input passed from shared HTTP handlers into a platform dispatcher. */
export interface HostOperationDispatchInput {
  /** Route-selected host id. The platform decides how this selects host state. */
  readonly hostId: string;
  /** Public base URL used by auth links and OAuth redirect_uri values. */
  readonly publicOrigin: string;
  /** Verified API caller for credentialed routes; browser/OAuth routes omit it. */
  readonly caller: Option.Option<HostApiCaller>;
  /** Decoded host operation request. */
  readonly request: HostApiRequest;
}

/** Error raised when a platform cannot dispatch a decoded host operation. */
export class HostOperationDispatchError extends Data.TaggedError(
  "HostOperationDispatchError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Platform-owned dispatcher for already-decoded host operation requests. */
export class HostOperationDispatcher extends Context.Tag(
  "@ptools/HostOperationDispatcher",
)<
  HostOperationDispatcher,
  {
    readonly dispatch: (
      input: HostOperationDispatchInput,
    ) => Effect.Effect<HostApiResponse, HostOperationDispatchError>;
  }
>() {}
