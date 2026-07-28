#!/usr/bin/env node
import { Command, Options, ValidationError } from "@effect/cli";
import * as NodeContext from "@effect/platform-node/NodeContext";
import { access, readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import {
  collectUserPtoolsConfigEnvReferences,
  DEFAULT_CONFIG_PATHS,
  normalizeUserPtoolsConfigStdioCwds,
  parseUserPtoolsConfigJson,
  type ServerConfigError,
} from "@ptools/config";
import { startEmbeddedNodeHost, NODE_LOCAL_HOST_ID } from "@ptools/host-node";
import { serveMcpWithCodeModeClient } from "@ptools/mcp-server";
import { Cause, Data, Effect, Exit, Option } from "effect";

/** A selected authored config file could not be read from the Node filesystem. */
class ConfigFileReadError extends Data.TaggedError("ConfigFileReadError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** No explicit, environment-selected, or conventional authored config exists. */
class ConfigNotFoundError extends Data.TaggedError("ConfigNotFoundError")<{
  readonly message: string;
}> {}

/** A required `${env:NAME}` value was absent from the CLI process environment. */
class MissingConfigSecretError extends Data.TaggedError(
  "MissingConfigSecretError",
)<{
  readonly message: string;
  readonly name: string;
  readonly configPath: string;
}> {}

/** Starting the embedded Node host or crossing its Host API boundary failed. */
class NodeHostBootstrapError extends Data.TaggedError(
  "NodeHostBootstrapError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const hostOption = Options.choice("host", ["node"] as const).pipe(
  Options.withDefault("node"),
  Options.withDescription(
    "Host implementation to use. Only the embedded local Node host is available today.",
  ),
);

const hostIdOption = Options.text("host-id").pipe(
  Options.withDefault(NODE_LOCAL_HOST_ID),
  Options.withDescription(
    `Logical host identity inside the Node state namespace. Defaults to ${NODE_LOCAL_HOST_ID}.`,
  ),
);

const configOption = Options.text("config").pipe(
  Options.optional,
  Options.withDescription(
    "Authored config file selected and explicitly submitted to the local host.",
  ),
);

const serveCommand = Command.make("serve", {
  host: hostOption,
  hostId: hostIdOption,
  configPath: configOption,
}).pipe(
  Command.withDescription(
    "Serve the combined Code Mode MCP server over stdio.",
  ),
  Command.withHandler(({ configPath, hostId }) =>
    serveLocalNodeMcp(configPath, hostId),
  ),
);

const mcpCommand = Command.make("mcp").pipe(
  Command.withDescription("Run MCP-facing ptools commands."),
  Command.withSubcommands([serveCommand]),
);

const rootCommand = Command.make("ptools").pipe(
  Command.withDescription("MCP-first Code Mode tools."),
  Command.withSubcommands([mcpCommand]),
);

/**
 * Product-owned local bootstrap: decode one authored file, explicitly configure
 * the conventional personal Node host, and expose its Code Mode client on stdio.
 */
const serveLocalNodeMcp = (
  requestedConfigPath: Option.Option<string>,
  hostId: string,
): Effect.Effect<
  void,
  | ConfigFileReadError
  | ConfigNotFoundError
  | MissingConfigSecretError
  | NodeHostBootstrapError
  | ServerConfigError
> =>
  Effect.scoped(
    Effect.gen(function* () {
      const configPath = yield* resolveAuthoredConfigPath(requestedConfigPath);
      const raw = yield* Effect.tryPromise({
        try: () => readFile(configPath, "utf8"),
        catch: (cause) =>
          new ConfigFileReadError({
            message: `Could not read ptools config ${configPath}: ${safeErrorMessage(cause)}`,
            cause,
          }),
      });
      const decoded = yield* parseUserPtoolsConfigJson(raw, configPath);
      const config = normalizeUserPtoolsConfigStdioCwds(decoded, (cwd) =>
        resolve(dirname(configPath), cwd),
      );
      const secrets = yield* collectReferencedSecrets(config, configPath);
      // This starts and owns both the loopback HTTP server and its connected
      // client. Releasing the scope closes the complete embedded host stack.
      const embeddedNodeHost = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () => startEmbeddedNodeHost({ hostId }),
          catch: (cause) =>
            new NodeHostBootstrapError({
              message: safeErrorMessage(cause),
              cause,
            }),
        }),
        (embeddedHost) =>
          Effect.promise(() => embeddedHost.close()).pipe(Effect.ignore),
      );

      yield* callHostAndRequireSuccess(
        () =>
          embeddedNodeHost.call({
            operation: "configure",
            input: { config },
          }),
        "Host configuration operation failed.",
      );
      yield* callHostAndRequireSuccess(
        () =>
          embeddedNodeHost.call({
            operation: "configure_secrets",
            input: { secrets },
          }),
        "Host configure-secrets operation failed.",
      );
      yield* serveMcpWithCodeModeClient(embeddedNodeHost.codeMode);
    }),
  );

/** CLI-owned config selection; host-node never sees paths or discovery inputs. */
const resolveAuthoredConfigPath = (
  explicitPath: Option.Option<string>,
): Effect.Effect<string, ConfigNotFoundError> =>
  Effect.gen(function* () {
    const { cwd, envPath } = yield* Effect.sync(() => ({
      cwd: process.cwd(),
      envPath: nonEmpty(process.env.PTOOLS_CONFIG),
    }));
    const selected = Option.getOrElse(explicitPath, () => envPath);

    if (selected !== undefined) {
      return isAbsolute(selected) ? selected : resolve(cwd, selected);
    }

    for (const candidate of DEFAULT_CONFIG_PATHS) {
      const absolute = resolve(cwd, candidate);
      if (yield* Effect.promise(() => exists(absolute))) return absolute;
    }

    return yield* new ConfigNotFoundError({
      message: `No ptools config found. Pass --config <path> or create ${DEFAULT_CONFIG_PATHS.join(" or ")}.`,
    });
  });

const collectReferencedSecrets = (
  config: Parameters<typeof collectUserPtoolsConfigEnvReferences>[0],
  configPath: string,
): Effect.Effect<Record<string, string>, MissingConfigSecretError> =>
  Effect.gen(function* () {
    const names = collectUserPtoolsConfigEnvReferences(config);
    const env = yield* Effect.sync(() => process.env);
    const entries = yield* Effect.forEach(names, (name) =>
      Effect.fromNullable(env[name]).pipe(
        Effect.mapError(
          () =>
            new MissingConfigSecretError({
              message: `Missing environment variable ${name} referenced by ${configPath}.`,
              name,
              configPath,
            }),
        ),
        Effect.map((value) => [name, value] as const),
      ),
    );

    return Object.fromEntries(entries);
  });

const callHostAndRequireSuccess = (
  call: () => Promise<unknown>,
  fallbackMessage: string,
): Effect.Effect<void, NodeHostBootstrapError> =>
  Effect.tryPromise({
    try: call,
    catch: (cause) =>
      new NodeHostBootstrapError({
        message: safeErrorMessage(cause),
        cause,
      }),
  }).pipe(
    Effect.flatMap((response) =>
      assertHostOperationSucceeded(response, fallbackMessage),
    ),
  );

const assertHostOperationSucceeded = (
  response: unknown,
  fallbackMessage: string,
): Effect.Effect<void, NodeHostBootstrapError> => {
  if (typeof response !== "object" || response === null) {
    return Effect.fail(
      new NodeHostBootstrapError({
        message: "Host returned an invalid configuration response.",
      }),
    );
  }
  if (
    "_tag" in response &&
    response._tag === "HostOperationProtocolFailureResponse"
  ) {
    return Effect.fail(
      new NodeHostBootstrapError({
        message: readResponseErrorMessage(response, fallbackMessage),
      }),
    );
  }
  if (
    !("result" in response) ||
    typeof response.result !== "object" ||
    response.result === null
  ) {
    return Effect.fail(
      new NodeHostBootstrapError({
        message: "Host returned an invalid configuration response.",
      }),
    );
  }
  if ("ok" in response.result && response.result.ok === true) {
    return Effect.void;
  }
  return Effect.fail(
    new NodeHostBootstrapError({
      message: readResponseErrorMessage(response.result, fallbackMessage),
    }),
  );
};

const readResponseErrorMessage = (
  response: object,
  fallbackMessage: string,
): string =>
  "error" in response &&
  typeof response.error === "object" &&
  response.error !== null &&
  "message" in response.error &&
  typeof response.error.message === "string"
    ? response.error.message
    : fallbackMessage;

const safeErrorMessage = (cause: unknown): string => {
  if (
    typeof cause === "object" &&
    cause !== null &&
    "message" in cause &&
    typeof cause.message === "string"
  ) {
    return cause.message;
  }
  if (
    typeof cause === "object" &&
    cause !== null &&
    "_tag" in cause &&
    typeof cause._tag === "string"
  ) {
    return cause._tag;
  }
  return String(cause);
};

const nonEmpty = (value: string | undefined): string | undefined =>
  value === undefined || value.trim() === "" ? undefined : value;

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

const runCli = Command.run(rootCommand, {
  name: "ptools",
  version: "0.1.0-alpha.0",
});

const program = Effect.suspend(() =>
  runCli(process.argv.filter((arg) => arg !== "--")),
).pipe(Effect.provide(NodeContext.layer));

void Effect.runPromiseExit(program).then((exit) => {
  if (Exit.isSuccess(exit)) return;

  const failure = Cause.failureOption(exit.cause);
  if (Option.isSome(failure)) {
    if (!ValidationError.isValidationError(failure.value)) {
      process.stderr.write(`${safeErrorMessage(failure.value)}\n`);
    }
  } else {
    process.stderr.write(`${Cause.pretty(exit.cause)}\n`);
  }
  process.exitCode = 1;
});
