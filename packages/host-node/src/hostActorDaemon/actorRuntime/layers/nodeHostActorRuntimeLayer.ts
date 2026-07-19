/**
 * @file Composes the platform capabilities for one Node host actor with the
 * shared stable host runtime. Runtime activation and disposal remain outside
 * this module.
 */
import {
  HostSecretStorageBackend,
  HostStateStorageBackend,
} from "@ptools/config";
import { SandboxRuntime } from "@ptools/executor";
import { HostIdentityLayer } from "@ptools/host-context";
import {
  HostStableRuntimeLayer,
  type HostStableRuntimeServices,
} from "@ptools/host-runtime";
import { McpConnector } from "@ptools/mcp-registry";
import { Layer } from "effect";

/**
 * Final platform capabilities supplied by the Node daemon for one actor build.
 *
 * These are Layer recipes, not actor services exposed to callers. The shared
 * stable Layer consumes their backend tags and publishes only
 * `HostStableRuntimeServices`.
 */
export interface NodeHostActorPlatformLayers {
  readonly stateStorageBackend: Layer.Layer<HostStateStorageBackend, unknown>;
  readonly secretStorageBackend: Layer.Layer<HostSecretStorageBackend, unknown>;
  readonly mcpConnector: Layer.Layer<McpConnector, unknown>;
  readonly sandboxRuntime: Layer.Layer<SandboxRuntime, unknown>;
}

/**
 * Bind one `hostId` to Node primitives and assemble the shared stable Layer.
 *
 * This function only describes Layer composition; it does not build resources,
 * create a `ManagedRuntime`, publish an actor entry, or own disposal. Those
 * lifecycle steps belong to `nodeHostActorRuntime.ts` and the daemon manager.
 */
export const makeNodeHostActorRuntimeLayer = (
  hostId: string,
  platform: NodeHostActorPlatformLayers,
): Layer.Layer<HostStableRuntimeServices, unknown> => {
  const platformCapabilities = Layer.mergeAll(
    HostIdentityLayer(hostId),
    platform.stateStorageBackend,
    platform.secretStorageBackend,
    platform.mcpConnector,
    platform.sandboxRuntime,
  );

  return HostStableRuntimeLayer({ supportsStdioMcp: true }).pipe(
    Layer.provide(platformCapabilities),
  );
};
