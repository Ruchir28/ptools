/**
 * Effect service for loading runtime-ready config.
 *
 * `ResolvedPtoolsConfigSource` is not the durable config store. It is the
 * runtime-facing loader that returns a fully resolved `ResolvedPtoolsConfig`.
 * The default implementation is the configured-host path:
 *
 * ```txt
 * ConfiguredHostConfigStore.load
 *   reads durable config/blob
 *   returns ConfiguredHostConfigBlob.config as PtoolsConfig
 *   // still unresolved; may contain ${env:NAME}
 *
 * ConfiguredSecretStore.get("NAME")
 *   reads configured secret values
 *
 * ResolvedPtoolsConfigSource.Default
 *   combines the two steps above
 *   returns ResolvedPtoolsConfig for Code Mode / MCP registry runtime use
 * ```
 *
 * Hosts may still override this service for special sources, such as current
 * Node file-backed config discovery. The package-owned default reflects the
 * preferred configured-host runtime shape.
 */
import { Effect } from "effect";
import type { ResolvedPtoolsConfig } from "../contracts/index.js";
import { ServerConfigError } from "../configErrors.js";
import { resolvePtoolsConfigWithSecrets } from "../config.js";
import {
  ConfiguredHostConfigStore,
  type ConfiguredHostConfigStoreError,
} from "./configuredHostConfig.js";
import { ConfiguredSecretStore } from "./configuredSecrets.js";

export interface ResolvedPtoolsConfigSourceService {
  /**
   * Load the runtime-ready ptools config.
   *
   * Returned config has author-time placeholders and host secret references
   * resolved. Runtime consumers should not depend on how the unresolved config
   * was stored or discovered.
   */
  readonly load: Effect.Effect<ResolvedPtoolsConfig, ServerConfigError>;
}

/**
 * Build the configured-host implementation object used by
 * `ResolvedPtoolsConfigSource.Default`.
 */
const makeConfiguredHostResolvedPtoolsConfigSourceService: Effect.Effect<
  ResolvedPtoolsConfigSourceService,
  never,
  ConfiguredHostConfigStore | ConfiguredSecretStore
> = Effect.gen(function* () {
  const configStore = yield* ConfiguredHostConfigStore;
  const secrets = yield* ConfiguredSecretStore;

  return {
    load: configStore.load.pipe(
      Effect.mapError(defaultConfigStoreErrorMapper),
      Effect.flatMap((blob) =>
        resolvePtoolsConfigWithSecrets(blob.config).pipe(
          Effect.provideService(ConfiguredSecretStore, secrets),
        ),
      ),
    ),
  } satisfies ResolvedPtoolsConfigSourceService;
});

/**
 * Runtime-facing resolved config loader.
 *
 * The default implementation is for configured hosts and requires
 * `ConfiguredHostConfigStore` plus `ConfiguredSecretStore`. File-backed or
 * discovery-based hosts may still provide this service with their own layer.
 */
export class ResolvedPtoolsConfigSource extends Effect.Service<ResolvedPtoolsConfigSource>()(
  "@ptools/ResolvedPtoolsConfigSource",
  {
    effect: makeConfiguredHostResolvedPtoolsConfigSourceService,
  },
) {}

const defaultConfigStoreErrorMapper = (
  cause: ConfiguredHostConfigStoreError,
): ServerConfigError =>
  new ServerConfigError({
    message: cause.message,
    cause,
  });
