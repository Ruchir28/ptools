import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { AuthCoordinator, AuthError } from "@ptools/auth";
import {
  BaseMcpConnectorLive,
  HttpMcpConnector,
  McpConnectionError,
  McpConnector,
  StdioMcpConnector,
  TolerantOutputSchemaValidator,
  type ConnectedMcpClient,
  type ConnectMcpInput,
  type UpstreamMcpConfig,
} from "@ptools/mcp-registry";
import { Context, Effect, Layer, Option, Scope } from "effect";

type AuthCoordinatorService = Context.Tag.Service<typeof AuthCoordinator>;

export const NodeStdioMcpConnectorLive: Layer.Layer<
  StdioMcpConnector,
  never,
  never
> = Layer.succeed(StdioMcpConnector, {
  connect: connectNodeStdioMcp,
});

export const NodeHttpMcpConnectorLive: Layer.Layer<
  HttpMcpConnector,
  never,
  AuthCoordinator
> = Layer.effect(
  HttpMcpConnector,
  Effect.gen(function* () {
    const authCoordinator = yield* AuthCoordinator;

    return {
      connect: (input: ConnectMcpInput) =>
        connectNodeHttpMcp(input, authCoordinator),
    };
  }),
);

export const NodeMcpTransportConnectorsLive: Layer.Layer<
  StdioMcpConnector | HttpMcpConnector,
  never,
  AuthCoordinator
> = Layer.mergeAll(NodeStdioMcpConnectorLive, NodeHttpMcpConnectorLive);

export const NodeMcpConnectorLive: Layer.Layer<
  McpConnector,
  never,
  AuthCoordinator
> = BaseMcpConnectorLive.pipe(Layer.provide(NodeMcpTransportConnectorsLive));

function connectNodeStdioMcp(
  input: ConnectMcpInput,
): Effect.Effect<ConnectedMcpClient, McpConnectionError, Scope.Scope> {
  if (input.config.transport !== "stdio") {
    return unsupportedTransport(input);
  }

  return connectWithTransport(input, createStdioTransport(input.config));
}

function connectNodeHttpMcp(
  input: ConnectMcpInput,
  authCoordinator: AuthCoordinatorService,
): Effect.Effect<ConnectedMcpClient, McpConnectionError, Scope.Scope> {
  if (input.config.transport !== "http") {
    return unsupportedTransport(input);
  }

  return createHttpTransport(
    input.serverName,
    input.config,
    authCoordinator,
  ).pipe(
    Effect.mapError(
      (cause) =>
        new McpConnectionError({ serverName: input.serverName, cause }),
    ),
    Effect.flatMap((transport) =>
      connectWithTransport(input, transport as Transport),
    ),
  );
}

const connectWithTransport = (
  input: ConnectMcpInput,
  transport: Transport,
): Effect.Effect<ConnectedMcpClient, McpConnectionError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const client = new Client(
        {
          name: `ptools-${input.serverName}`,
          version: "0.0.0",
        },
        {
          jsonSchemaValidator: new TolerantOutputSchemaValidator(),
        },
      );

      yield* Effect.tryPromise({
        try: () => client.connect(transport),
        catch: (cause) =>
          new McpConnectionError({ serverName: input.serverName, cause }),
      });

      return {
        serverName: input.serverName,
        jsServerName: input.jsServerName,
        client,
      };
    }),
    closeConnectedClient,
  );

const closeConnectedClient = (
  connected: ConnectedMcpClient,
): Effect.Effect<void> =>
  Effect.tryPromise({
    try: () => connected.client.close(),
    catch: (cause) =>
      new McpConnectionError({
        serverName: connected.serverName,
        cause,
      }),
  }).pipe(Effect.catchAll(() => Effect.void));

const createStdioTransport = (
  config: Extract<UpstreamMcpConfig, { readonly transport: "stdio" }>,
): StdioClientTransport => {
  const params: ConstructorParameters<typeof StdioClientTransport>[0] = {
    command: config.command,
  };

  Option.map(config.args, (args) => {
    params.args = [...args];
  });
  Option.map(config.env, (env) => {
    params.env = { ...env };
  });
  Option.map(config.cwd, (cwd) => {
    params.cwd = cwd;
  });

  return new StdioClientTransport(params);
};

const createHttpTransport = (
  serverName: string,
  config: Extract<UpstreamMcpConfig, { readonly transport: "http" }>,
  authCoordinator: AuthCoordinatorService,
): Effect.Effect<StreamableHTTPClientTransport, AuthError> =>
  Effect.gen(function* () {
    const shouldAttachAuthProvider = yield* shouldUseAuthProvider(
      serverName,
      config,
      authCoordinator,
    );
    const authProvider = shouldAttachAuthProvider
      ? yield* authCoordinator.providerFor(serverName, config)
      : undefined;
    const options: ConstructorParameters<
      typeof StreamableHTTPClientTransport
    >[1] = {
      ...(authProvider === undefined ? {} : { authProvider }),
      ...Option.match(config.headers, {
        onNone: () => ({}),
        onSome: (headers) => ({
          requestInit: {
            headers,
          },
        }),
      }),
    };

    return yield* Effect.try({
      try: () =>
        new StreamableHTTPClientTransport(new URL(config.url), options),
      catch: (cause) =>
        new AuthError({
          message: `Failed to create HTTP transport for ${serverName}`,
          cause,
        }),
    });
  });

const shouldUseAuthProvider = (
  serverName: string,
  config: Extract<UpstreamMcpConfig, { readonly transport: "http" }>,
  authCoordinator: AuthCoordinatorService,
): Effect.Effect<boolean, never> =>
  Effect.gen(function* () {
    if (Option.isSome(config.auth)) {
      return true;
    }

    if (yield* authCoordinator.shouldAttachAuthProvider(serverName)) {
      return true;
    }

    return yield* authCoordinator.hasStoredCredentials(serverName, config);
  });

const unsupportedTransport = (
  input: ConnectMcpInput,
): Effect.Effect<never, McpConnectionError> =>
  Effect.fail(
    new McpConnectionError({
      serverName: input.serverName,
      cause: new Error(
        `Node MCP connector cannot connect ${input.config.transport} transport`,
      ),
    }),
  );
