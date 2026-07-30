/**
 * @file Long-lived shared layer installed into one platform-owned host runtime.
 *
 * Pair with `ConfiguredHostContextLayer`: this graph lives for the host
 * instance; config/origin-derived Code Mode services live in shorter-lived
 * Contexts owned by `ConfiguredHostContextRunner`.
 *
 * Cloudflare installs it once per Durable Object. Node installs it once per
 * selected local host. Platforms supply storage backends, identity, MCP
 * connector, and sandbox runtime; this layer builds shared stores, the
 * configured-context runner, and the receiver-side `HostInstanceHandler` on top.
 */
import {
  HostSecretStorageBackend,
  HostStateStorageBackend,
  type HostStorageError,
} from "@ptools/config";
import { SandboxRuntime } from "@ptools/executor";
import { HostIdentity } from "@ptools/host-context";
import { McpConnector } from "@ptools/mcp-registry";
import { Layer } from "effect";
import { ConfiguredHostContextRunner } from "../services/configuredHostContextRunner.js";
import { HostInstanceHandler } from "../services/hostInstanceHandler.js";
import {
  HostStableSharedStoresLayer,
  type HostStableSharedStores,
} from "./hostStableSharedStoresLayer.js";

/**
 * Services directly available from the stable `ManagedRuntime`.
 *
 * Provides stable stores, `HostIdentity`, `ConfiguredHostContextRunner`, and
 * `HostInstanceHandler`. Platforms enter the handler through their selected
 * local/RPC carrier. Configured operation services (`CodeModeServer`, auth flow, etc.) are
 * intentionally absent — callers must enter those through
 * `ConfiguredHostContextRunner.run(...)` so cache and invalidation rules cannot
 * be bypassed.
 */
export type HostStableRuntimeServices =
  | HostStableSharedStores
  | HostIdentity
  | ConfiguredHostContextRunner
  | HostInstanceHandler;

/**
 * Shared stable host runtime graph for one host instance.
 *
 * Provides: `HostStableSharedStores`, `HostIdentity`,
 * `ConfiguredHostContextRunner`, and `HostInstanceHandler`.
 *
 * Requires (platform-supplied once per host):
 * - storage ports: `HostStateStorageBackend`, `HostSecretStorageBackend`
 * - host binding: `HostIdentity`
 * - platform behavior ports: `McpConnector`, `SandboxRuntime`
 *
 * `HostIdentity` is re-exposed because configure/configureSecrets and receiver
 * identity checks run against the stable runtime before any configured Context
 * exists. `McpOAuthStateStore` remains stable so OAuth callbacks can verify and
 * consume one-time state before provider completion enters the configured
 * Context. `McpConnector` and `SandboxRuntime` are captured by the runner for
 * configured builds but are not part of the stable caller-facing API.
 */
export interface HostStableRuntimeLayerOptions {
  readonly supportsStdioMcp: boolean;
}

export const HostStableRuntimeLayer = (
  options: HostStableRuntimeLayerOptions,
): Layer.Layer<
  HostStableRuntimeServices,
  HostStorageError,
  | HostStateStorageBackend
  | HostSecretStorageBackend
  | HostIdentity
  | McpConnector
  | SandboxRuntime
> => {
  const stableServices = ConfiguredHostContextRunner.layer.pipe(
    Layer.provideMerge(HostStableSharedStoresLayer),
    // Re-export the platform-owned identity: it is both captured by the runner
    // and part of the stable runtime surface used by the handler and callers.
    Layer.provideMerge(Layer.effect(HostIdentity, HostIdentity)),
  );
  const handler = HostInstanceHandler.layer(options).pipe(
    Layer.provide(stableServices),
  );
  return Layer.mergeAll(stableServices, handler);
};
