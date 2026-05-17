import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { Data, Effect, ParseResult, Schema } from "effect";

export class ServerConfigError extends Data.TaggedError(
  "ServerConfigError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const StringRecordSchema = Schema.Record({
  key: Schema.String,
  value: Schema.String,
});

const StdioMcpConfigSchema = Schema.Struct({
  transport: Schema.Literal("stdio"),
  command: Schema.String,
  args: Schema.optional(Schema.Array(Schema.String)),
  cwd: Schema.optional(Schema.String),
  env: Schema.optional(StringRecordSchema),
  envFrom: Schema.optional(StringRecordSchema),
});

const HttpMcpConfigSchema = Schema.Struct({
  transport: Schema.Literal("http"),
  url: Schema.String,
  headers: Schema.optional(StringRecordSchema),
  headersFromEnv: Schema.optional(StringRecordSchema),
});

const ServerMcpConfigSchema = Schema.Union(
  StdioMcpConfigSchema,
  HttpMcpConfigSchema,
);

const PtoolsConfigSchema = Schema.Struct({
  mcpServers: Schema.Record({
    key: Schema.String,
    value: ServerMcpConfigSchema,
  }),
  executor: Schema.optional(
    Schema.Struct({
      defaultTimeoutMs: Schema.optional(Schema.Number),
    }),
  ),
});

type DecodedPtoolsConfig = Schema.Schema.Type<typeof PtoolsConfigSchema>;

export interface PtoolsConfig {
  readonly mcpServers: Readonly<Record<string, ServerMcpConfig>>;
  readonly executor?: {
    readonly defaultTimeoutMs?: number;
  };
}

export type ServerMcpConfig =
  | {
      readonly transport: "stdio";
      readonly command: string;
      readonly args?: ReadonlyArray<string>;
      readonly cwd?: string;
      readonly env?: Record<string, string>;
      readonly envFrom?: Record<string, string>;
    }
  | {
      readonly transport: "http";
      readonly url: string;
      readonly headers?: Record<string, string>;
      readonly headersFromEnv?: Record<string, string>;
    };

export interface ResolvedPtoolsConfig {
  readonly mcpServers: ResolvedMcpServers;
  readonly executor?: {
    readonly defaultTimeoutMs?: number;
  };
}

export type ResolvedMcpServers = Readonly<Record<string, ResolvedMcpConfig>>;

export type ResolvedMcpConfig =
  | {
      readonly transport: "stdio";
      readonly command: string;
      readonly args?: ReadonlyArray<string>;
      readonly env?: Record<string, string>;
      readonly cwd?: string;
    }
  | {
      readonly transport: "http";
      readonly url: string;
      readonly headers?: Record<string, string>;
    };

/**
 * Parses CLI/env config path inputs into an absolute config file path.
 *
 * @param argv Command-line args after the executable and script path.
 * @param env Environment map used for the `PTOOLS_CONFIG` fallback.
 * @param cwd Directory used to resolve relative config paths.
 * @returns An absolute config file path.
 */
export const resolveConfigPath = (
  argv: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
  cwd: string,
): Effect.Effect<string, ServerConfigError> => {
  const cliPath = parseConfigArg(argv);
  const configPath = cliPath ?? env.PTOOLS_CONFIG;

  if (configPath === undefined || configPath.trim().length === 0) {
    return Effect.fail(
      new ServerConfigError({
        message: "Missing config path. Pass --config <path> or set PTOOLS_CONFIG.",
      }),
    );
  }

  return Effect.succeed(
    isAbsolute(configPath) ? configPath : resolve(cwd, configPath),
  );
};

/**
 * Loads, parses, validates, and resolves a ptools JSON config file.
 *
 * @param path Absolute or relative config file path.
 * @param env Environment map used to resolve `envFrom` and `headersFromEnv`.
 * @returns Registry-compatible upstream MCP config plus executor options.
 */
export const loadPtoolsConfig = (
  path: string,
  env: NodeJS.ProcessEnv,
): Effect.Effect<ResolvedPtoolsConfig, ServerConfigError> =>
  Effect.gen(function* () {
    const raw = yield* Effect.tryPromise({
      try: () => readFile(path, "utf8"),
      catch: (cause) =>
        new ServerConfigError({
          message: `Unable to read config file: ${path}`,
          cause,
        }),
    });

    const parsed = yield* parsePtoolsConfigJson(raw, path);

    return yield* resolvePtoolsConfig(parsed, env);
  });

/**
 * Parses and validates a raw JSON config string.
 *
 * @param raw JSON source.
 * @param source Label used in validation errors.
 * @returns The server-owned config shape before environment references resolve.
 */
export const parsePtoolsConfigJson = (
  raw: string,
  source = "ptools config",
): Effect.Effect<PtoolsConfig, ServerConfigError> =>
  Effect.gen(function* () {
    const value = yield* Effect.try({
      try: () => JSON.parse(raw) as unknown,
      catch: (cause) =>
        new ServerConfigError({
          message: `Invalid JSON in ${source}`,
          cause,
        }),
    });

    const decoded = yield* Schema.decodeUnknown(PtoolsConfigSchema)(value).pipe(
      Effect.mapError(
        (cause) =>
          new ServerConfigError({
            message: `Invalid ptools config in ${source}: ${ParseResult.TreeFormatter.formatErrorSync(cause)}`,
            cause,
          }),
      ),
    );

    return normalizeDecodedConfig(decoded);
  });

/**
 * Resolves literal config plus env references into registry-compatible config.
 *
 * @param config Server-owned ptools config.
 * @param env Environment map used as the source for explicit env refs.
 * @returns Config that can be passed directly to `makeMcpRegistryLive`.
 */
export const resolvePtoolsConfig = (
  config: PtoolsConfig,
  env: NodeJS.ProcessEnv,
): Effect.Effect<ResolvedPtoolsConfig, ServerConfigError> =>
  Effect.gen(function* () {
    const mcpServers: Record<string, ResolvedMcpConfig> = {};

    for (const [serverName, serverConfig] of Object.entries(config.mcpServers)) {
      mcpServers[serverName] =
        serverConfig.transport === "stdio"
          ? yield* resolveStdioConfig(serverName, serverConfig, env)
          : yield* resolveHttpConfig(serverName, serverConfig, env);
    }

    return {
      mcpServers,
      ...(config.executor === undefined ? {} : { executor: config.executor }),
    };
  });

const parseConfigArg = (argv: ReadonlyArray<string>): string | undefined => {
  const index = argv.indexOf("--config");

  if (index === -1) {
    return undefined;
  }

  return argv[index + 1];
};

const resolveStdioConfig = (
  serverName: string,
  config: Extract<ServerMcpConfig, { readonly transport: "stdio" }>,
  env: NodeJS.ProcessEnv,
): Effect.Effect<ResolvedMcpConfig, ServerConfigError> =>
  Effect.gen(function* () {
    const resolvedEnv = yield* resolveEnvRecord(
      serverName,
      "envFrom",
      config.env ?? {},
      config.envFrom ?? {},
      env,
    );

    return {
      transport: "stdio" as const,
      command: config.command,
      ...(config.args === undefined ? {} : { args: [...config.args] }),
      ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
      ...(Object.keys(resolvedEnv).length === 0 ? {} : { env: resolvedEnv }),
    };
  });

const resolveHttpConfig = (
  serverName: string,
  config: Extract<ServerMcpConfig, { readonly transport: "http" }>,
  env: NodeJS.ProcessEnv,
): Effect.Effect<ResolvedMcpConfig, ServerConfigError> =>
  Effect.gen(function* () {
    const headers = yield* resolveEnvRecord(
      serverName,
      "headersFromEnv",
      config.headers ?? {},
      config.headersFromEnv ?? {},
      env,
    );

    return {
      transport: "http" as const,
      url: config.url,
      ...(Object.keys(headers).length === 0 ? {} : { headers }),
    };
  });

const resolveEnvRecord = (
  serverName: string,
  fieldName: string,
  literal: Readonly<Record<string, string>>,
  refs: Readonly<Record<string, string>>,
  env: NodeJS.ProcessEnv,
): Effect.Effect<Record<string, string>, ServerConfigError> =>
  Effect.gen(function* () {
    const result: Record<string, string> = { ...literal };

    for (const [targetKey, sourceKey] of Object.entries(refs)) {
      const value = env[sourceKey];

      if (value === undefined) {
        return yield* Effect.fail(
          new ServerConfigError({
            message: `Missing environment variable ${sourceKey} for ${fieldName}.${targetKey} on MCP server ${serverName}`,
          }),
        );
      }

      result[targetKey] = value;
    }

    return result;
  });

const normalizeDecodedConfig = (
  decoded: DecodedPtoolsConfig,
): PtoolsConfig => {
  const mcpServers: Record<string, ServerMcpConfig> = {};

  for (const [serverName, serverConfig] of Object.entries(decoded.mcpServers)) {
    mcpServers[serverName] =
      serverConfig.transport === "stdio"
        ? {
            transport: "stdio",
            command: serverConfig.command,
            ...(serverConfig.args === undefined
              ? {}
              : { args: serverConfig.args }),
            ...(serverConfig.cwd === undefined ? {} : { cwd: serverConfig.cwd }),
            ...(serverConfig.env === undefined ? {} : { env: serverConfig.env }),
            ...(serverConfig.envFrom === undefined
              ? {}
              : { envFrom: serverConfig.envFrom }),
          }
        : {
            transport: "http",
            url: serverConfig.url,
            ...(serverConfig.headers === undefined
              ? {}
              : { headers: serverConfig.headers }),
            ...(serverConfig.headersFromEnv === undefined
              ? {}
              : { headersFromEnv: serverConfig.headersFromEnv }),
          };
  }

  return {
    mcpServers,
    ...(decoded.executor === undefined
      ? {}
      : {
          executor: {
            ...(decoded.executor.defaultTimeoutMs === undefined
              ? {}
              : { defaultTimeoutMs: decoded.executor.defaultTimeoutMs }),
          },
        }),
  };
};
