import {
  AuthCoordinator,
  type AuthError,
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

type AuthCoordinatorService = Context.Service.Shape<typeof AuthCoordinator>;
type McpConnectorService = Context.Service.Shape<typeof McpConnector>;

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
  AuthError | NameCollisionError,
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
        .pipe(
          Effect.provideService(AuthCoordinator, authCoordinator),
          Effect.result,
        );

      if (result._tag === "Failure") {
        yield* authCoordinator.noteConnectionError(
          serverName,
          result.failure.cause,
        );
        diagnostics.push(
          yield* toConnectionDiagnostic(result.failure, authCoordinator),
        );
      } else {
        yield* authCoordinator.noteConnected(serverName);
        clients.push(result.success);
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
      }).pipe(Effect.catch(() => Effect.void));
    }
  });
