import { Data } from "effect";

/** Conventional logical host selected by first-party local clients. */
export const NODE_LOCAL_HOST_ID = "node-local";
/** Temporary pre-identity Host API bearer, not a user or administration token. */
export const NODE_INTERNAL_ACCESS_TOKEN = "ptools-node-internal";

export class HostNodeError extends Data.TaggedError("HostNodeError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}
