/**
 * Config parsing, normalization, secret resolution, and hashing helpers.
 *
 * This module owns runtime behavior for turning user-authored config into the
 * resolved domain config consumed by hosts. Reusable DTO schemas live in
 * `src/contracts/`; Effect service tags live in `src/services/`.
 */
import { Array as Arr, Effect, Option, Schema } from "effect";
import {
  PtoolsConfig,
  ResolvedExecutorConfig,
  ResolvedHttpMcpAuthConfig,
  ResolvedHttpMcpConfig,
  ResolvedPtoolsConfig,
  ResolvedStdioMcpConfig,
  ServerMcpConfig,
  UserPtoolsConfig,
  type ResolvedMcpConfig,
  type UserServerMcpConfig,
} from "./contracts/index.js";
import type { UnresolvedHttpMcpAuthConfig } from "./contracts/configSchemaFields.js";
import { ServerConfigError } from "./configErrors.js";
import { SecretResolver } from "./services/index.js";

export * from "./contracts/index.js";
export { ServerConfigError } from "./configErrors.js";
export { ConfigSource, SecretResolver } from "./services/index.js";

export interface LoadPtoolsConfigOptions {
  readonly baseDir?: string;
  readonly resolvePath?: (baseDir: string, path: string) => string;
}

type ConfigEnv = Readonly<Record<string, string | undefined>>;
type SecretLookup = (name: string) => Effect.Effect<string, ServerConfigError>;

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
 * @returns Resolved ptools-owned runtime config.
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
    const mcpServerEntries = yield* Effect.forEach(
      Object.entries(config.mcpServers),
      ([serverName, serverConfig]) =>
        (serverConfig.transport === "stdio"
          ? resolveStdioConfig(serverName, serverConfig, lookupSecret, options)
          : resolveHttpConfig(serverName, serverConfig, lookupSecret)
        ).pipe(Effect.map((resolved) => [serverName, resolved] as const)),
    );

    return ResolvedPtoolsConfig.make({
      mcpServers: Object.fromEntries(mcpServerEntries),
      executor: Option.map(config.executor, (executor) =>
        ResolvedExecutorConfig.make({
          defaultTimeoutMs: executor.defaultTimeoutMs,
        }),
      ),
    });
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
    const args = yield* Effect.transposeMapOption(config.args, (args) =>
      Effect.all(
        args.map((arg, index) =>
          resolveEnvString(serverName, `args[${index}]`, arg, lookupSecret),
        ),
      ),
    );
    const cwd = yield* Effect.transposeMapOption(config.cwd, (cwd) =>
      resolveEnvString(serverName, "cwd", cwd, lookupSecret).pipe(
        Effect.map((resolvedCwd) =>
          options.baseDir !== undefined && !isAbsolutePath(resolvedCwd)
            ? (options.resolvePath ?? resolveRelativePath)(
                options.baseDir,
                resolvedCwd,
              )
            : resolvedCwd,
        ),
      ),
    );
    const resolvedEnv = yield* Effect.transposeMapOption(config.env, (env) =>
      resolveStringRecord(serverName, "env", env, lookupSecret),
    );

    return ResolvedStdioMcpConfig.make({
      command,
      args,
      cwd,
      env: resolvedEnv,
    });
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
    const headers = yield* Effect.transposeMapOption(
      config.headers,
      (headers) =>
        resolveStringRecord(serverName, "headers", headers, lookupSecret),
    );
    const auth = yield* Effect.transposeMapOption(config.auth, (auth) =>
      resolveHttpAuthConfig(serverName, auth, lookupSecret),
    );

    return ResolvedHttpMcpConfig.make({
      url,
      headers,
      auth,
    });
  });

const resolveHttpAuthConfig = (
  serverName: string,
  config: UnresolvedHttpMcpAuthConfig,
  lookupSecret: SecretLookup,
): Effect.Effect<ResolvedHttpMcpAuthConfig, ServerConfigError> =>
  Effect.gen(function* () {
    const resolveField = (fieldName: string, value: Option.Option<string>) =>
      Effect.transposeMapOption(value, (value) =>
        resolveEnvString(serverName, fieldName, value, lookupSecret),
      );
    const scope = yield* resolveField("auth.scope", config.scope);
    const resourceMetadataUrl = yield* resolveField(
      "auth.resourceMetadataUrl",
      config.resourceMetadataUrl,
    );
    const clientId = yield* resolveField("auth.clientId", config.clientId);
    const clientSecret = yield* resolveField(
      "auth.clientSecret",
      config.clientSecret,
    );
    const clientMetadataUrl = yield* resolveField(
      "auth.clientMetadataUrl",
      config.clientMetadataUrl,
    );
    const redirectUri = yield* resolveField(
      "auth.redirectUri",
      config.redirectUri,
    );

    return ResolvedHttpMcpAuthConfig.make({
      type: "oauth",
      scope,
      resourceMetadataUrl,
      clientId,
      clientSecret,
      clientMetadataUrl,
      redirectUri,
    });
  });

const resolveStringRecord = (
  serverName: string,
  fieldName: string,
  record: Readonly<Record<string, string>>,
  lookupSecret: SecretLookup,
): Effect.Effect<Record<string, string>, ServerConfigError> =>
  Effect.forEach(Object.entries(record), ([key, value]) =>
    resolveEnvString(
      serverName,
      `${fieldName}.${key}`,
      value,
      lookupSecret,
    ).pipe(Effect.map((resolved) => [key, resolved] as const)),
  ).pipe(Effect.map((entries) => Object.fromEntries(entries)));

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
    const userConfig: UserPtoolsConfig = yield* Schema.decodeUnknown(
      UserPtoolsConfig,
    )(value, {
      errors: "all",
      onExcessProperty: "error",
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ServerConfigError({
            message: `Invalid ptools config in ${source}: ${cause.message}`,
            cause,
          }),
      ),
    );
    const parsedServerEntries = yield* Effect.forEach(
      Object.entries(userConfig.mcpServers),
      ([serverName, serverConfig]) =>
        normalizeServerConfig(serverName, serverConfig, source).pipe(
          Effect.map(
            Option.map((serverConfig) => [serverName, serverConfig] as const),
          ),
        ),
    );
    const parsedServers = Object.fromEntries(Arr.getSomes(parsedServerEntries));

    return PtoolsConfig.make({
      mcpServers: parsedServers,
      executor: userConfig.executor,
    });
  });

const normalizeServerConfig = (
  serverName: string,
  config: UserServerMcpConfig,
  source: string,
): Effect.Effect<Option.Option<ServerMcpConfig>, ServerConfigError> =>
  Effect.gen(function* () {
    if (
      Option.contains(config.enabled, false) ||
      Option.contains(config.disabled, true)
    ) {
      return Option.none();
    }

    const command = config.command;
    const url = config.url;

    if (Option.isSome(command) && Option.isSome(url)) {
      return yield* invalidServerConfig(
        source,
        serverName,
        "must use either command for stdio or url for HTTP, not both",
      );
    }

    if (Option.isSome(command)) {
      return Option.some(normalizeStdioServerConfig(config, command.value));
    }

    if (Option.isSome(url)) {
      return Option.some(normalizeHttpServerConfig(config, url.value));
    }

    return yield* invalidServerConfig(
      source,
      serverName,
      "must provide command for stdio or url for HTTP",
    );
  });

const normalizeStdioServerConfig = (
  config: UserServerMcpConfig,
  command: string,
): ServerMcpConfig => ({
  transport: "stdio",
  command,
  args: config.args,
  cwd: config.cwd,
  env: config.env,
});

const normalizeHttpServerConfig = (
  config: UserServerMcpConfig,
  url: string,
): ServerMcpConfig => ({
  transport: "http",
  url,
  headers: config.headers,
  auth: config.auth,
});

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
