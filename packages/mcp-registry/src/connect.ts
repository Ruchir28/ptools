import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { Effect } from "effect";
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
): Effect.Effect<
  ReadonlyArray<ConnectedMcpClient>,
  McpConnectionError | NameCollisionError
> =>
  Effect.gen(function* () {
    const entries = Object.entries(upstreams);
    const serverNameMap = yield* buildNameMap(
      entries.map(([serverName]) => serverName),
      "mcp server names",
    );
    const clients: Array<ConnectedMcpClient> = [];

    for (const [serverName, config] of entries) {
      const jsServerName = yield* getMappedName(
        serverNameMap,
        serverName,
        "mcp server names",
      );

      clients.push(yield* connectMcpClient(serverName, jsServerName, config));
    }

    return clients;
  });

export const connectConfiguredMcpClientsDegraded = (
  upstreams: UpstreamMcpServers,
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
      const result = yield* connectMcpClient(
        serverName,
        jsServerName,
        config,
      ).pipe(Effect.either);

      if (result._tag === "Left") {
        diagnostics.push(toConnectionDiagnostic(result.left));
      } else {
        clients.push(result.right);
      }
    }

    return { clients, diagnostics };
  });

const connectMcpClient = (
  serverName: string,
  jsServerName: string,
  config: UpstreamMcpConfig,
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
          : createHttpTransport(config);

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
): McpRegistryDiagnostic => ({
  code: "McpConnectionFailed",
  severity: "error",
  serverName: error.serverName,
  message: safeErrorMessage(error.cause),
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
  config: Extract<UpstreamMcpConfig, { readonly transport: "http" }>,
): StreamableHTTPClientTransport => {
  if (config.headers === undefined) {
    return new StreamableHTTPClientTransport(new URL(config.url));
  }

  return new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: {
      headers: config.headers,
    },
  });
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
