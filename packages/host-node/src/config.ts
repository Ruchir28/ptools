import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  ResolvedPtoolsConfigSource,
  DEFAULT_CONFIG_PATHS,
  parsePtoolsConfigJson,
  resolvePtoolsConfig,
  ServerConfigError,
  type LoadPtoolsConfigOptions,
  type ResolvedPtoolsConfig,
} from "@ptools/config";
import { Effect, Layer } from "effect";

type NodeConfigEnv = Readonly<Record<string, string | undefined>>;

export const FileResolvedPtoolsConfigSourceLive = (options: {
  readonly path: string;
  readonly baseDir?: string;
  readonly env?: NodeConfigEnv;
}) =>
  Layer.sync(ResolvedPtoolsConfigSource, () =>
    ResolvedPtoolsConfigSource.make({
      load: loadConfigFile(options.path, options.env ?? {}, {
        ...(options.baseDir === undefined ? {} : { baseDir: options.baseDir }),
      }),
    }),
  );

export const NodeResolvedPtoolsConfigSourceLive = (options: {
  readonly argv: ReadonlyArray<string>;
  readonly env: NodeConfigEnv;
  readonly cwd: string;
}) =>
  Layer.sync(ResolvedPtoolsConfigSource, () =>
    ResolvedPtoolsConfigSource.make({
      load: Effect.gen(function* () {
        const path = yield* resolveNodeConfigPath(
          options.argv,
          options.env,
          options.cwd,
        );

        return yield* loadConfigFile(path, options.env);
      }),
    }),
  );

const resolveNodeConfigPath = (
  argv: ReadonlyArray<string>,
  env: NodeConfigEnv,
  cwd: string,
): Effect.Effect<string, ServerConfigError> =>
  Effect.gen(function* () {
    const cliPath = yield* parseConfigArg(argv);

    if (cliPath !== undefined) {
      return yield* resolveConfigFilePath(cliPath, cwd);
    }

    const envPath = env.PTOOLS_CONFIG;

    if (envPath !== undefined) {
      if (envPath.trim().length === 0) {
        return yield* new ServerConfigError({
          message: "PTOOLS_CONFIG must not be empty.",
        });
      }

      return yield* resolveConfigFilePath(envPath, cwd);
    }

    for (const candidate of DEFAULT_CONFIG_PATHS) {
      const candidatePath = resolve(cwd, candidate);
      const exists = yield* fileExists(candidatePath);

      if (exists) {
        return candidatePath;
      }
    }

    return yield* new ServerConfigError({
      message:
        "Missing config file. Pass --config <path>, set PTOOLS_CONFIG, or create .ptools/config.json in the launch directory.",
    });
  });

const loadConfigFile = (
  path: string,
  env: NodeConfigEnv,
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
      resolvePath: (baseDir, relativePath) => resolve(baseDir, relativePath),
    });
  });

const parseConfigArg = (
  argv: ReadonlyArray<string>,
): Effect.Effect<string | undefined, ServerConfigError> => {
  const index = argv.indexOf("--config");

  if (index === -1) {
    return Effect.sync((): string | undefined => undefined);
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

const resolveConfigFilePath = (
  candidate: string,
  cwd: string,
): Effect.Effect<string, ServerConfigError> => {
  if (candidate.trim().length === 0) {
    return Effect.fail(
      new ServerConfigError({
        message: "Config path must not be empty.",
      }),
    );
  }

  return Effect.succeed(resolve(cwd, candidate));
};

const fileExists = (path: string): Effect.Effect<boolean, ServerConfigError> =>
  Effect.tryPromise({
    try: () => access(path).then(() => true, () => false),
    catch: (cause) =>
      new ServerConfigError({
        message: `Unable to inspect config path: ${path}`,
        cause,
      }),
  });
