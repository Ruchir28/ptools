/**
 * Shared configured-host config storage protocol.
 *
 * Plain-English meaning of "config store": this is the shared object that knows
 * how a user-authored ptools config is saved after a host is configured and how
 * the runtime loads it later. The platform only supplies an exact-key
 * `HostStateStorage` that is already scoped to one host.
 *
 * Example flow:
 *
 * ```txt
 * Cloudflare route /hosts/demo/configure
 *   parses and validates JSON into PtoolsConfig
 *   calls ConfiguredHostConfigStore.replace({ config })
 *
 * ConfiguredHostConfigStore.Default
 *   writes exact logical key: config/blob
 *   stored JSON: { config, updatedAt, serverCount }
 *
 * Later, the host runtime starts
 *   ResolvedPtoolsConfigSource calls ConfiguredHostConfigStore.load
 *   then resolves `${env:NAME}` placeholders through ConfiguredSecretStore
 * ```
 *
 * The same logical protocol can be reused by Node or Cloudflare because neither
 * platform owns the `config/blob` key, JSON schema, timestamp/server-count
 * metadata, or missing/invalid stored-config errors. Platforms still own request
 * parsing, platform-specific validation, response metadata, physical host
 * scoping, and runtime invalidation.
 */
import { Data, Effect, Option, Schema } from "effect";
import { PtoolsConfig } from "../contracts/index.js";
import { HostStateStorage } from "./hostStorage.js";

/** Exact key for the unresolved configured-host config blob. */
export const CONFIGURED_HOST_CONFIG_BLOB_KEY = "config/blob";

/** Persisted configured-host config blob stored in HostStateStorage. */
export class ConfiguredHostConfigBlob extends Schema.Class<ConfiguredHostConfigBlob>(
  "ConfiguredHostConfigBlob",
)({
  /** User-authored config after schema validation, before secret resolution. */
  config: PtoolsConfig,
  /** Timestamp captured when this blob was stored. */
  updatedAt: Schema.String,
  /** Number of configured MCP servers, returned by host configure APIs. */
  serverCount: Schema.NonNegativeInt,
}) {
  declare private readonly _configuredHostConfigBlobBrand: void;
}

const EncodedConfiguredHostConfigBlob = Schema.parseJson(
  ConfiguredHostConfigBlob,
);

export class ConfiguredHostConfigStoreError extends Data.TaggedError(
  "ConfiguredHostConfigStoreError",
)<{
  readonly reason: "missing" | "invalid" | "storage";
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface ConfiguredHostConfigReplaceResult {
  /** Number of configured MCP servers in the stored config. */
  readonly serverCount: number;
  /** Timestamp captured when the config was stored. */
  readonly updatedAt: string;
}

export interface ConfiguredHostConfigStoreService {
  /**
   * Load the unresolved configured-host config blob.
   *
   * Runtime ResolvedPtoolsConfigSource implementations call this before resolving
   * `${env:NAME}` placeholders through ConfiguredSecretStore. Missing config is
   * a domain error: configured hosts must be explicitly configured before use.
   */
  readonly load: Effect.Effect<
    ConfiguredHostConfigBlob,
    ConfiguredHostConfigStoreError
  >;
  /**
   * Replace the stored unresolved config blob.
   *
   * This is the configure-time write path. The caller supplies a validated
   * PtoolsConfig; this service owns the shared key, persisted schema, encoding,
   * and server-count/update timestamp metadata.
   */
  readonly replace: (input: {
    readonly config: PtoolsConfig;
  }) => Effect.Effect<
    ConfiguredHostConfigReplaceResult,
    ConfiguredHostConfigStoreError
  >;
}

/** Shared configured-host config store backed by host-scoped state storage. */
export class ConfiguredHostConfigStore extends Effect.Service<ConfiguredHostConfigStore>()(
  "@ptools/ConfiguredHostConfigStore",
  {
    effect: Effect.gen(function* () {
      const storage = yield* HostStateStorage;

      return {
        load: storage.get(CONFIGURED_HOST_CONFIG_BLOB_KEY).pipe(
          Effect.mapError(
            (cause) =>
              new ConfiguredHostConfigStoreError({
                reason: "storage",
                message: "Unable to load configured host config.",
                cause,
              }),
          ),
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(
                  new ConfiguredHostConfigStoreError({
                    reason: "missing",
                    message: "Configured host config has not been configured.",
                  }),
                ),
              onSome: Effect.succeed,
            }),
          ),
          Effect.flatMap((storedBlobJson) =>
            Schema.decodeUnknown(EncodedConfiguredHostConfigBlob)(
              storedBlobJson,
              { onExcessProperty: "error" },
            ).pipe(
              Effect.mapError(
                (cause) =>
                  new ConfiguredHostConfigStoreError({
                    reason: "invalid",
                    message: "Stored configured host config is invalid.",
                    cause,
                  }),
              ),
            ),
          ),
        ),
        replace: (input) =>
          Effect.gen(function* () {
            const updatedAt = new Date().toISOString();
            const serverCount = Object.keys(input.config.mcpServers).length;
            const blob = ConfiguredHostConfigBlob.make({
              config: input.config,
              updatedAt,
              serverCount,
            });
            const encodedBlob = yield* Schema.encode(ConfiguredHostConfigBlob)(
              blob,
            ).pipe(
              Effect.mapError(
                (cause) =>
                  new ConfiguredHostConfigStoreError({
                    reason: "invalid",
                    message: "Configured host config is invalid.",
                    cause,
                  }),
              ),
            );

            yield* storage
              .put(CONFIGURED_HOST_CONFIG_BLOB_KEY, JSON.stringify(encodedBlob))
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new ConfiguredHostConfigStoreError({
                      reason: "storage",
                      message: "Unable to store configured host config.",
                      cause,
                    }),
                ),
              );

            return {
              serverCount,
              updatedAt,
            } satisfies ConfiguredHostConfigReplaceResult;
          }),
      } satisfies ConfiguredHostConfigStoreService;
    }),
  },
) {}
