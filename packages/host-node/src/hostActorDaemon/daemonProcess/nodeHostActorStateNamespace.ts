/**
 * @file Resolves the stable filesystem and keyring namespace owned by one Node
 * host-actor daemon. This boundary deliberately ignores authored ptools config,
 * argv, project discovery, and the caller's current working directory.
 */
import { homedir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";
import { Data, Effect, Option } from "effect";
import type { NodeHostActorRuntimeOptions } from "../actorRuntime/contracts/nodeHostActorRuntimeOptions.js";

export const DEFAULT_NODE_HOST_KEYRING_SERVICE_NAME = "ptools-host-secrets";

/**
 * Explicit daemon-startup overrides accepted before concrete settings exist.
 * Omission permits Node process defaults; a provided empty/relative critical
 * value is rejected instead of silently falling back.
 */
export interface NodeHostActorStateNamespaceOverrides {
  readonly internalStateDirectory?: string;
  readonly keyringServiceName?: string;
  readonly denoExecutable?: string;
}

/** Invalid daemon state/keyring/sandbox setting detected before activation. */
export class NodeHostActorStateNamespaceError extends Data.TaggedError(
  "NodeHostActorStateNamespaceError",
)<{
  readonly message: string;
}> {}

/**
 * Resolve one daemon's state namespace without consulting authored config.
 *
 * Resolution order for state is explicit directory, non-empty `PTOOLS_HOME`,
 * then `<home>/.ptools/state`. Production passes only `overrides`; the remaining
 * parameters read the real process environment and OS home directory. They are
 * separate injectable values solely so tests can exercise this precedence
 * without mutating `process.env` or mocking `os.homedir()`.
 *
 * This function resolves data only: it creates no directory, keyring entry,
 * Layer, runtime, or daemon process.
 */
export const resolveNodeHostActorRuntimeOptions = (
  overrides: NodeHostActorStateNamespaceOverrides = {},
  environmentVariables: Readonly<
    Record<string, string | undefined>
  > = process.env,
  homeDirectory: string = homedir(),
): Effect.Effect<
  NodeHostActorRuntimeOptions,
  NodeHostActorStateNamespaceError
> =>
  Effect.gen(function* () {
    const internalStateDirectory = yield* resolveInternalStateDirectory(
      overrides.internalStateDirectory,
      environmentVariables,
      homeDirectory,
    );
    const keyringServiceName = yield* resolveKeyringServiceName(
      overrides.keyringServiceName,
    );
    const denoExecutable = yield* Effect.transposeMapOption(
      Option.fromNullable(overrides.denoExecutable),
      validateDenoExecutable,
    );

    return {
      internalStateDirectory,
      keyringServiceName,
      ...Option.match(denoExecutable, {
        onNone: () => ({}),
        onSome: (value) => ({ denoExecutable: value }),
      }),
    };
  });

/**
 * Derive the common physical root below which shared storage selects encoded
 * host IDs. This does not create the directory or append logical storage keys.
 */
export const nodeHostStateRootDirectory = (
  options: NodeHostActorRuntimeOptions,
): string => join(options.internalStateDirectory, "hosts");

const resolveInternalStateDirectory = (
  explicit: string | undefined,
  environmentVariables: Readonly<Record<string, string | undefined>>,
  homeDirectory: string,
): Effect.Effect<string, NodeHostActorStateNamespaceError> => {
  if (explicit !== undefined) {
    return validateAbsoluteDirectory("internalStateDirectory", explicit);
  }

  const ptoolsHome = environmentVariables.PTOOLS_HOME;
  if (ptoolsHome !== undefined && ptoolsHome.trim().length > 0) {
    return validateAbsoluteDirectory("PTOOLS_HOME", ptoolsHome).pipe(
      Effect.map((directory) => join(directory, "state")),
    );
  }

  return validateAbsoluteDirectory("homeDirectory", homeDirectory).pipe(
    Effect.map((directory) => join(directory, ".ptools", "state")),
  );
};

const validateAbsoluteDirectory = (
  settingName: string,
  value: string,
): Effect.Effect<string, NodeHostActorStateNamespaceError> => {
  if (value.trim().length === 0) {
    return Effect.fail(
      new NodeHostActorStateNamespaceError({
        message: `${settingName} must not be empty.`,
      }),
    );
  }
  if (!isAbsolute(value)) {
    return Effect.fail(
      new NodeHostActorStateNamespaceError({
        message: `${settingName} must be an absolute path.`,
      }),
    );
  }
  return Effect.succeed(normalize(value));
};

const resolveKeyringServiceName = (
  value: string | undefined,
): Effect.Effect<string, NodeHostActorStateNamespaceError> => {
  if (value === undefined)
    return Effect.succeed(DEFAULT_NODE_HOST_KEYRING_SERVICE_NAME);
  if (value.trim().length > 0) return Effect.succeed(value);
  return Effect.fail(
    new NodeHostActorStateNamespaceError({
      message: "keyringServiceName must not be empty.",
    }),
  );
};

const validateDenoExecutable = (
  value: string,
): Effect.Effect<string, NodeHostActorStateNamespaceError> =>
  value.trim().length > 0
    ? Effect.succeed(value)
    : Effect.fail(
        new NodeHostActorStateNamespaceError({
          message: "denoExecutable must not be empty when provided.",
        }),
      );
