import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { Effect } from "effect";
import {
  isAuthRequiredError,
  isDynamicClientRegistrationUnsupported,
  type PtoolsAuthManager,
} from "./auth.js";
import { McpConnectionError, NameCollisionError } from "./errors.js";
import { buildNameMap, getMappedName } from "./names.js";
import { safeErrorMessage, TolerantOutputSchemaValidator } from "./schema.js";
import type {
  ConnectedMcpClient,
  McpRegistryDiagnostic,
  UpstreamMcpConfig,
  UpstreamMcpServers,
} from "./types.js";

export interface ConnectConfiguredMcpClientsResult {
  readonly clients: ReadonlyArray<ConnectedMcpClient>;
  readonly diagnostics: ReadonlyArray<McpRegistryDiagnostic>;
}

export const connectConfiguredMcpClients = (
  upstreams: UpstreamMcpServers,
  authManager?: PtoolsAuthManager,
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
      authManager?.noteConfigured(serverName, jsServerName, config);
      const result = yield* connectMcpClient(
        serverName,
        jsServerName,
        config,
        authManager,
      ).pipe(Effect.either);

      if (result._tag === "Left") {
        authManager?.noteConnectionError(serverName, result.left.cause);
        diagnostics.push(toConnectionDiagnostic(result.left, authManager));
      } else {
        authManager?.noteConnected(serverName);
        clients.push(result.right);
      }
    }

    return { clients, diagnostics };
  });

const connectMcpClient = (
  serverName: string,
  jsServerName: string,
  config: UpstreamMcpConfig,
  authManager?: PtoolsAuthManager,
): Effect.Effect<ConnectedMcpClient, McpConnectionError> =>
  Effect.tryPromise({
    try: async () => {
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
          : await createHttpTransport(serverName, config, authManager);

      await client.connect(transport as Transport);

      return {
        serverName,
        jsServerName,
        client,
      };
    },
    catch: (cause) => new McpConnectionError({ serverName, cause }),
  });

const toConnectionDiagnostic = (
  error: McpConnectionError,
  authManager?: PtoolsAuthManager,
): McpRegistryDiagnostic => {
  if (isAuthRequiredError(error.cause) && authManager !== undefined) {
    const status = authManager.status();
    const serverStatus = status.servers.find(
      (server) => server.serverName === error.serverName,
    );

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

  if (
    isDynamicClientRegistrationUnsupported(error.cause) &&
    authManager !== undefined
  ) {
    const status = authManager.status();
    const serverStatus = status.servers.find(
      (server) => server.serverName === error.serverName,
    );

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
};

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

const createHttpTransport = async (
  serverName: string,
  config: Extract<UpstreamMcpConfig, { readonly transport: "http" }>,
  authManager?: PtoolsAuthManager,
): Promise<StreamableHTTPClientTransport> => {
  const shouldAttachAuthProvider =
    authManager !== undefined &&
    (config.auth !== undefined ||
      authManager.shouldAttachAuthProvider(serverName) ||
      (await authManager.hasStoredCredentials(serverName, config)));
  const authProvider = shouldAttachAuthProvider
    ? authManager.providerFor(serverName, config)
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

  if (config.headers === undefined) {
    return new StreamableHTTPClientTransport(new URL(config.url), options);
  }

  return new StreamableHTTPClientTransport(new URL(config.url), options);
};

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
