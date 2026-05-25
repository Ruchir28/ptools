import { access, readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { Data, Effect } from "effect";

export class ServerConfigError extends Data.TaggedError("ServerConfigError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

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
    }
  | {
      readonly transport: "http";
      readonly url: string;
      readonly headers?: Record<string, string>;
      readonly auth?: HttpMcpAuthConfig;
    };

export interface HttpMcpAuthConfig {
  readonly type: "oauth";
  readonly scope?: string;
  readonly resourceMetadataUrl?: string;
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly clientMetadataUrl?: string;
  readonly redirectUri?: string;
}

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
      readonly auth?: HttpMcpAuthConfig;
    };

export interface LoadPtoolsConfigOptions {
  readonly baseDir?: string;
}

type ConfigEnv = Readonly<Record<string, string | undefined>>;

export const DEFAULT_CONFIG_PATHS = [
  ".ptools/config.json",
  "ptools.config.json",
] as const;

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
): Effect.Effect<string, ServerConfigError> =>
  Effect.gen(function* () {
    const cliPath = yield* parseConfigArg(argv);

    if (cliPath !== undefined) {
      return resolveConfigFilePath(cliPath, cwd);
    }

    const envPath = env.PTOOLS_CONFIG;

    if (envPath !== undefined) {
      if (envPath.trim().length === 0) {
        return yield* Effect.fail(
          new ServerConfigError({
            message: "PTOOLS_CONFIG must not be empty.",
          }),
        );
      }

      return resolveConfigFilePath(envPath, cwd);
    }

    for (const candidate of DEFAULT_CONFIG_PATHS) {
      const candidatePath = resolve(cwd, candidate);
      const exists = yield* fileExists(candidatePath);

      if (exists) {
        return candidatePath;
      }
    }

    return yield* Effect.fail(
      new ServerConfigError({
        message:
          "Missing config file. Pass --config <path>, set PTOOLS_CONFIG, or create .ptools/config.json in the launch directory.",
      }),
    );
  });

/**
 * Loads, parses, validates, and resolves a ptools JSON config file.
 *
 * @param path Absolute or relative config file path.
 * @param env Environment map used to resolve `${env:NAME}` placeholders.
 * @returns Registry-compatible upstream MCP config plus executor options.
 */
export const loadPtoolsConfig = (
  path: string,
  env: ConfigEnv,
  options: LoadPtoolsConfigOptions = {},
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

    return yield* resolvePtoolsConfig(parsed, env, {
      baseDir: options.baseDir ?? dirname(path),
    });
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

    return yield* parsePtoolsConfigValue(value, source);
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
  env: ConfigEnv,
  options: LoadPtoolsConfigOptions = {},
): Effect.Effect<ResolvedPtoolsConfig, ServerConfigError> =>
  Effect.gen(function* () {
    const mcpServers: Record<string, ResolvedMcpConfig> = {};

    for (const [serverName, serverConfig] of Object.entries(
      config.mcpServers,
    )) {
      mcpServers[serverName] =
        serverConfig.transport === "stdio"
          ? yield* resolveStdioConfig(serverName, serverConfig, env, options)
          : yield* resolveHttpConfig(serverName, serverConfig, env);
    }

    return {
      mcpServers,
      ...(config.executor === undefined ? {} : { executor: config.executor }),
    };
  });

const parseConfigArg = (
  argv: ReadonlyArray<string>,
): Effect.Effect<string | undefined, ServerConfigError> => {
  const index = argv.indexOf("--config");

  if (index === -1) {
    return Effect.succeed(undefined);
  }

  const value = argv[index + 1];

  if (value === undefined || value.trim().length === 0) {
    return Effect.fail(
      new ServerConfigError({
        message: "Missing value for --config.",
      }),
    );
  }

  return Effect.succeed(value);
};

const resolveConfigFilePath = (path: string, cwd: string): string =>
  isAbsolute(path) ? path : resolve(cwd, path);

const fileExists = (path: string): Effect.Effect<boolean, never> =>
  Effect.promise(() =>
    access(path)
      .then(() => true)
      .catch(() => false),
  );

const resolveStdioConfig = (
  serverName: string,
  config: Extract<ServerMcpConfig, { readonly transport: "stdio" }>,
  env: ConfigEnv,
  options: LoadPtoolsConfigOptions,
): Effect.Effect<ResolvedMcpConfig, ServerConfigError> =>
  Effect.gen(function* () {
    const command = yield* resolveEnvString(
      serverName,
      "command",
      config.command,
      env,
    );
    const args =
      config.args === undefined
        ? undefined
        : yield* Effect.all(
            config.args.map((arg, index) =>
              resolveEnvString(serverName, `args[${index}]`, arg, env),
            ),
          );
    const cwd =
      config.cwd === undefined
        ? undefined
        : yield* resolveEnvString(serverName, "cwd", config.cwd, env).pipe(
            Effect.map((resolvedCwd) =>
              options.baseDir !== undefined && !isAbsolute(resolvedCwd)
                ? resolve(options.baseDir, resolvedCwd)
                : resolvedCwd,
            ),
          );
    const resolvedEnv =
      config.env === undefined
        ? {}
        : yield* resolveStringRecord(serverName, "env", config.env, env);

    return {
      transport: "stdio" as const,
      command,
      ...(args === undefined ? {} : { args }),
      ...(cwd === undefined ? {} : { cwd }),
      ...(Object.keys(resolvedEnv).length === 0 ? {} : { env: resolvedEnv }),
    };
  });

const resolveHttpConfig = (
  serverName: string,
  config: Extract<ServerMcpConfig, { readonly transport: "http" }>,
  env: ConfigEnv,
): Effect.Effect<ResolvedMcpConfig, ServerConfigError> =>
  Effect.gen(function* () {
    const url = yield* resolveEnvString(serverName, "url", config.url, env);
    const headers =
      config.headers === undefined
        ? {}
        : yield* resolveStringRecord(
            serverName,
            "headers",
            config.headers,
            env,
          );
    const auth =
      config.auth === undefined
        ? undefined
        : yield* resolveHttpAuthConfig(serverName, config.auth, env);

    return {
      transport: "http" as const,
      url,
      ...(Object.keys(headers).length === 0 ? {} : { headers }),
      ...(auth === undefined ? {} : { auth }),
    };
  });

const resolveHttpAuthConfig = (
  serverName: string,
  config: HttpMcpAuthConfig,
  env: ConfigEnv,
): Effect.Effect<HttpMcpAuthConfig, ServerConfigError> =>
  Effect.gen(function* () {
    const scope =
      config.scope === undefined
        ? undefined
        : yield* resolveEnvString(serverName, "auth.scope", config.scope, env);
    const resourceMetadataUrl =
      config.resourceMetadataUrl === undefined
        ? undefined
        : yield* resolveEnvString(
            serverName,
            "auth.resourceMetadataUrl",
            config.resourceMetadataUrl,
            env,
          );
    const clientId =
      config.clientId === undefined
        ? undefined
        : yield* resolveEnvString(
            serverName,
            "auth.clientId",
            config.clientId,
            env,
          );
    const clientSecret =
      config.clientSecret === undefined
        ? undefined
        : yield* resolveEnvString(
            serverName,
            "auth.clientSecret",
            config.clientSecret,
            env,
          );
    const clientMetadataUrl =
      config.clientMetadataUrl === undefined
        ? undefined
        : yield* resolveEnvString(
            serverName,
            "auth.clientMetadataUrl",
            config.clientMetadataUrl,
            env,
          );
    const redirectUri =
      config.redirectUri === undefined
        ? undefined
        : yield* resolveEnvString(
            serverName,
            "auth.redirectUri",
            config.redirectUri,
            env,
          );

    return {
      type: "oauth",
      ...(scope === undefined ? {} : { scope }),
      ...(resourceMetadataUrl === undefined ? {} : { resourceMetadataUrl }),
      ...(clientId === undefined ? {} : { clientId }),
      ...(clientSecret === undefined ? {} : { clientSecret }),
      ...(clientMetadataUrl === undefined ? {} : { clientMetadataUrl }),
      ...(redirectUri === undefined ? {} : { redirectUri }),
    };
  });

const resolveStringRecord = (
  serverName: string,
  fieldName: string,
  record: Readonly<Record<string, string>>,
  env: ConfigEnv,
): Effect.Effect<Record<string, string>, ServerConfigError> =>
  Effect.gen(function* () {
    const result: Record<string, string> = {};

    for (const [key, value] of Object.entries(record)) {
      result[key] = yield* resolveEnvString(
        serverName,
        `${fieldName}.${key}`,
        value,
        env,
      );
    }

    return result;
  });

const ENV_PLACEHOLDER_PATTERN = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g;

const resolveEnvString = (
  serverName: string,
  fieldName: string,
  value: string,
  env: ConfigEnv,
): Effect.Effect<string, ServerConfigError> =>
  Effect.gen(function* () {
    const missing: string[] = [];
    const resolved = value.replace(
      ENV_PLACEHOLDER_PATTERN,
      (_, name: string) => {
        const envValue = env[name];

        if (envValue === undefined) {
          missing.push(name);
          return "";
        }

        return envValue;
      },
    );

    if (missing.length > 0) {
      return yield* Effect.fail(
        new ServerConfigError({
          message: `Missing environment variable ${missing[0]} for ${fieldName} on MCP server ${serverName}`,
        }),
      );
    }

    return resolved;
  });

const parsePtoolsConfigValue = (
  value: unknown,
  source: string,
): Effect.Effect<PtoolsConfig, ServerConfigError> =>
  Effect.gen(function* () {
    const root = yield* expectRecord(
      value,
      `Invalid ptools config in ${source}`,
    );
    const rootKeys = new Set(Object.keys(root));

    for (const key of rootKeys) {
      if (key !== "mcpServers" && key !== "executor") {
        return yield* invalidConfig(
          source,
          `Unsupported top-level field ${key}`,
        );
      }
    }

    const mcpServers = yield* expectRecord(
      root.mcpServers,
      `Invalid ptools config in ${source}: mcpServers must be an object`,
    );
    const executor =
      root.executor === undefined
        ? undefined
        : yield* parseExecutorConfig(root.executor, source);
    const parsedServers: Record<string, ServerMcpConfig> = {};

    for (const [serverName, rawServerConfig] of Object.entries(mcpServers)) {
      const parsed = yield* parseServerConfig(
        serverName,
        rawServerConfig,
        source,
      );

      if (parsed !== undefined) {
        parsedServers[serverName] = parsed;
      }
    }

    return {
      mcpServers: parsedServers,
      ...(executor === undefined ? {} : { executor }),
    };
  });

const parseExecutorConfig = (
  value: unknown,
  source: string,
): Effect.Effect<{ readonly defaultTimeoutMs?: number }, ServerConfigError> =>
  Effect.gen(function* () {
    const executor = yield* expectRecord(
      value,
      `Invalid ptools config in ${source}: executor must be an object`,
    );

    for (const key of Object.keys(executor)) {
      if (key !== "defaultTimeoutMs") {
        return yield* invalidConfig(
          source,
          `Unsupported executor field ${key}`,
        );
      }
    }

    if (
      executor.defaultTimeoutMs !== undefined &&
      typeof executor.defaultTimeoutMs !== "number"
    ) {
      return yield* invalidConfig(
        source,
        "executor.defaultTimeoutMs must be a number",
      );
    }

    return executor.defaultTimeoutMs === undefined
      ? {}
      : { defaultTimeoutMs: executor.defaultTimeoutMs };
  });

const parseServerConfig = (
  serverName: string,
  value: unknown,
  source: string,
): Effect.Effect<ServerMcpConfig | undefined, ServerConfigError> =>
  Effect.gen(function* () {
    const config = yield* expectRecord(
      value,
      `Invalid ptools config in ${source}: mcpServers.${serverName} must be an object`,
    );

    for (const field of Object.keys(config)) {
      const unsupported = unsupportedServerFieldMessage(field);

      if (unsupported !== undefined) {
        return yield* invalidServerConfig(source, serverName, unsupported);
      }
    }

    const enabled = config.enabled;
    const disabled = config.disabled;

    if (enabled !== undefined && typeof enabled !== "boolean") {
      return yield* invalidServerConfig(
        source,
        serverName,
        "enabled must be a boolean when provided",
      );
    }

    if (disabled !== undefined && typeof disabled !== "boolean") {
      return yield* invalidServerConfig(
        source,
        serverName,
        "disabled must be a boolean when provided",
      );
    }

    if (enabled === false || disabled === true) {
      return undefined;
    }

    const hasCommand = config.command !== undefined;
    const hasUrl = config.url !== undefined;

    if (hasCommand && hasUrl) {
      return yield* invalidServerConfig(
        source,
        serverName,
        "must use either command for stdio or url for HTTP, not both",
      );
    }

    if (!hasCommand && !hasUrl) {
      return yield* invalidServerConfig(
        source,
        serverName,
        "must provide command for stdio or url for HTTP",
      );
    }

    return hasCommand
      ? yield* parseStdioServerConfig(serverName, config, source)
      : yield* parseHttpServerConfig(serverName, config, source);
  });

const parseStdioServerConfig = (
  serverName: string,
  config: Readonly<Record<string, unknown>>,
  source: string,
): Effect.Effect<ServerMcpConfig, ServerConfigError> =>
  Effect.gen(function* () {
    const command = yield* expectStringField(
      config.command,
      source,
      serverName,
      "command",
    );
    const args =
      config.args === undefined
        ? undefined
        : yield* expectStringArrayField(
            config.args,
            source,
            serverName,
            "args",
          );
    const cwd =
      config.cwd === undefined
        ? undefined
        : yield* expectStringField(config.cwd, source, serverName, "cwd");
    const env =
      config.env === undefined
        ? undefined
        : yield* expectStringRecordField(config.env, source, serverName, "env");

    return {
      transport: "stdio",
      command,
      ...(args === undefined ? {} : { args }),
      ...(cwd === undefined ? {} : { cwd }),
      ...(env === undefined ? {} : { env }),
    };
  });

const parseHttpServerConfig = (
  serverName: string,
  config: Readonly<Record<string, unknown>>,
  source: string,
): Effect.Effect<ServerMcpConfig, ServerConfigError> =>
  Effect.gen(function* () {
    const url = yield* expectStringField(config.url, source, serverName, "url");
    const headers =
      config.headers === undefined
        ? undefined
        : yield* expectStringRecordField(
            config.headers,
            source,
            serverName,
            "headers",
          );
    const auth =
      config.auth === undefined
        ? undefined
        : yield* parseHttpAuthConfig(serverName, config.auth, source);

    return {
      transport: "http",
      url,
      ...(headers === undefined ? {} : { headers }),
      ...(auth === undefined ? {} : { auth }),
    };
  });

const parseHttpAuthConfig = (
  serverName: string,
  value: unknown,
  source: string,
): Effect.Effect<HttpMcpAuthConfig, ServerConfigError> =>
  Effect.gen(function* () {
    const auth = yield* expectRecord(
      value,
      `Invalid ptools config in ${source}: mcpServers.${serverName}.auth must be an object`,
    );

    for (const key of Object.keys(auth)) {
      if (
        key !== "type" &&
        key !== "scope" &&
        key !== "resourceMetadataUrl" &&
        key !== "clientId" &&
        key !== "clientSecret" &&
        key !== "clientMetadataUrl" &&
        key !== "redirectUri"
      ) {
        return yield* invalidServerConfig(
          source,
          serverName,
          `Unsupported auth field ${key}`,
        );
      }
    }

    if (auth.type !== "oauth") {
      return yield* invalidServerConfig(
        source,
        serverName,
        'auth.type must be "oauth"',
      );
    }

    const scope =
      auth.scope === undefined
        ? undefined
        : yield* expectStringField(
            auth.scope,
            source,
            serverName,
            "auth.scope",
          );
    const resourceMetadataUrl =
      auth.resourceMetadataUrl === undefined
        ? undefined
        : yield* expectStringField(
            auth.resourceMetadataUrl,
            source,
            serverName,
            "auth.resourceMetadataUrl",
          );
    const clientId =
      auth.clientId === undefined
        ? undefined
        : yield* expectStringField(
            auth.clientId,
            source,
            serverName,
            "auth.clientId",
          );
    const clientSecret =
      auth.clientSecret === undefined
        ? undefined
        : yield* expectStringField(
            auth.clientSecret,
            source,
            serverName,
            "auth.clientSecret",
          );
    const clientMetadataUrl =
      auth.clientMetadataUrl === undefined
        ? undefined
        : yield* expectStringField(
            auth.clientMetadataUrl,
            source,
            serverName,
            "auth.clientMetadataUrl",
          );
    const redirectUri =
      auth.redirectUri === undefined
        ? undefined
        : yield* expectStringField(
            auth.redirectUri,
            source,
            serverName,
            "auth.redirectUri",
          );

    return {
      type: "oauth",
      ...(scope === undefined ? {} : { scope }),
      ...(resourceMetadataUrl === undefined ? {} : { resourceMetadataUrl }),
      ...(clientId === undefined ? {} : { clientId }),
      ...(clientSecret === undefined ? {} : { clientSecret }),
      ...(clientMetadataUrl === undefined ? {} : { clientMetadataUrl }),
      ...(redirectUri === undefined ? {} : { redirectUri }),
    };
  });

const unsupportedServerFieldMessage = (field: string): string | undefined => {
  switch (field) {
    case "command":
    case "args":
    case "cwd":
    case "env":
    case "url":
    case "headers":
    case "auth":
    case "enabled":
    case "disabled":
      return undefined;
    case "transport":
    case "type":
      return `${field} is not part of the ptools config shape; use command for stdio servers or url for HTTP servers`;
    case "serverUrl":
      return "serverUrl is not supported; use url for HTTP MCP servers";
    case "envFrom":
      return "envFrom is not supported; use ${env:NAME} placeholders inside env values";
    case "headersFromEnv":
      return "headersFromEnv is not supported; use ${env:NAME} placeholders inside headers values";
    case "tools":
    case "enabled_tools":
    case "disabled_tools":
    case "envFile":
    case "oauth":
    case "authorization":
    case "approvalPolicy":
    case "approval_policy":
      return `${field} is not supported in ptools MCP server config yet`;
    default:
      return `Unsupported MCP server field ${field}`;
  }
};

const expectStringField = (
  value: unknown,
  source: string,
  serverName: string,
  fieldName: string,
): Effect.Effect<string, ServerConfigError> =>
  typeof value === "string"
    ? Effect.succeed(value)
    : invalidServerConfig(source, serverName, `${fieldName} must be a string`);

const expectStringArrayField = (
  value: unknown,
  source: string,
  serverName: string,
  fieldName: string,
): Effect.Effect<ReadonlyArray<string>, ServerConfigError> =>
  Effect.gen(function* () {
    if (!Array.isArray(value)) {
      return yield* invalidServerConfig(
        source,
        serverName,
        `${fieldName} must be an array of strings`,
      );
    }

    for (const [index, item] of value.entries()) {
      if (typeof item !== "string") {
        return yield* invalidServerConfig(
          source,
          serverName,
          `${fieldName}[${index}] must be a string`,
        );
      }
    }

    return value;
  });

const expectStringRecordField = (
  value: unknown,
  source: string,
  serverName: string,
  fieldName: string,
): Effect.Effect<Record<string, string>, ServerConfigError> =>
  Effect.gen(function* () {
    const record = yield* expectRecord(
      value,
      `Invalid ptools config in ${source}: mcpServers.${serverName}.${fieldName} must be an object of strings`,
    );
    const result: Record<string, string> = {};

    for (const [key, item] of Object.entries(record)) {
      if (typeof item !== "string") {
        return yield* invalidServerConfig(
          source,
          serverName,
          `${fieldName}.${key} must be a string`,
        );
      }

      result[key] = item;
    }

    return result;
  });

const expectRecord = (
  value: unknown,
  message: string,
): Effect.Effect<Record<string, unknown>, ServerConfigError> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? Effect.succeed(value as Record<string, unknown>)
    : Effect.fail(new ServerConfigError({ message }));

const invalidConfig = (
  source: string,
  message: string,
): Effect.Effect<never, ServerConfigError> =>
  Effect.fail(
    new ServerConfigError({
      message: `Invalid ptools config in ${source}: ${message}`,
    }),
  );

const invalidServerConfig = (
  source: string,
  serverName: string,
  message: string,
): Effect.Effect<never, ServerConfigError> =>
  invalidConfig(source, `mcpServers.${serverName} ${message}`);
