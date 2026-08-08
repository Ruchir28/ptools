#!/usr/bin/env node
import { Argument, CliError, Command, Flag } from "effect/unstable/cli";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { access, readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import {
  collectUserPtoolsConfigEnvReferences,
  DEFAULT_CONFIG_PATHS,
  normalizeUserPtoolsConfigStdioCwds,
  parseUserPtoolsConfigJson,
  type ServerConfigError,
} from "@ptools/config";
import {
  assertNodeDeploymentStateQuiescent,
  configureNodeLocalDeployment,
  createNodeLocalDeployment,
  DEFAULT_NODE_DEPLOYMENT_NAME,
  listNodeLocalDeployments,
  NodeDeploymentName,
  NODE_LOCAL_HOST_ID,
  connectLocalNodeHost,
  startNodeLocalDeployment,
} from "@ptools/host-node";
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

/** Starting a local Node deployment or crossing its Host API boundary failed. */
class NodeHostBootstrapError extends Data.TaggedError(
  "NodeHostBootstrapError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const hostOption = Flag.choice("host", ["node"] as const).pipe(
  Flag.withDefault("node"),
  Flag.withDescription(
    "Host implementation to use. The local Node deployment must already be running.",
  ),
);

const hostIdOption = Flag.string("host-id").pipe(
  Flag.withDefault(NODE_LOCAL_HOST_ID),
  Flag.withDescription(
    `Logical host identity inside the Node state namespace. Defaults to ${NODE_LOCAL_HOST_ID}.`,
  ),
);

const deploymentOption = Flag.string("deployment").pipe(
  Flag.withDefault(DEFAULT_NODE_DEPLOYMENT_NAME),
  Flag.withDescription("Named running local Node deployment to connect to."),
);

const configOption = Flag.string("config").pipe(
  Flag.optional,
  Flag.withDescription(
    "Authored config file selected and explicitly submitted to the local host.",
  ),
);

const serveCommand = Command.make("serve", {
  host: hostOption,
  hostId: hostIdOption,
  configPath: configOption,
  deployment: deploymentOption,
}).pipe(
  Command.withDescription(
    "Serve the combined Code Mode MCP server over stdio.",
  ),
  Command.withHandler(({ configPath, deployment, hostId }) =>
    serveLocalNodeMcp(configPath, hostId, deployment),
  ),
);

const mcpCommand = Command.make("mcp").pipe(
  Command.withDescription("Run MCP-facing ptools commands."),
  Command.withSubcommands([serveCommand]),
);

const deploymentNameArgument = Argument.string("name");
const deploymentPortFlag = Flag.integer("port").pipe(Flag.optional);
const requiredDeploymentPortFlag = Flag.integer("port");
const stateDirectoryFlag = Flag.string("state-directory").pipe(Flag.optional);
const denoExecutableFlag = Flag.string("deno-executable").pipe(Flag.optional);
const useDefaultDenoFlag = Flag.boolean("use-default-deno");

const createDeploymentCommand = Command.make("create", {
  name: deploymentNameArgument,
  port: requiredDeploymentPortFlag,
  stateDirectory: stateDirectoryFlag,
  denoExecutable: denoExecutableFlag,
}).pipe(
  Command.withHandler(({ name, port, stateDirectory, denoExecutable }) =>
    createNodeLocalDeployment({
      name,
      port,
      ...Option.match(stateDirectory, {
        onNone: () => ({}),
        onSome: (value) => ({ stateDirectory: value }),
      }),
      ...Option.match(denoExecutable, {
        onNone: () => ({}),
        onSome: (value) => ({ denoExecutable: value }),
      }),
    }).pipe(
      Effect.tap((descriptor) => printJson(descriptor)),
      Effect.asVoid,
    ),
  ),
);

const configureDeploymentCommand = Command.make("configure", {
  name: deploymentNameArgument,
  port: deploymentPortFlag,
  denoExecutable: denoExecutableFlag,
  useDefaultDeno: useDefaultDenoFlag,
}).pipe(
  Command.withHandler(({ name, port, denoExecutable, useDefaultDeno }) =>
    configureNodeLocalDeployment(
      name,
      {
        ...Option.match(port, {
          onNone: () => ({}),
          onSome: (value) => ({ port: value }),
        }),
        ...Option.match(denoExecutable, {
          onNone: () => ({}),
          onSome: (value) => ({ denoExecutable: value }),
        }),
        useDefaultDeno,
      },
      (descriptor) =>
        assertNodeDeploymentStateQuiescent(descriptor.stateDirectory),
    ).pipe(
      Effect.tap((descriptor) => printJson(descriptor)),
      Effect.asVoid,
    ),
  ),
);

const startDeploymentCommand = Command.make("start", {
  name: deploymentNameArgument,
}).pipe(
  Command.withDescription(
    "Run a local Node deployment in the foreground until Ctrl-C.",
  ),
  Command.withHandler(({ name }) =>
    Effect.sync(() =>
      process.stderr.write(
        `[ptools] starting local Node deployment ${name}; press Ctrl-C to stop\n`,
      ),
    ).pipe(Effect.andThen(startNodeLocalDeployment(name))),
  ),
);
const listDeploymentsCommand = Command.make("list").pipe(
  Command.withHandler(() =>
    listNodeLocalDeployments().pipe(Effect.tap(printJson), Effect.asVoid),
  ),
);
const deploymentCommand = Command.make("deployment").pipe(
  Command.withSubcommands([
    createDeploymentCommand,
    configureDeploymentCommand,
    startDeploymentCommand,
    listDeploymentsCommand,
  ]),
);
const nodeCommand = Command.make("node").pipe(
  Command.withSubcommands([deploymentCommand]),
);

const rootCommand = Command.make("ptools").pipe(
  Command.withDescription("MCP-first Code Mode tools."),
  Command.withSubcommands([mcpCommand, nodeCommand]),
);

/**
 * Product-owned local bootstrap: decode one authored file, explicitly configure
 * the conventional personal Node host, and expose its Code Mode client on stdio.
 */
const serveLocalNodeMcp = (
  requestedConfigPath: Option.Option<string>,
  hostId: string,
  deploymentName: string,
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
      // Connect to the explicitly started deployment. This command never starts
      // or retains the server; closing its scope releases only client resources.
      const embeddedNodeHost = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () =>
            connectLocalNodeHost({
              hostId,
              deploymentName: NodeDeploymentName.make(deploymentName),
            }),
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
      Effect.fromNullishOr(env[name]).pipe(
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

const printJson = (value: unknown): Effect.Effect<void> =>
  Effect.sync(() =>
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`),
  );

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
  version: "0.1.0-alpha.0",
});

const program = runCli.pipe(Effect.provide(NodeServices.layer));

void Effect.runPromiseExit(program).then((exit) => {
  if (Exit.isSuccess(exit)) return;

  const failure = Cause.findErrorOption(exit.cause);
  if (Option.isSome(failure)) {
    if (!CliError.isCliError(failure.value)) {
      process.stderr.write(`${safeErrorMessage(failure.value)}\n`);
    }
  } else {
    process.stderr.write(`${Cause.pretty(exit.cause)}\n`);
  }
  process.exitCode = 1;
});
