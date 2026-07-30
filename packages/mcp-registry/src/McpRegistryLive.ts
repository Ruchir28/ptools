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

/** Complete published registry view used by search, dispatch, and diagnostics. */
interface McpRegistryState {
  readonly clients: ReadonlyArray<ConnectedMcpClient>;
  readonly tools: ReadonlyArray<DiscoveredMcpTool>;
  readonly diagnostics: ReadonlyArray<McpRegistryDiagnostic>;
}

const emptyRegistryState = (): McpRegistryState => ({
  clients: [],
  tools: [],
  diagnostics: [],
});

/**
 * Build one scoped MCP registry for the resolved upstream configuration.
 *
 * The registry owns all connected clients and discovered tools. Connection and
 * discovery failures that can be represented operationally are published as
 * diagnostics; structural failures remain in the layer error channel during
 * initial construction. After OAuth completes, the auth coordinator invokes an
 * Effect-native callback that refreshes only the authorized server.
 */
export const makeMcpRegistryLive = (
  upstreams: UpstreamMcpServers,
): Layer.Layer<
  McpRegistry,
  AuthError | NameCollisionError,
  AuthCoordinator | McpConnector
> =>
  Layer.effect(
    McpRegistry,
    Effect.gen(function* () {
      const authCoordinator = yield* AuthCoordinator;
      const connector = yield* McpConnector;
      const registryScope = yield* Effect.scope;
      let currentState = emptyRegistryState();

      /**
       * Attach every newly connected client to the registry layer's lifetime.
       * Refresh callbacks run after layer construction, so their acquisitions
       * must be explicitly extended into this already-captured scope.
       */
      const connectWithinRegistryScope = (selected: UpstreamMcpServers) =>
        connectConfiguredMcpClients(selected, authCoordinator, connector).pipe(
          Scope.provide(registryScope),
        );

      /** Reconnect and rediscover the complete configured upstream set. */
      const refreshAllServers = Effect.gen(function* () {
        const previousClients = currentState.clients;
        const connected = yield* connectWithinRegistryScope(upstreams);
        const discovered = yield* discoverAllToolsDegraded(
          connected.clients,
        ).pipe(Effect.onError(() => closeClients(connected.clients)));

        // Publish one complete replacement before releasing superseded clients,
        // so readers never observe a partially rebuilt registry.
        currentState = {
          clients: discovered.clients,
          tools: discovered.tools,
          diagnostics: dedupeDiagnostics([
            ...connected.diagnostics,
            ...discovered.diagnostics,
          ]),
        };

        yield* closeClients(clientsMissingFrom(previousClients, currentState));
      });

      /**
       * Reconnect and rediscover one server while preserving every other
       * server's currently published clients, tools, and diagnostics.
       */
      const refreshOneServer = (serverName: string) =>
        Effect.gen(function* () {
          const upstream = upstreams[serverName];

          if (upstream === undefined) {
            return yield* Effect.die(
              new Error(
                `Authorized handler received unknown MCP server: ${serverName}`,
              ),
            );
          }

          const previousServerClients = currentState.clients.filter(
            (client) => client.serverName === serverName,
          );
          const connected = yield* connectWithinRegistryScope({
            [serverName]: upstream,
          });
          const discovered = yield* discoverAllToolsDegraded(
            connected.clients,
          ).pipe(
            // A structural discovery failure occurs before publication. Close
            // clients acquired by this failed attempt instead of leaking them.
            Effect.onError(() => closeClients(connected.clients)),
          );

          currentState = replaceServerState(
            currentState,
            serverName,
            connected.diagnostics,
            discovered,
          );

          yield* closeClients(previousServerClients);
        });

      /** Publish a refresh error as registry information, not a fiber defect. */
      const publishServerRefreshFailure = (
        serverName: string,
        message: string,
      ): Effect.Effect<void> =>
        Effect.sync(() => {
          currentState = withServerRefreshFailure(
            currentState,
            serverName,
            message,
          );
        });

      /**
       * Auth callbacks must have no expected error channel. The registry owns
       * its refresh errors, so it converts them into visible diagnostics here.
       */
      const refreshAuthorizedServer = (serverName: string) =>
        refreshOneServer(serverName).pipe(
          Effect.catchTags({
            AuthError: (error) =>
              publishServerRefreshFailure(serverName, error.message),
            NameCollisionError: (error) =>
              publishServerRefreshFailure(
                serverName,
                `Name collision in ${error.scope}: ${error.originals.join(", ")} map to ${error.jsName}.`,
              ),
          }),
        );

      // Authorization changes auth state; the registry owns the resulting MCP
      // reconnect and therefore registers its own Effect-native callback.
      if (authCoordinator.setAuthorizedHandler !== undefined) {
        yield* authCoordinator.setAuthorizedHandler(refreshAuthorizedServer);
      }

      // Build the initial registry before publishing the service. All clients
      // still live at scope shutdown are closed by this finalizer.
      yield* refreshAllServers;
      yield* Effect.addFinalizer(() => closeClients(currentState.clients));

      return {
        listTools: Effect.sync(() => currentState.tools),
        diagnostics: Effect.gen(function* () {
          const authStatus = yield* authCoordinator.status;

          return dedupeDiagnostics([
            ...currentState.diagnostics,
            ...authDiagnostics(authStatus),
          ]);
        }),
        authStatus: authCoordinator.status,
        refresh: refreshAllServers,
        callTool: (request) =>
          Effect.gen(function* () {
            const authStatus = yield* authCoordinator.status;

            return yield* dispatchToolCall(
              currentState.clients,
              currentState.tools,
              request,
              authStatus,
            );
          }),
      };
    }),
  );

/** Return old clients no longer present by client identity after replacement. */
const clientsMissingFrom = (
  previousClients: ReadonlyArray<ConnectedMcpClient>,
  nextState: McpRegistryState,
): ReadonlyArray<ConnectedMcpClient> =>
  previousClients.filter(
    (previous) =>
      !nextState.clients.some((current) => current.client === previous.client),
  );

/** Replace one server's published slice without disturbing other servers. */
const replaceServerState = (
  state: McpRegistryState,
  serverName: string,
  connectionDiagnostics: ReadonlyArray<McpRegistryDiagnostic>,
  discovered: {
    readonly clients: ReadonlyArray<ConnectedMcpClient>;
    readonly tools: ReadonlyArray<DiscoveredMcpTool>;
    readonly diagnostics: ReadonlyArray<McpRegistryDiagnostic>;
  },
): McpRegistryState => ({
  clients: [
    ...state.clients.filter((client) => client.serverName !== serverName),
    ...discovered.clients,
  ],
  tools: [
    ...state.tools.filter((tool) => tool.serverName !== serverName),
    ...discovered.tools,
  ],
  diagnostics: dedupeDiagnostics([
    ...state.diagnostics.filter(
      (diagnostic) => diagnostic.serverName !== serverName,
    ),
    ...connectionDiagnostics,
    ...discovered.diagnostics,
  ]),
});

/** Replace only this server's previous refresh-failure diagnostic. */
const withServerRefreshFailure = (
  state: McpRegistryState,
  serverName: string,
  message: string,
): McpRegistryState => ({
  ...state,
  diagnostics: [
    ...state.diagnostics.filter(
      (diagnostic) =>
        diagnostic.serverName !== serverName ||
        diagnostic.code !== "McpRegistryRefreshFailed",
    ),
    {
      code: "McpRegistryRefreshFailed",
      severity: "error",
      serverName,
      message,
    },
  ],
});

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

/** Keep one diagnostic for each semantic server/tool failure key. */
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
