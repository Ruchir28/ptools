/**
 * @file Long-lived shared layer installed into one platform-owned host runtime.
 *
 * Pair with `ConfiguredHostContextLayer`: this graph lives for the host
 * instance; config/origin-derived Code Mode services live in shorter-lived
 * Contexts owned by `ConfiguredHostContextRunner`.
 *
 * Cloudflare installs it once per Durable Object. Node installs it once per
 * selected local host. Platforms supply storage backends, identity, MCP
 * connector, and sandbox runtime; this layer builds shared stores and the
 * configured-context runner on top.
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
import {
  HostStableSharedStoresLayer,
  type HostStableSharedStores,
} from "./hostStableSharedStoresLayer.js";

/**
 * Services directly available from the stable `ManagedRuntime`.
 *
 * Provides stable stores, `HostIdentity`, and `ConfiguredHostContextRunner`.
 * Configured operation services (`CodeModeServer`, auth flow, etc.) are
 * intentionally absent — callers must enter those through
 * `ConfiguredHostContextRunner.run(...)` so cache and invalidation rules cannot
 * be bypassed.
 */
export type HostStableRuntimeServices =
  | HostStableSharedStores
  | HostIdentity
  | ConfiguredHostContextRunner;

/**
 * Shared stable host runtime graph for one host instance.
 *
 * Provides: `HostStableSharedStores`, `HostIdentity`, and
 * `ConfiguredHostContextRunner`.
 *
 * Requires (platform-supplied once per host):
 * - storage ports: `HostStateStorageBackend`, `HostSecretStorageBackend`
 * - host binding: `HostIdentity`
 * - platform behavior ports: `McpConnector`, `SandboxRuntime`
 *
 * `HostIdentity` is re-exposed because configure/configureSecrets run against
 * the stable runtime before any configured Context exists. `McpConnector` and
 * `SandboxRuntime` are captured by the runner for configured builds but are not
 * part of the stable caller-facing API.
 */
export const HostStableRuntimeLayer: Layer.Layer<
  HostStableRuntimeServices,
  HostStorageError,
  | HostStateStorageBackend
  | HostSecretStorageBackend
  | HostIdentity
  | McpConnector
  | SandboxRuntime
> = Layer.mergeAll(
  ConfiguredHostContextRunner.Default.pipe(
    Layer.provideMerge(HostStableSharedStoresLayer),
  ),
  Layer.service(HostIdentity),
);
