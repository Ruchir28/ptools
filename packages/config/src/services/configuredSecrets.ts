/**
 * Shared configured-secret storage protocol for configured hosts.
 *
 * Plain-English meaning of "configured secret store": this is the shared object
 * that knows how submitted secret values are saved and later looked up for
 * `${env:NAME}` placeholders in a stored ptools config. The platform only
 * supplies exact-key `HostStateStorage` / `HostSecretStorage` that are already
 * scoped to one host.
 *
 * Example flow:
 *
 * ```txt
 * Configure secrets request: { "OPENAI_API_KEY": "sk-..." }
 *   platform parses request JSON
 *   calls ConfiguredSecretStore.replaceAll({ secrets })
 *
 * ConfiguredSecretStore.Default
 *   writes secret key: configured-secrets/values/OPENAI_API_KEY
 *   writes non-secret exact index: configured-secrets/index
 *
 * Runtime config resolution sees: ${env:OPENAI_API_KEY}
 *   calls ConfiguredSecretStore.get("OPENAI_API_KEY")
 *   reads the exact secret key above
 * ```
 *
 * The index exists because `HostStateStorage` deliberately cannot scan by
 * prefix. A read of `configured-secrets/values/` would read only that exact key,
 * not child keys. This store therefore owns stale deletion and index publishing
 * so Cloudflare and Node cannot drift on the replacement protocol.
 */
import { Data, Effect, Option, Schema } from "effect";
import { HostSecretStorage, HostStateStorage } from "./hostStorage.js";

/** Prefix for individual configured-secret values stored in HostSecretStorage. */
export const CONFIGURED_SECRET_VALUE_KEY_PREFIX =
  "configured-secrets/values/";

/**
 * Exact key that stores the complete set of configured-secret value keys.
 *
 * Host storage deliberately does not support `list(prefix)` or prefix reads.
 * Reading `configured-secrets/values/` would only ask for that exact key and
 * would not return any children. The index is therefore the only way the shared
 * replace-all protocol can discover stale exact keys to delete.
 */
export const CONFIGURED_SECRET_INDEX_KEY = "configured-secrets/index";

/** Convert a user-authored secret name into the exact logical secret key. */
export const configuredSecretValueKey = (name: string): string =>
  `${CONFIGURED_SECRET_VALUE_KEY_PREFIX}${encodeURIComponent(name)}`;

const ConfiguredSecretIndexJson = Schema.parseJson(Schema.Array(Schema.String));

export class ConfiguredSecretStoreError extends Data.TaggedError(
  "ConfiguredSecretStoreError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface ConfiguredSecretReplaceResult {
  /** Number of submitted secrets in the replacement set. */
  readonly secretCount: number;
  /** Timestamp captured when replacement started, returned to host APIs. */
  readonly updatedAt: string;
}

export interface ConfiguredSecretStoreService {
  /**
   * Read one configured secret by user-authored secret name.
   *
   * Runtime config resolution calls this for `${env:NAME}` placeholders. The
   * caller supplies `NAME`; this service owns how that name maps to a logical
   * host-secret key.
   */
  readonly get: (
    name: string,
  ) => Effect.Effect<string, ConfiguredSecretStoreError>;
  /**
   * Replace the complete configured-secret set in the current host storage.
   *
   * This is the configure-time write path. It treats the submitted map as the
   * full desired set, deletes stale exact keys recorded in the previous index,
   * and publishes a new index after writes/deletes complete.
   */
  readonly replaceAll: (input: {
    readonly secrets: Readonly<Record<string, string>>;
  }) => Effect.Effect<ConfiguredSecretReplaceResult, ConfiguredSecretStoreError>;
}

/**
 * Shared configured-host secret store.
 *
 * The default implementation owns both read and write paths so the configured
 * secret value keys and replacement index cannot drift between platforms.
 * Platforms only provide host-scoped `HostStateStorage` / `HostSecretStorage`;
 * they do not choose configured-secret key names or replacement behavior.
 */
export class ConfiguredSecretStore extends Effect.Service<ConfiguredSecretStore>()(
  "@ptools/ConfiguredSecretStore",
  {
    effect: Effect.gen(function* () {
      const stateStorage = yield* HostStateStorage;
      const secretStorage = yield* HostSecretStorage;

      return {
        get: (name: string) =>
          secretStorage.get(configuredSecretValueKey(name)).pipe(
            Effect.mapError(
              (cause) =>
                new ConfiguredSecretStoreError({
                  message: `Unable to load configured host secret ${name}.`,
                  cause,
                }),
            ),
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.fail(
                    new ConfiguredSecretStoreError({
                      message: `Missing configured host secret ${name}`,
                    }),
                  ),
                onSome: Effect.succeed,
              }),
            ),
          ),
        replaceAll: (input) =>
          Effect.gen(function* () {
            const updatedAt = new Date().toISOString();

            // This is an exact-key read of the published index, not a prefix
            // lookup. HostStateStorage cannot enumerate
            // `configured-secrets/values/*`, so replaceAll persists and reads
            // this non-secret index to know which old secret keys may need
            // deletion when the caller submits a replacement set.
            const existingKeys = yield* stateStorage
              .get(CONFIGURED_SECRET_INDEX_KEY)
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new ConfiguredSecretStoreError({
                      message: "Unable to load configured host secret index.",
                      cause,
                    }),
                ),
                Effect.flatMap(
                  Option.match({
                    onNone: () => Effect.succeed([] as ReadonlyArray<string>),
                    onSome: (rawIndex) =>
                      Schema.decodeUnknown(ConfiguredSecretIndexJson)(rawIndex).pipe(
                        Effect.mapError(
                          (cause) =>
                            new ConfiguredSecretStoreError({
                              message:
                                "Stored configured host secret index is invalid.",
                              cause,
                            }),
                        ),
                      ),
                  }),
                ),
              );
            const submittedEntries = Object.entries(input.secrets).map(
              ([name, secret]) => ({
                key: configuredSecretValueKey(name),
                secret,
              }),
            );
            const submittedKeys = submittedEntries.map((entry) => entry.key);
            const submittedKeySet = new Set(submittedKeys);

            // Stale deletion is computed from the exact keys stored in the last
            // index. No storage backend is asked to scan by prefix; platforms
            // only have to implement get/put/delete for exact logical keys.
            const staleKeys = existingKeys.filter(
              (key) => !submittedKeySet.has(key),
            );

            yield* Effect.all([
              ...submittedEntries.map((entry) =>
                secretStorage.put(entry.key, entry.secret),
              ),
              ...staleKeys.map((key) => secretStorage.delete(key)),
            ]).pipe(
              Effect.mapError(
                (cause) =>
                  new ConfiguredSecretStoreError({
                    message: "Unable to replace configured host secrets.",
                    cause,
                  }),
              ),
            );

            // Publish the replacement index after value writes/deletes. If a
            // later read sees this index, every listed key has already been
            // written for the current replacement set.
            yield* stateStorage
              .put(CONFIGURED_SECRET_INDEX_KEY, JSON.stringify(submittedKeys))
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new ConfiguredSecretStoreError({
                      message:
                        "Unable to publish configured host secret index.",
                      cause,
                    }),
                ),
              );

            return {
              secretCount: submittedEntries.length,
              updatedAt,
            } satisfies ConfiguredSecretReplaceResult;
          }),
      } satisfies ConfiguredSecretStoreService;
    }),
  },
) {}
