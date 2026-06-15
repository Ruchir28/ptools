import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { AuthCoordinator, AuthError } from "@ptools/auth";
import {
  HttpMcpConnector,
  McpConnectionError,
  McpConnector,
  TolerantOutputSchemaValidator,
  type ConnectedMcpClient,
  type ConnectMcpInput,
  type UpstreamMcpConfig,
} from "@ptools/mcp-registry";
import { Context, Effect, Layer, Option, Scope } from "effect";

type AuthCoordinatorService = Context.Tag.Service<typeof AuthCoordinator>;

export const CloudflareHttpMcpConnectorLayer: Layer.Layer<
  HttpMcpConnector,
  never,
  AuthCoordinator
> = Layer.effect(
  HttpMcpConnector,
  Effect.gen(function* () {
    const authCoordinator = yield* AuthCoordinator;

    return {
      connect: (input: ConnectMcpInput) =>
        connectCloudflareHttpMcp(input, authCoordinator),
    };
  }),
);

export const CloudflareMcpConnectorLayer: Layer.Layer<
  McpConnector,
  never,
  HttpMcpConnector
> = Layer.effect(
  McpConnector,
  Effect.gen(function* () {
    const http = yield* HttpMcpConnector;

    return {
      connect: (input: ConnectMcpInput) => {
        switch (input.config.transport) {
          case "http":
            return http.connect(input);
          case "stdio":
            return unsupportedTransport(input);
        }
      },
    };
  }),
);

function connectCloudflareHttpMcp(
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
): Effect.Effect<boolean> =>
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
        `Cloudflare MCP connector cannot connect ${input.config.transport} transport in the first release. HTTP MCP is supported; stdio MCP over Containers is deferred.`,
      ),
    }),
  );
