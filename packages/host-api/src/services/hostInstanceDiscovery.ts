/**
 * Shared host-instance discovery boundary for decoded Host API operations.
 *
 * HTTP handlers produce a `HostOperationDispatchInput` containing the route
 * `hostId`, accepted public origin, verified caller, and decoded operation. This
 * service resolves that route-selected `hostId` into a platform-owned handle
 * without teaching shared Host API code about Node directories, Cloudflare
 * Durable Objects, configured runtimes, or storage.
 */
import type { HostOperationResponse } from "../contracts/hostOperationEnvelope.js";
import { Context, Effect, Layer } from "effect";
import {
  HostOperationDispatchError,
  HostOperationDispatcher,
  type HostOperationDispatchInput,
} from "./hostOperationDispatcher.js";

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

/**
 * Shared `HostOperationDispatcher` implementation backed by host discovery.
 *
 * This layer is the reusable dispatch path for platforms that have migrated to
 * `HostInstanceDiscovery`: resolve the handle using `input.hostId`, then forward
 * the same dispatch input without rebuilding or renaming caller/origin/request
 * fields.
 */
export const HostOperationDispatcherFromInstanceDiscoveryLive: Layer.Layer<
  HostOperationDispatcher,
  never,
  HostInstanceDiscovery
> = Layer.effect(
  HostOperationDispatcher,
  Effect.gen(function* () {
    const discovery = yield* HostInstanceDiscovery;

    return HostOperationDispatcher.of({
      dispatch: (input) =>
        discovery
          .resolve(input.hostId)
          .pipe(Effect.flatMap((handle) => handle.dispatch(input))),
    });
  }),
);
