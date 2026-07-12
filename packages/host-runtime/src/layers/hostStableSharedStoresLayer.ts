/**
 * @file Stable host storage and semantic stores assembled in shared code.
 *
 * Installed through `HostStableRuntimeLayer`, so Effect builds this graph once
 * per stable `ManagedRuntime` (per live host instance — not a process-global
 * singleton).
 *
 * Platforms supply only physical storage backends. Package-owned
 * `HostStateStorage.Default` / `HostSecretStorage.Default` combine those
 * backends with `HostIdentity` so semantic stores own logical keys, schemas,
 * encoding, replacement, nonce, and credential invalidation — never host IDs or
 * platform paths.
 */
import { McpOAuthCredentialStore, McpOAuthStateStore } from "@ptools/auth";
import {
  ConfiguredHostConfigStore,
  ConfiguredSecretStore,
  HostSecretStorage,
  HostSecretStorageBackend,
  HostStateStorage,
  HostStateStorageBackend,
  type HostStorageError,
} from "@ptools/config";
import { HostIdentity } from "@ptools/host-context";
import { Layer } from "effect";

/**
 * Semantic stores that live for the complete stable host lifetime.
 *
 * These are what configured Contexts and configure/configureSecrets workflows
 * read and write. Physical backends stay behind `HostStateStorage` /
 * `HostSecretStorage` and are not part of this surface.
 */
export type HostStableSharedStores =
  | ConfiguredHostConfigStore
  | ConfiguredSecretStore
  | McpOAuthStateStore
  | McpOAuthCredentialStore;

/** Shared final storage construction that enforces identity-based selection. */
const HostStorageLayer = Layer.merge(
  HostStateStorage.Default,
  HostSecretStorage.Default,
);

/**
 * Final host-scoped storage plus all stable semantic stores.
 *
 * Provides: `ConfiguredHostConfigStore`, `ConfiguredSecretStore`,
 * `McpOAuthStateStore`, and `McpOAuthCredentialStore`.
 *
 * Requires (from the platform-owned stable runtime):
 * - `HostIdentity`
 * - `HostStateStorageBackend`, `HostSecretStorageBackend`
 *
 * Platform code supplies only the backend ports. This layer owns the invariant
 * that both final storage services are selected using the shared `HostIdentity`.
 */
export const HostStableSharedStoresLayer: Layer.Layer<
  HostStableSharedStores,
  HostStorageError,
  HostIdentity | HostStateStorageBackend | HostSecretStorageBackend
> = Layer.mergeAll(
  ConfiguredHostConfigStore.Default,
  ConfiguredSecretStore.Default,
  McpOAuthStateStore.Default,
  McpOAuthCredentialStore.Default,
).pipe(Layer.provide(HostStorageLayer));
