import {
  ConfiguredHostConfigStore,
  ConfiguredSecretStore,
  parsePtoolsConfigJson,
  type PtoolsConfig,
} from "@ptools/config";
import { PtoolsSecretValues } from "@ptools/config/contracts";
import { HostIdentity } from "@ptools/host-context";
import { Effect, Option, Schema } from "effect";
import type {
  ConfigureCodeModeObjectError,
  ConfigureCodeModeObjectResult,
  ConfigureCodeModeObjectSecretsResult,
} from "./rpc.js";

const SecretsJson = Schema.parseJson(PtoolsSecretValues);

export const configureCodeModeObject = (input: {
  readonly rawConfigJson: string;
}): Effect.Effect<
  ConfigureCodeModeObjectResult,
  ConfigureCodeModeObjectError,
  ConfiguredHostConfigStore | HostIdentity
> =>
  Effect.gen(function* () {
    const configStore = yield* ConfiguredHostConfigStore;
    const identity = yield* HostIdentity;
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

    const result = yield* configStore
      .replace({ config: parsed })
      .pipe(Effect.mapError(configStorageUnavailable));

    return {
      hostId: identity.hostId,
      serverCount: result.serverCount,
      updatedAt: result.updatedAt,
    };
  });

export const configureCodeModeObjectSecrets = (input: {
  readonly rawSecretsJson: string;
}): Effect.Effect<
  ConfigureCodeModeObjectSecretsResult,
  ConfigureCodeModeObjectError,
  ConfiguredSecretStore | HostIdentity
> =>
  Effect.gen(function* () {
    const configuredSecrets = yield* ConfiguredSecretStore;
    const identity = yield* HostIdentity;
    const secrets = yield* parseSecretsJson(input.rawSecretsJson);
    const result = yield* configuredSecrets
      .replaceAll({ secrets })
      .pipe(Effect.mapError(secretStorageUnavailable));

    return {
      hostId: identity.hostId,
      secretCount: result.secretCount,
      updatedAt: result.updatedAt,
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
