import { Data } from "effect";

/** Conventional product-selected identity; public constructors do not default it. */
export const NODE_LOCAL_HOST_ID = "node-local";
export const DEFAULT_NODE_PUBLIC_ORIGIN = "http://127.0.0.1:19876";
export const NODE_INTERNAL_ACCESS_TOKEN = "ptools-node-internal";

export class HostNodeError extends Data.TaggedError("HostNodeError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * Embedded Node ingress and daemon namespace settings.
 *
 * Authored config and configured secrets are intentionally absent: callers
 * initialize the selected host through shared Host API operations.
 */
export interface NodeHostOptions {
  /** Explicit logical actor identity inside the selected state namespace. */
  readonly hostId: string;
  /** Origin owned by the embedded local HTTP listener. */
  readonly publicOrigin?: string;
  /** Absolute app/profile state directory; defaults through PTOOLS_HOME/home. */
  readonly internalStateDirectory?: string;
  /** Optional Deno executable used by daemon-owned sandbox actors. */
  readonly denoExecutable?: string;
}
