import { parsePtoolsConfigJson, type PtoolsConfig } from "@ptools/config";
import { Array as EffectArray, Effect, Option, Schema } from "effect";
import {
  CODE_MODE_OBJECT_CONFIG_BLOB_KEY,
  CODE_MODE_OBJECT_SECRET_KEY_PREFIX,
  CodeModeObjectIdentity,
  CodeModeObjectStorage,
  StoredConfigBlob,
  codeModeObjectSecretKey,
} from "../../layers/index.js";
import type {
  ConfigureCodeModeObjectError,
  ConfigureCodeModeObjectResult,
  ConfigureCodeModeObjectSecretsResult,
} from "./rpc.js";

const SecretsJson = Schema.parseJson(
  Schema.Record({ key: Schema.String, value: Schema.String }),
);

export const configureCodeModeObject = (input: {
  readonly rawConfigJson: string;
}): Effect.Effect<
  ConfigureCodeModeObjectResult,
  ConfigureCodeModeObjectError,
  CodeModeObjectStorage | CodeModeObjectIdentity
> =>
  Effect.gen(function* () {
    const storage = yield* CodeModeObjectStorage;
    const identity = yield* CodeModeObjectIdentity;
    const parsed = yield* parsePtoolsConfigJson(
      input.rawConfigJson,
      `Cloudflare host ${identity.hostId} config`,
    ).pipe(
      Effect.mapError(() => ({
        code: "invalid_config" as const,
        message: "Invalid host config",
      })),
    );

    yield* rejectUnsupportedStdioConfig(parsed);

    const updatedAt = new Date().toISOString();
    const serverCount = Object.keys(parsed.mcpServers).length;
    const blob = StoredConfigBlob.make({
      config: parsed,
      updatedAt,
      serverCount,
    });
    const encodedBlob = yield* Schema.encode(StoredConfigBlob)(blob).pipe(
      Effect.mapError(() => ({
        code: "invalid_config" as const,
        message: "Invalid host config",
      })),
    );

    yield* storage
      .put(CODE_MODE_OBJECT_CONFIG_BLOB_KEY, encodedBlob)
      .pipe(Effect.mapError(configStorageUnavailable));

    return {
      hostId: identity.hostId,
      serverCount,
      updatedAt,
    };
  });

export const configureCodeModeObjectSecrets = (input: {
  readonly rawSecretsJson: string;
}): Effect.Effect<
  ConfigureCodeModeObjectSecretsResult,
  ConfigureCodeModeObjectError,
  CodeModeObjectStorage | CodeModeObjectIdentity
> =>
  Effect.gen(function* () {
    const storage = yield* CodeModeObjectStorage;
    const identity = yield* CodeModeObjectIdentity;
    const secrets = yield* parseSecretsJson(input.rawSecretsJson);
    const updatedAt = new Date().toISOString();
    const secretCount = Object.keys(secrets).length;

    const existing = yield* storage
      .list<string>({
        prefix: CODE_MODE_OBJECT_SECRET_KEY_PREFIX,
      })
      .pipe(Effect.mapError(secretStorageUnavailable));
    const submittedKeys = new Set(
      Object.keys(secrets).map(codeModeObjectSecretKey),
    );
    const staleKeys = [...existing.keys()].filter(
      (key) => !submittedKeys.has(key),
    );

    yield* Effect.all([
      ...Object.entries(secrets).map(([name, secret]) =>
        storage
          .put(codeModeObjectSecretKey(name), secret)
          .pipe(Effect.mapError(secretStorageUnavailable)),
      ),
      EffectArray.match(staleKeys, {
        onEmpty: () => Effect.void,
        onNonEmpty: (keys) =>
          storage
            .delete(keys)
            .pipe(Effect.mapError(secretStorageUnavailable), Effect.asVoid),
      }),
    ]);

    return {
      hostId: identity.hostId,
      secretCount,
      updatedAt,
    };
  });

const parseSecretsJson = (
  rawSecretsJson: string,
): Effect.Effect<Record<string, string>, ConfigureCodeModeObjectError> =>
  Schema.decodeUnknown(SecretsJson)(rawSecretsJson, {
    errors: "all",
    onExcessProperty: "error",
  }).pipe(
    Effect.mapError(() => ({
      code: "invalid_secrets" as const,
      message: "Invalid host secrets",
    })),
  );

const rejectUnsupportedStdioConfig = (
  config: PtoolsConfig,
): Effect.Effect<void, ConfigureCodeModeObjectError> =>
  Option.fromNullable(
    Object.entries(config.mcpServers).find(
      ([, serverConfig]) => serverConfig.transport === "stdio",
    ),
  ).pipe(
    Option.match({
      onNone: () => Effect.void,
      onSome: ([serverName]) =>
        Effect.fail({
          code: "unsupported_config",
          message: `MCP server "${serverName}" uses stdio, which is not supported by the Cloudflare host first release. Cloudflare stdio MCP over Containers is deferred.`,
        }),
    }),
  );

const configStorageUnavailable = (): ConfigureCodeModeObjectError => ({
  code: "config_storage_unavailable",
  message: "Cloudflare host config storage is unavailable",
});

const secretStorageUnavailable = (): ConfigureCodeModeObjectError => ({
  code: "config_storage_unavailable",
  message: "Cloudflare host secret storage is unavailable",
});
