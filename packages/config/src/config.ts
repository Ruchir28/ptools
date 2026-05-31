import { Context, Data, Effect } from "effect";

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
  readonly resolvePath?: (baseDir: string, path: string) => string;
}

type ConfigEnv = Readonly<Record<string, string | undefined>>;
type SecretLookup = (name: string) => Effect.Effect<string, ServerConfigError>;

export class ConfigSource extends Context.Tag("@ptools/ConfigSource")<
  ConfigSource,
  {
    readonly load: Effect.Effect<ResolvedPtoolsConfig, ServerConfigError>;
  }
>() {}

export class SecretResolver extends Context.Tag("@ptools/SecretResolver")<
  SecretResolver,
  {
    readonly get: (name: string) => Effect.Effect<string, ServerConfigError>;
  }
>() {}

export const DEFAULT_CONFIG_PATHS = [
  ".ptools/config.json",
  "ptools.config.json",
] as const;

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
  resolvePtoolsConfigWithLookup(
    config,
    (name) => {
      const value = env[name];

      return value === undefined
        ? Effect.fail(
            new ServerConfigError({
              message: `Missing environment variable ${name}`,
            }),
          )
        : Effect.succeed(value);
    },
    options,
  );

export const resolvePtoolsConfigWithSecrets = (
  config: PtoolsConfig,
  options: LoadPtoolsConfigOptions = {},
): Effect.Effect<ResolvedPtoolsConfig, ServerConfigError, SecretResolver> =>
  Effect.gen(function* () {
    const secrets = yield* SecretResolver;

    return yield* resolvePtoolsConfigWithLookup(config, secrets.get, options);
  });

const resolvePtoolsConfigWithLookup = (
  config: PtoolsConfig,
  lookupSecret: SecretLookup,
  options: LoadPtoolsConfigOptions,
): Effect.Effect<ResolvedPtoolsConfig, ServerConfigError> =>
  Effect.gen(function* () {
    const mcpServers: Record<string, ResolvedMcpConfig> = {};

    for (const [serverName, serverConfig] of Object.entries(
      config.mcpServers,
    )) {
      mcpServers[serverName] =
        serverConfig.transport === "stdio"
          ? yield* resolveStdioConfig(
              serverName,
              serverConfig,
              lookupSecret,
              options,
            )
          : yield* resolveHttpConfig(serverName, serverConfig, lookupSecret);
    }

    return {
      mcpServers,
      ...(config.executor === undefined ? {} : { executor: config.executor }),
    };
  });

export const hashResolvedMcpConfig = (config: ResolvedMcpConfig): string =>
  stableStringify(config);

export const hashResolvedPtoolsConfig = (
  config: ResolvedPtoolsConfig,
): string => stableStringify(config);

const resolveStdioConfig = (
  serverName: string,
  config: Extract<ServerMcpConfig, { readonly transport: "stdio" }>,
  lookupSecret: SecretLookup,
  options: LoadPtoolsConfigOptions,
): Effect.Effect<ResolvedMcpConfig, ServerConfigError> =>
  Effect.gen(function* () {
    const command = yield* resolveEnvString(
      serverName,
      "command",
      config.command,
      lookupSecret,
    );
    const args =
      config.args === undefined
        ? undefined
        : yield* Effect.all(
            config.args.map((arg, index) =>
              resolveEnvString(
                serverName,
                `args[${index}]`,
                arg,
                lookupSecret,
              ),
            ),
          );
    const cwd =
      config.cwd === undefined
        ? undefined
        : yield* resolveEnvString(
            serverName,
            "cwd",
            config.cwd,
            lookupSecret,
          ).pipe(
            Effect.map((resolvedCwd) =>
              options.baseDir !== undefined && !isAbsolutePath(resolvedCwd)
                ? (options.resolvePath ?? resolveRelativePath)(
                    options.baseDir,
                    resolvedCwd,
                  )
                : resolvedCwd,
            ),
          );
    const resolvedEnv =
      config.env === undefined
        ? {}
        : yield* resolveStringRecord(
            serverName,
            "env",
            config.env,
            lookupSecret,
          );

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
  lookupSecret: SecretLookup,
): Effect.Effect<ResolvedMcpConfig, ServerConfigError> =>
  Effect.gen(function* () {
    const url = yield* resolveEnvString(
      serverName,
      "url",
      config.url,
      lookupSecret,
    );
    const headers =
      config.headers === undefined
        ? {}
        : yield* resolveStringRecord(
            serverName,
            "headers",
            config.headers,
            lookupSecret,
          );
    const auth =
      config.auth === undefined
        ? undefined
        : yield* resolveHttpAuthConfig(serverName, config.auth, lookupSecret);

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
  lookupSecret: SecretLookup,
): Effect.Effect<HttpMcpAuthConfig, ServerConfigError> =>
  Effect.gen(function* () {
    const scope =
      config.scope === undefined
        ? undefined
        : yield* resolveEnvString(
            serverName,
            "auth.scope",
            config.scope,
            lookupSecret,
          );
    const resourceMetadataUrl =
      config.resourceMetadataUrl === undefined
        ? undefined
        : yield* resolveEnvString(
            serverName,
            "auth.resourceMetadataUrl",
            config.resourceMetadataUrl,
            lookupSecret,
          );
    const clientId =
      config.clientId === undefined
        ? undefined
        : yield* resolveEnvString(
            serverName,
            "auth.clientId",
            config.clientId,
            lookupSecret,
          );
    const clientSecret =
      config.clientSecret === undefined
        ? undefined
        : yield* resolveEnvString(
            serverName,
            "auth.clientSecret",
            config.clientSecret,
            lookupSecret,
          );
    const clientMetadataUrl =
      config.clientMetadataUrl === undefined
        ? undefined
        : yield* resolveEnvString(
            serverName,
            "auth.clientMetadataUrl",
            config.clientMetadataUrl,
            lookupSecret,
          );
    const redirectUri =
      config.redirectUri === undefined
        ? undefined
        : yield* resolveEnvString(
            serverName,
            "auth.redirectUri",
            config.redirectUri,
            lookupSecret,
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
  lookupSecret: SecretLookup,
): Effect.Effect<Record<string, string>, ServerConfigError> =>
  Effect.gen(function* () {
    const result: Record<string, string> = {};

    for (const [key, value] of Object.entries(record)) {
      result[key] = yield* resolveEnvString(
        serverName,
        `${fieldName}.${key}`,
        value,
        lookupSecret,
      );
    }

    return result;
  });

const ENV_PLACEHOLDER_PATTERN = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g;

const resolveEnvString = (
  serverName: string,
  fieldName: string,
  value: string,
  lookupSecret: SecretLookup,
): Effect.Effect<string, ServerConfigError> =>
  Effect.gen(function* () {
    let resolved = "";
    let lastIndex = 0;

    for (const match of value.matchAll(ENV_PLACEHOLDER_PATTERN)) {
      const index = match.index;
      const placeholder = match[0];
      const name = match[1];

      if (index === undefined || name === undefined) {
        continue;
      }

      resolved += value.slice(lastIndex, index);
      resolved += yield* lookupSecret(name).pipe(
        Effect.mapError(
          (cause) =>
            new ServerConfigError({
              message: `Missing environment variable ${name} for ${fieldName} on MCP server ${serverName}`,
              cause,
            }),
        ),
      );
      lastIndex = index + placeholder.length;
    }

    return resolved + value.slice(lastIndex);
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

const stableStringify = (value: unknown): string =>
  JSON.stringify(canonicalize(value));

const isAbsolutePath = (path: string): boolean =>
  path.startsWith("/") ||
  /^[A-Za-z]:[\\/]/.test(path) ||
  path.startsWith("\\\\");

const resolveRelativePath = (baseDir: string, path: string): string => {
  const base = baseDir.replace(/[\\/]+$/, "");
  const segments = `${base}/${path}`.split(/[\\/]+/);
  const resolved: string[] = [];
  const root = segments[0] === "" ? "/" : "";

  for (const segment of segments) {
    if (segment === "" || segment === ".") {
      continue;
    }

    if (segment === "..") {
      resolved.pop();
      continue;
    }

    resolved.push(segment);
  }

  return `${root}${resolved.join("/")}`;
};

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};

    for (const key of Object.keys(value).sort()) {
      const item = (value as Record<string, unknown>)[key];

      if (item !== undefined) {
        result[key] = canonicalize(item);
      }
    }

    return result;
  }

  return value;
};
