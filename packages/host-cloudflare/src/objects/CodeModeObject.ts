import type { CodeModeRequest, CodeModeResponse } from "@ptools/code-mode-api";
import {
  ConfigSource,
  parsePtoolsConfigJson,
  type PtoolsConfig,
  type ResolvedPtoolsConfig,
  type ServerConfigError,
} from "@ptools/config";
import { DurableObject } from "cloudflare:workers";
import { Effect, Layer } from "effect";
import {
  CODE_MODE_OBJECT_CONFIG_BLOB_KEY,
  CODE_MODE_OBJECT_SECRET_KEY_PREFIX,
  DurableObjectConfigSourceLayer,
  DurableObjectSecretResolverLayer,
  codeModeObjectSecretKey,
  type StoredConfigBlob,
} from "../layers/config.js";
import type { PtoolsWorkerEnv } from "../worker/ingress.js";

export interface ConfigureCodeModeObjectInput {
  readonly rawConfigJson: string;
}

export interface ConfigureCodeModeObjectResult {
  readonly hostId: string;
  readonly serverCount: number;
  readonly updatedAt: string;
}

export interface ConfigureCodeModeObjectSecretsInput {
  readonly rawSecretsJson: string;
}

export interface ConfigureCodeModeObjectSecretsResult {
  readonly hostId: string;
  readonly secretCount: number;
  readonly updatedAt: string;
}

export type ConfigureCodeModeObjectResponse =
  | {
      readonly ok: true;
      readonly result: ConfigureCodeModeObjectResult;
    }
  | {
      readonly ok: false;
      readonly error: ConfigureCodeModeObjectError;
    };

export type ConfigureCodeModeObjectSecretsResponse =
  | {
      readonly ok: true;
      readonly result: ConfigureCodeModeObjectSecretsResult;
    }
  | {
      readonly ok: false;
      readonly error: ConfigureCodeModeObjectError;
    };

export interface ConfigureCodeModeObjectError {
  readonly code:
    | "invalid_config"
    | "invalid_secrets"
    | "unsupported_config"
    | "config_storage_unavailable";
  readonly message: string;
}

export class CodeModeObject extends DurableObject<PtoolsWorkerEnv> {
  call(_request: CodeModeRequest): Promise<CodeModeResponse> {
    return Effect.runPromise(
      Effect.die(
        new Error("CodeModeObject runtime is implemented in the next task"),
      ),
    );
  }

  configure(
    input: ConfigureCodeModeObjectInput,
  ): Promise<ConfigureCodeModeObjectResponse> {
    return Effect.runPromise(
      configureCodeModeObject({
        storage: this.ctx.storage,
        hostId: this.hostId,
        rawConfigJson: input.rawConfigJson,
      }).pipe(
        Effect.match({
          onFailure: (error) => ({
            ok: false as const,
            error,
          }),
          onSuccess: (result) => ({
            ok: true as const,
            result,
          }),
        }),
      ),
    );
  }

  configureSecrets(
    input: ConfigureCodeModeObjectSecretsInput,
  ): Promise<ConfigureCodeModeObjectSecretsResponse> {
    return Effect.runPromise(
      configureCodeModeObjectSecrets({
        storage: this.ctx.storage,
        hostId: this.hostId,
        rawSecretsJson: input.rawSecretsJson,
      }).pipe(
        Effect.match({
          onFailure: (error) => ({
            ok: false as const,
            error,
          }),
          onSuccess: (result) => ({
            ok: true as const,
            result,
          }),
        }),
      ),
    );
  }

  protected loadResolvedConfig(): Effect.Effect<
    ResolvedPtoolsConfig,
    ServerConfigError
  > {
    return Effect.gen(function* () {
      const source = yield* ConfigSource;

      return yield* source.load;
    }).pipe(
      Effect.provide(
        Layer.provide(
          DurableObjectConfigSourceLayer({
            storage: this.ctx.storage,
            sourceLabel: `Cloudflare host ${this.hostId} config`,
          }),
          DurableObjectSecretResolverLayer({
            storage: this.ctx.storage,
          }),
        ),
      ),
    );
  }

  private get hostId(): string {
    const hostId = this.ctx.id.name;

    if (hostId === undefined) {
      throw new Error("CodeModeObject must be addressed by name.");
    }

    return hostId;
  }
}

export type CodeModeObjectRpc = Pick<
  CodeModeObject,
  "call" | "configure" | "configureSecrets"
>;

const configureCodeModeObject = (input: {
  readonly storage: DurableObjectStorage;
  readonly hostId: string;
  readonly rawConfigJson: string;
}): Effect.Effect<
  ConfigureCodeModeObjectResult,
  ConfigureCodeModeObjectError
> =>
  Effect.gen(function* () {
    const parsed = yield* parsePtoolsConfigJson(
      input.rawConfigJson,
      `Cloudflare host ${input.hostId} config`,
    ).pipe(
      Effect.mapError(() => ({
        code: "invalid_config" as const,
        message: "Invalid host config",
      })),
    );

    yield* rejectUnsupportedStdioConfig(parsed);

    const updatedAt = new Date().toISOString();
    const serverCount = Object.keys(parsed.mcpServers).length;
    const blob: StoredConfigBlob = {
      rawJson: input.rawConfigJson,
      updatedAt,
      serverCount,
    };

    yield* Effect.tryPromise({
      try: () => input.storage.put(CODE_MODE_OBJECT_CONFIG_BLOB_KEY, blob),
      catch: () => ({
        code: "config_storage_unavailable" as const,
        message: "Cloudflare host config storage is unavailable",
      }),
    });

    return {
      hostId: input.hostId,
      serverCount,
      updatedAt,
    };
  });

const configureCodeModeObjectSecrets = (input: {
  readonly storage: DurableObjectStorage;
  readonly hostId: string;
  readonly rawSecretsJson: string;
}): Effect.Effect<
  ConfigureCodeModeObjectSecretsResult,
  ConfigureCodeModeObjectError
> =>
  Effect.gen(function* () {
    const secrets = yield* parseSecretsJson(input.rawSecretsJson);
    const updatedAt = new Date().toISOString();
    const secretCount = Object.keys(secrets).length;

    const existing = yield* Effect.tryPromise({
      try: () =>
        input.storage.list<string>({
          prefix: CODE_MODE_OBJECT_SECRET_KEY_PREFIX,
        }),
      catch: () => ({
        code: "config_storage_unavailable" as const,
        message: "Cloudflare host secret storage is unavailable",
      }),
    });
    const submittedKeys = new Set(
      Object.keys(secrets).map(codeModeObjectSecretKey),
    );
    const staleKeys = [...existing.keys()].filter(
      (key) => !submittedKeys.has(key),
    );

    yield* Effect.all([
      ...Object.entries(secrets).map(([name, secret]) =>
        Effect.tryPromise({
          try: () => input.storage.put(codeModeObjectSecretKey(name), secret),
          catch: () => ({
            code: "config_storage_unavailable" as const,
            message: "Cloudflare host secret storage is unavailable",
          }),
        }),
      ),
      staleKeys.length === 0
        ? Effect.void
        : Effect.tryPromise({
            try: () => input.storage.delete(staleKeys),
            catch: () => ({
              code: "config_storage_unavailable" as const,
              message: "Cloudflare host secret storage is unavailable",
            }),
          }).pipe(Effect.asVoid),
    ]);

    return {
      hostId: input.hostId,
      secretCount,
      updatedAt,
    };
  });

const parseSecretsJson = (
  rawSecretsJson: string,
): Effect.Effect<Record<string, string>, ConfigureCodeModeObjectError> =>
  Effect.gen(function* () {
    const value = yield* Effect.try({
      try: () => JSON.parse(rawSecretsJson) as unknown,
      catch: () => ({
        code: "invalid_secrets" as const,
        message: "Invalid host secrets",
      }),
    });

    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return yield* Effect.fail({
        code: "invalid_secrets" as const,
        message: "Invalid host secrets",
      });
    }

    const secrets: Record<string, string> = {};

    for (const [name, secret] of Object.entries(value)) {
      if (typeof secret !== "string") {
        return yield* Effect.fail({
          code: "invalid_secrets" as const,
          message: "Invalid host secrets",
        });
      }

      secrets[name] = secret;
    }

    return secrets;
  });

const rejectUnsupportedStdioConfig = (
  config: PtoolsConfig,
): Effect.Effect<void, ConfigureCodeModeObjectError> => {
  const stdioServer = Object.entries(config.mcpServers).find(
    ([, serverConfig]) => serverConfig.transport === "stdio",
  );

  if (stdioServer === undefined) {
    return Effect.void;
  }

  const [serverName] = stdioServer;

  return Effect.fail({
    code: "unsupported_config",
    message: `MCP server "${serverName}" uses stdio, which is not supported by the Cloudflare host first release. Cloudflare stdio MCP over Containers is deferred.`,
  });
};
