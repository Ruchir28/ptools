/**
 * Shared host-instance discovery boundary for decoded Host API operations.
 *
 * HTTP handlers produce a `HostOperationDispatchInput` containing the route
 * `hostId`, accepted public origin, verified caller, and decoded operation. This
 * service resolves that route-selected `hostId` into a platform-owned handle
 * without teaching shared Host API code about Node directories, Cloudflare
 * Durable Objects, configured runtimes, or storage.
 */
import type { HostOperationDispatchInput } from "../contracts/hostOperationDispatch.js";
import type { HostOperationResponse } from "../contracts/hostOperationEnvelope.js";
import { Context, Effect } from "effect";
import { HostOperationDispatchError } from "./hostOperationDispatchError.js";

/**
 * Callable handle for one platform-selected host instance.
 *
 * The handle receives the original `HostOperationDispatchInput` unchanged. A
 * handle that is bound to one host should fail fast if `input.hostId` does not
 * match its selected host id; such a mismatch is an internal routing bug.
 */
export interface HostInstanceHandle {
  readonly dispatch: (
    input: HostOperationDispatchInput,
  ) => Effect.Effect<HostOperationResponse, HostOperationDispatchError>;
}

/**
 * Platform-provided resolver from route `hostId` to a callable host handle.
 *
 * Cloudflare implementations resolve Durable Object handles. Node
 * implementations resolve local handles backed by host-scoped state and runtime
 * managers. The shared Host API only depends on this service, not on either
 * platform's lookup mechanism.
 */
export class HostInstanceDiscovery extends Context.Tag(
  "@ptools/HostInstanceDiscovery",
)<
  HostInstanceDiscovery,
  {
    readonly resolve: (
      hostId: string,
    ) => Effect.Effect<HostInstanceHandle, HostOperationDispatchError>;
  }
>() {}
