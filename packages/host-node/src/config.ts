import { access, readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import {
  ConfigSource,
  DEFAULT_CONFIG_PATHS,
  parsePtoolsConfigJson,
  resolvePtoolsConfigWithSecrets,
  ServerConfigError,
  SecretResolver,
  type LoadPtoolsConfigOptions,
  type ResolvedPtoolsConfig,
} from "@ptools/config";
import { Context, Effect, Layer } from "effect";

type NodeConfigEnv = Readonly<Record<string, string | undefined>>;
type SecretResolverService = Context.Tag.Service<typeof SecretResolver>;

export const ProcessEnvSecretResolverLive = (options: {
  readonly env: NodeConfigEnv;
}) => Layer.sync(SecretResolver, () => makeProcessEnvSecretResolver(options.env));

export const FileConfigSourceLive = (options: {
  readonly path: string;
  readonly baseDir?: string;
}) =>
  Layer.effect(
    ConfigSource,
    Effect.gen(function* () {
      const secrets = yield* SecretResolver;

      return {
        load: loadConfigFile(options.path, secrets, {
          ...(options.baseDir === undefined
            ? {}
            : { baseDir: options.baseDir }),
        }),
      };
    }),
  );

export const NodeConfigSourceLive = (options: {
  readonly argv: ReadonlyArray<string>;
  readonly env: NodeConfigEnv;
  readonly cwd: string;
}) =>
  Layer.sync(ConfigSource, () => {
    const secrets = makeProcessEnvSecretResolver(options.env);

    return {
      load: Effect.gen(function* () {
        const path = yield* resolveNodeConfigPath(
          options.argv,
          options.env,
          options.cwd,
        );

        return yield* loadConfigFile(path, secrets);
      }),
    };
  });

const makeProcessEnvSecretResolver = (
  env: NodeConfigEnv,
): SecretResolverService => ({
  get: (name) => {
    const value = env[name];

    return value === undefined
      ? Effect.fail(
          new ServerConfigError({
            message: `Missing environment variable ${name}`,
          }),
        )
      : Effect.succeed(value);
  },
});

const resolveNodeConfigPath = (
  argv: ReadonlyArray<string>,
  env: NodeConfigEnv,
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

const loadConfigFile = (
  path: string,
  secrets: SecretResolverService,
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

    return yield* resolvePtoolsConfigWithSecrets(parsed, {
      baseDir: options.baseDir ?? dirname(path),
      resolvePath: (baseDir, relativePath) => resolve(baseDir, relativePath),
    }).pipe(Effect.provideService(SecretResolver, secrets));
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
