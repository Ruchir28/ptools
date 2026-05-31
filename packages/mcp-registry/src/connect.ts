import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  AuthCoordinator,
  AuthError,
  isAuthRequiredError,
  isDynamicClientRegistrationUnsupported,
} from "@ptools/auth";
import { Context, Effect } from "effect";
import { McpConnectionError, NameCollisionError } from "./errors.js";
import { buildNameMap, getMappedName } from "./names.js";
import { safeErrorMessage, TolerantOutputSchemaValidator } from "./schema.js";
import type {
  ConnectedMcpClient,
  McpRegistryDiagnostic,
  UpstreamMcpConfig,
  UpstreamMcpServers,
} from "./types.js";

type AuthCoordinatorService = Context.Tag.Service<typeof AuthCoordinator>;

export interface ConnectConfiguredMcpClientsResult {
  readonly clients: ReadonlyArray<ConnectedMcpClient>;
  readonly diagnostics: ReadonlyArray<McpRegistryDiagnostic>;
}

export const connectConfiguredMcpClients = (
  upstreams: UpstreamMcpServers,
  authCoordinator: AuthCoordinatorService,
): Effect.Effect<ConnectConfiguredMcpClientsResult, NameCollisionError> =>
  Effect.gen(function* () {
    const entries = Object.entries(upstreams);
    const serverNameMap = yield* buildNameMap(
      entries.map(([serverName]) => serverName),
      "mcp server names",
    );
    const clients: Array<ConnectedMcpClient> = [];
    const diagnostics: Array<McpRegistryDiagnostic> = [];

    for (const [serverName, config] of entries) {
      const jsServerName = yield* getMappedName(
        serverNameMap,
        serverName,
        "mcp server names",
      );
      yield* authCoordinator.noteConfigured(serverName, jsServerName, config);
      const result = yield* connectMcpClient(
        serverName,
        jsServerName,
        config,
        authCoordinator,
      ).pipe(Effect.either);

      if (result._tag === "Left") {
        yield* authCoordinator.noteConnectionError(
          serverName,
          result.left.cause,
        );
        diagnostics.push(
          yield* toConnectionDiagnostic(result.left, authCoordinator),
        );
      } else {
        yield* authCoordinator.noteConnected(serverName);
        clients.push(result.right);
      }
    }

    return { clients, diagnostics };
  });

const connectMcpClient = (
  serverName: string,
  jsServerName: string,
  config: UpstreamMcpConfig,
  authCoordinator: AuthCoordinatorService,
): Effect.Effect<ConnectedMcpClient, McpConnectionError> =>
  Effect.gen(function* () {
    const client = new Client(
      {
        name: `ptools-${serverName}`,
        version: "0.0.0",
      },
      {
        jsonSchemaValidator: new TolerantOutputSchemaValidator(),
      },
    );

    const transport =
      config.transport === "stdio"
        ? createStdioTransport(config)
        : yield* createHttpTransport(serverName, config, authCoordinator).pipe(
            Effect.mapError(
              (cause) => new McpConnectionError({ serverName, cause }),
            ),
          );

    yield* Effect.tryPromise({
      try: () => client.connect(transport as Transport),
      catch: (cause) => new McpConnectionError({ serverName, cause }),
    });

    return {
      serverName,
      jsServerName,
      client,
    };
  });

const toConnectionDiagnostic = (
  error: McpConnectionError,
  authCoordinator: AuthCoordinatorService,
): Effect.Effect<McpRegistryDiagnostic> =>
  Effect.gen(function* () {
    const status = yield* authCoordinator.status;
    const serverStatus = status.servers.find(
      (server) => server.serverName === error.serverName,
    );

    if (isAuthRequiredError(error.cause)) {
      return {
        code: "UpstreamAuthRequired",
        severity: "warning",
        serverName: error.serverName,
        message:
          serverStatus?.message ??
          `${error.serverName} requires authorization before its tools can run. Open ${status.authUrl} and authorize it, then call search again.`,
        authUrl: status.authUrl,
        ...(serverStatus?.authorizeUrl === undefined
          ? {}
          : { authorizeUrl: serverStatus.authorizeUrl }),
      };
    }

    if (isDynamicClientRegistrationUnsupported(error.cause)) {
      return {
        code: "UpstreamAuthNeedsConfig",
        severity: "warning",
        serverName: error.serverName,
        message:
          serverStatus?.message ??
          `${error.serverName} does not support dynamic OAuth client registration. Add auth.clientId, and auth.clientSecret if required, or use another auth method for this server.`,
        authUrl: status.authUrl,
        ...(serverStatus?.setupUrl === undefined
          ? {}
          : { setupUrl: serverStatus.setupUrl }),
      };
    }

    return {
      code: "McpConnectionFailed",
      severity: "error",
      serverName: error.serverName,
      message: safeErrorMessage(error.cause),
    };
  });

const createStdioTransport = (
  config: Extract<UpstreamMcpConfig, { readonly transport: "stdio" }>,
): StdioClientTransport => {
  const params: ConstructorParameters<typeof StdioClientTransport>[0] = {
    command: config.command,
  };

  if (config.args !== undefined) {
    params.args = [...config.args];
  }

  if (config.env !== undefined) {
    params.env = config.env;
  }

  if (config.cwd !== undefined) {
    params.cwd = config.cwd;
  }

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
      ...(config.headers === undefined
        ? {}
        : {
            requestInit: {
              headers: config.headers,
            },
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
    if (config.auth !== undefined) {
      return true;
    }

    if (yield* authCoordinator.shouldAttachAuthProvider(serverName)) {
      return true;
    }

    return yield* authCoordinator.hasStoredCredentials(serverName, config);
  });

export const closeClients = (
  clients: ReadonlyArray<ConnectedMcpClient>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (const connected of clients) {
      yield* Effect.tryPromise({
        try: () => connected.client.close(),
        catch: (cause) =>
          new McpConnectionError({
            serverName: connected.serverName,
            cause,
          }),
      }).pipe(Effect.catchAll(() => Effect.void));
    }
  });
