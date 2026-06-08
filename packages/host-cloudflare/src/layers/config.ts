import {
  ConfigSource,
  parsePtoolsConfigJson,
  resolvePtoolsConfigWithSecrets,
  ServerConfigError,
  SecretResolver,
  type ResolvedPtoolsConfig,
} from "@ptools/config";
import { Effect, Layer } from "effect";

export const CODE_MODE_OBJECT_CONFIG_BLOB_KEY = "config/blob";
export const CODE_MODE_OBJECT_SECRET_KEY_PREFIX = "secrets/";

export interface StoredConfigBlob {
  readonly rawJson: string;
  readonly updatedAt: string;
  readonly serverCount: number;
}

export const codeModeObjectSecretKey = (name: string): string =>
  `${CODE_MODE_OBJECT_SECRET_KEY_PREFIX}${name}`;

export const DurableObjectSecretResolverLayer = (options: {
  readonly storage: DurableObjectStorage;
}) =>
  Layer.sync(SecretResolver, () => ({
    get: (name) =>
      Effect.gen(function* () {
        const blob = yield* Effect.tryPromise({
          try: () => options.storage.get<string>(codeModeObjectSecretKey(name)),
          catch: (cause) =>
            new ServerConfigError({
              message: `Unable to load stored Cloudflare host secret ${name}.`,
              cause,
            }),
        });

        return blob === undefined
          ? yield* Effect.fail(
              new ServerConfigError({
                message: `Missing Cloudflare host secret ${name}`,
              }),
            )
          : blob;
      }),
  }));

export const DurableObjectConfigSourceLayer = (options: {
  readonly storage: DurableObjectStorage;
  readonly sourceLabel?: string;
}) =>
  Layer.effect(
    ConfigSource,
    Effect.gen(function* () {
      const secrets = yield* SecretResolver;

      return {
        load: loadConfigBlob(options.storage, {
          ...(options.sourceLabel === undefined
            ? {}
            : { sourceLabel: options.sourceLabel }),
        }).pipe(Effect.provideService(SecretResolver, secrets)),
      };
    }),
  );

const loadConfigBlob = (
  storage: DurableObjectStorage,
  options: {
    readonly sourceLabel?: string;
  },
): Effect.Effect<ResolvedPtoolsConfig, ServerConfigError, SecretResolver> =>
  Effect.gen(function* () {
    const blob = yield* Effect.tryPromise({
      try: () =>
        storage.get<StoredConfigBlob>(CODE_MODE_OBJECT_CONFIG_BLOB_KEY),
      catch: (cause) =>
        new ServerConfigError({
          message: "Unable to load stored Cloudflare host config.",
          cause,
        }),
    });

    if (blob === undefined) {
      return yield* Effect.fail(
        new ServerConfigError({
          message: "Cloudflare host config has not been configured.",
        }),
      );
    }

    const parsed = yield* parsePtoolsConfigJson(
      blob.rawJson,
      options.sourceLabel ?? "Cloudflare host config",
    );

    return yield* resolvePtoolsConfigWithSecrets(parsed);
  });
