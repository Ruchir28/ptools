import { Effect, Layer } from "effect";
import { PtoolsAuthManager } from "./auth.js";
import { closeClients, connectConfiguredMcpClients } from "./connect.js";
import { discoverAllToolsDegraded } from "./discovery.js";
import { dispatchToolCall } from "./dispatch.js";
import { McpRegistry } from "./registry.js";
import type {
  ConnectedMcpClient,
  DiscoveredMcpTool,
  McpRegistryDiagnostic,
  UpstreamMcpServers,
} from "./types.js";

interface McpRegistryState {
  readonly clients: ReadonlyArray<ConnectedMcpClient>;
  readonly tools: ReadonlyArray<DiscoveredMcpTool>;
  readonly diagnostics: ReadonlyArray<McpRegistryDiagnostic>;
}

export const makeMcpRegistryLive = (upstreams: UpstreamMcpServers) =>
  Layer.scoped(
    McpRegistry,
    Effect.gen(function* () {
      let state: McpRegistryState = {
        clients: [],
        tools: [],
        diagnostics: [],
      };
      let refreshPromise: () => Promise<void> = () => Promise.resolve();
      const authManager = yield* PtoolsAuthManager.make({
        onAuthorized: () => refreshPromise(),
        autoOpen:
          process.env.PTOOLS_AUTH_AUTO_OPEN !== "0" &&
          process.env.PTOOLS_AUTH_AUTO_OPEN !== "false" &&
          process.stderr.isTTY === true,
      });
      const refreshState = Effect.gen(function* () {
        const previousClients = state.clients;
        const connected = yield* connectConfiguredMcpClients(
          upstreams,
          authManager,
        );

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
      refreshPromise = () => Effect.runPromise(refreshState);

      yield* refreshState;
      yield* Effect.addFinalizer(() => closeClients(state.clients));

      yield* Effect.sync(() => {
        process.stderr.write(`[ptools] Auth center: ${authManager.authUrl}\n`);
      });

      return {
        listTools: Effect.sync(() => state.tools),
        diagnostics: Effect.sync(() =>
          dedupeDiagnostics([
            ...state.diagnostics,
            ...authDiagnostics(authManager),
          ]),
        ),
        authStatus: Effect.sync(() => authManager.status()),
        refresh: refreshState,
        callTool: (request) =>
          dispatchToolCall(
            state.clients,
            state.tools,
            request,
            authManager.status(),
          ),
      };
    }),
  );

const authDiagnostics = (
  authManager: PtoolsAuthManager,
): ReadonlyArray<McpRegistryDiagnostic> =>
  authManager
    .status()
    .servers.flatMap((server): ReadonlyArray<McpRegistryDiagnostic> => {
      if (server.status === "requires_auth") {
        return [
          {
            code: "UpstreamAuthRequired" as const,
            severity: "warning" as const,
            serverName: server.serverName,
            message:
              server.message ??
              `${server.serverName} requires authorization before its tools can run. Open ${authManager.authUrl} and authorize it, then call search again.`,
            authUrl: authManager.authUrl,
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
              `${server.serverName} needs auth configuration before ptools can authorize it. Open ${authManager.authUrl} for setup options.`,
            authUrl: authManager.authUrl,
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
