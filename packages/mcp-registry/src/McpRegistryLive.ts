import { AuthCoordinator, type AuthError } from "@ptools/auth";
import { Effect, Layer, Scope } from "effect";
import { closeClients, connectConfiguredMcpClients } from "./connect.js";
import { McpConnector } from "./connector.js";
import { discoverAllToolsDegraded } from "./discovery.js";
import { dispatchToolCall } from "./dispatch.js";
import type { NameCollisionError } from "./errors.js";
import { McpRegistry } from "./registry.js";
import type {
  ConnectedMcpClient,
  DiscoveredMcpTool,
  McpAuthStatus,
  McpRegistryDiagnostic,
  UpstreamMcpServers,
} from "./types.js";

interface McpRegistryState {
  readonly clients: ReadonlyArray<ConnectedMcpClient>;
  readonly tools: ReadonlyArray<DiscoveredMcpTool>;
  readonly diagnostics: ReadonlyArray<McpRegistryDiagnostic>;
}

export const makeMcpRegistryLive = (
  upstreams: UpstreamMcpServers,
): Layer.Layer<
  McpRegistry,
  AuthError | NameCollisionError,
  AuthCoordinator | McpConnector
> =>
  Layer.scoped(
    McpRegistry,
    Effect.gen(function* () {
      const authCoordinator = yield* AuthCoordinator;
      const connector = yield* McpConnector;
      const layerScope = yield* Effect.scope;
      let state: McpRegistryState = {
        clients: [],
        tools: [],
        diagnostics: [],
      };
      const connectUpstreams = (selected: UpstreamMcpServers) =>
        connectConfiguredMcpClients(selected, authCoordinator, connector).pipe(
          Scope.extend(layerScope),
        );
      const refreshState = Effect.gen(function* () {
        const previousClients = state.clients;
        const connected = yield* connectUpstreams(upstreams);

        const discovered = yield* discoverAllToolsDegraded(connected.clients);

        state = {
          clients: discovered.clients,
          tools: discovered.tools,
          diagnostics: dedupeDiagnostics([
            ...connected.diagnostics,
            ...discovered.diagnostics,
          ]),
        };

        yield* closeClients(
          previousClients.filter(
            (previous) =>
              !state.clients.some(
                (current) => current.client === previous.client,
              ),
          ),
        );
      });
      const refreshServerState = (serverName: string) =>
        Effect.gen(function* () {
          const upstream = upstreams[serverName];

          if (upstream === undefined) {
            throw new Error(`Unknown MCP server: ${serverName}`);
          }

          const previousServerClients = state.clients.filter(
            (client) => client.serverName === serverName,
          );
          const connected = yield* connectUpstreams({ [serverName]: upstream });
          const discovered = yield* discoverAllToolsDegraded(connected.clients);
          const otherClients = state.clients.filter(
            (client) => client.serverName !== serverName,
          );
          const otherTools = state.tools.filter(
            (tool) => tool.serverName !== serverName,
          );
          const otherDiagnostics = state.diagnostics.filter(
            (diagnostic) => diagnostic.serverName !== serverName,
          );

          state = {
            clients: [...otherClients, ...discovered.clients],
            tools: [...otherTools, ...discovered.tools],
            diagnostics: dedupeDiagnostics([
              ...otherDiagnostics,
              ...connected.diagnostics,
              ...discovered.diagnostics,
            ]),
          };

          yield* closeClients(previousServerClients);
        });

      if (authCoordinator.setAuthorizedHandler !== undefined) {
        yield* authCoordinator.setAuthorizedHandler((serverName) =>
          Effect.runPromise(refreshServerState(serverName)),
        );
      }

      if (authCoordinator.setRefreshHandler !== undefined) {
        yield* authCoordinator.setRefreshHandler((serverName) =>
          Effect.runPromise(refreshServerState(serverName)),
        );
      }

      yield* refreshState;
      yield* Effect.addFinalizer(() => closeClients(state.clients));

      return {
        listTools: Effect.sync(() => state.tools),
        diagnostics: Effect.gen(function* () {
          const authStatus = yield* authCoordinator.status;

          return dedupeDiagnostics([
            ...state.diagnostics,
            ...authDiagnostics(authStatus),
          ]);
        }),
        authStatus: authCoordinator.status,
        refresh: refreshState,
        callTool: (request) =>
          Effect.gen(function* () {
            const authStatus = yield* authCoordinator.status;

            return yield* dispatchToolCall(
              state.clients,
              state.tools,
              request,
              authStatus,
            );
          }),
      };
    }),
  );

const authDiagnostics = (
  authStatus: McpAuthStatus,
): ReadonlyArray<McpRegistryDiagnostic> =>
  authStatus.servers.flatMap((server): ReadonlyArray<McpRegistryDiagnostic> => {
    if (server.status === "requires_auth") {
      return [
        {
          code: "UpstreamAuthRequired" as const,
          severity: "warning" as const,
          serverName: server.serverName,
          message:
            server.message ??
            `${server.serverName} requires authorization before its tools can run. Open ${authStatus.authUrl} and authorize it, then call search again.`,
          authUrl: authStatus.authUrl,
          ...(server.authorizeUrl === undefined
            ? {}
            : { authorizeUrl: server.authorizeUrl }),
        },
      ];
    }

    if (server.status === "needs_config") {
      return [
        {
          code: "UpstreamAuthNeedsConfig" as const,
          severity: "warning" as const,
          serverName: server.serverName,
          message:
            server.message ??
            `${server.serverName} needs auth configuration before ptools can authorize it. Open ${authStatus.authUrl} for setup options.`,
          authUrl: authStatus.authUrl,
          ...(server.setupUrl === undefined
            ? {}
            : { setupUrl: server.setupUrl }),
        },
      ];
    }

    return [];
  });

const dedupeDiagnostics = (
  diagnostics: ReadonlyArray<McpRegistryDiagnostic>,
): ReadonlyArray<McpRegistryDiagnostic> => {
  const seen = new Set<string>();
  const result: Array<McpRegistryDiagnostic> = [];

  for (const diagnostic of diagnostics) {
    const key = `${diagnostic.code}:${diagnostic.serverName}:${"toolName" in diagnostic ? diagnostic.toolName : ""}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(diagnostic);
  }

  return result;
};
