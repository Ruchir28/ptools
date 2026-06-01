import {
  AuthCoordinator,
  isAuthRequiredError,
  isDynamicClientRegistrationUnsupported,
} from "@ptools/auth";
import { Context, Effect, Scope } from "effect";
import type { McpConnector } from "./connector.js";
import { McpConnectionError, NameCollisionError } from "./errors.js";
import { buildNameMap, getMappedName } from "./names.js";
import { safeErrorMessage } from "./schema.js";
import type {
  ConnectedMcpClient,
  McpRegistryDiagnostic,
  UpstreamMcpServers,
} from "./types.js";

type AuthCoordinatorService = Context.Tag.Service<typeof AuthCoordinator>;
type McpConnectorService = Context.Tag.Service<typeof McpConnector>;

export interface ConnectConfiguredMcpClientsResult {
  readonly clients: ReadonlyArray<ConnectedMcpClient>;
  readonly diagnostics: ReadonlyArray<McpRegistryDiagnostic>;
}

export const connectConfiguredMcpClients = (
  upstreams: UpstreamMcpServers,
  authCoordinator: AuthCoordinatorService,
  connector: McpConnectorService,
): Effect.Effect<
  ConnectConfiguredMcpClientsResult,
  NameCollisionError,
  Scope.Scope
> =>
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
      const result = yield* connector
        .connect({
          serverName,
          jsServerName,
          config,
        })
        .pipe(Effect.either);

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
