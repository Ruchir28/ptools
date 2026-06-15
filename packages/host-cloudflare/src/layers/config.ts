import {
  ConfigSource,
  PtoolsConfig,
  resolvePtoolsConfigWithSecrets,
  ServerConfigError,
  SecretResolver,
  type ResolvedPtoolsConfig,
} from "@ptools/config";
import { Effect, Layer, Option, Schema } from "effect";
import {
  CodeModeObjectIdentity,
  CodeModeObjectStorage,
  type CodeModeObjectStorageService,
} from "./platform.js";

export const CODE_MODE_OBJECT_CONFIG_BLOB_KEY = "config/blob";
export const CODE_MODE_OBJECT_SECRET_KEY_PREFIX = "secrets/";

export class StoredConfigBlob extends Schema.Class<StoredConfigBlob>(
  "StoredConfigBlob",
)({
  config: PtoolsConfig,
  updatedAt: Schema.String,
  serverCount: Schema.NonNegativeInt,
}) {
  declare private readonly _storedConfigBlobBrand: void;
}

export const codeModeObjectSecretKey = (name: string): string =>
  `${CODE_MODE_OBJECT_SECRET_KEY_PREFIX}${name}`;

export const DurableObjectSecretResolverLayer: Layer.Layer<
  SecretResolver,
  never,
  CodeModeObjectStorage
> = Layer.effect(
  SecretResolver,
  Effect.gen(function* () {
    const storage = yield* CodeModeObjectStorage;

    return {
      get: (name) =>
        storage.get<string>(codeModeObjectSecretKey(name)).pipe(
          Effect.mapError(
            (cause) =>
              new ServerConfigError({
                message: `Unable to load stored Cloudflare host secret ${name}.`,
                cause,
              }),
          ),
          Effect.flatMap(
            Option.match({
              onNone: () =>
                new ServerConfigError({
                  message: `Missing Cloudflare host secret ${name}`,
                }),
              onSome: Effect.succeed,
            }),
          ),
        ),
    };
  }),
);

export const DurableObjectConfigSourceLayer: Layer.Layer<
  ConfigSource,
  never,
  CodeModeObjectStorage | CodeModeObjectIdentity | SecretResolver
> = Layer.effect(
  ConfigSource,
  Effect.gen(function* () {
    const storage = yield* CodeModeObjectStorage;
    const identity = yield* CodeModeObjectIdentity;
    const secrets = yield* SecretResolver;

    return {
      load: loadConfigBlob(storage, identity.hostId).pipe(
        Effect.provideService(SecretResolver, secrets),
      ),
    };
  }),
);

const loadConfigBlob = (
  storage: CodeModeObjectStorageService,
  hostId: string,
): Effect.Effect<ResolvedPtoolsConfig, ServerConfigError, SecretResolver> =>
  Effect.gen(function* () {
    const storedBlob = yield* storage
      .get<unknown>(CODE_MODE_OBJECT_CONFIG_BLOB_KEY)
      .pipe(
        Effect.mapError(
          (cause) =>
            new ServerConfigError({
              message: `Unable to load stored Cloudflare host ${hostId} config.`,
              cause,
            }),
        ),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              new ServerConfigError({
                message: `Cloudflare host ${hostId} config has not been configured.`,
              }),
            onSome: Effect.succeed,
          }),
        ),
      );

    const blob = yield* Schema.decodeUnknown(StoredConfigBlob)(storedBlob, {
      onExcessProperty: "error",
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ServerConfigError({
            message: `Stored Cloudflare host ${hostId} config is invalid.`,
            cause,
          }),
      ),
    );

    return yield* resolvePtoolsConfigWithSecrets(blob.config);
  });
