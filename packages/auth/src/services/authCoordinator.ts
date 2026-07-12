/** Shared AuthCoordinator service consumed by host MCP connectors. */
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { Effect } from "effect";
import type { McpAuthStatus } from "../contracts/index.js";
import type { AuthError } from "../authErrors.js";
import type { HttpMcpConfig, UpstreamMcpConfig } from "../authTypes.js";
import {
  AuthCoordinatorCore,
  type AuthServerHandler,
} from "../coordinatorCore.js";

export interface AuthCoordinatorService {
  readonly origin: Effect.Effect<string, AuthError>;
  readonly callbackUrl: (
    serverName: string,
  ) => Effect.Effect<string, AuthError>;
  readonly noteConfigured: (
    serverName: string,
    jsServerName: string,
    config: UpstreamMcpConfig,
  ) => Effect.Effect<void, never>;
  readonly noteConnected: (
    serverName: string,
  ) => Effect.Effect<void, AuthError>;
  readonly noteConnectionError: (
    serverName: string,
    error: unknown,
  ) => Effect.Effect<void, AuthError>;
  readonly shouldAttachAuthProvider: (
    serverName: string,
  ) => Effect.Effect<boolean, never>;
  readonly hasStoredCredentials: (
    serverName: string,
    config: HttpMcpConfig,
  ) => Effect.Effect<boolean, never>;
  readonly providerFor: (
    serverName: string,
    config: HttpMcpConfig,
  ) => Effect.Effect<OAuthClientProvider, AuthError>;
  readonly status: Effect.Effect<McpAuthStatus, never>;
  readonly setAuthorizedHandler?: (
    handler: AuthServerHandler,
  ) => Effect.Effect<void, never>;
  readonly handleAuthRequest?: (request: Request) => Promise<Response>;
}

/**
 * AuthCoordinator facade consumed by shared MCP registry/connector code.
 *
 * The default implementation owns no separate state; it delegates to the shared
 * AuthCoordinatorCore built once per host runtime.
 */
export class AuthCoordinator extends Effect.Service<AuthCoordinator>()(
  "@ptools/AuthCoordinator",
  {
    effect: makeAuthCoordinator(),
  },
) {}

function makeAuthCoordinator(): Effect.Effect<
  AuthCoordinatorService,
  never,
  AuthCoordinatorCore
> {
  return Effect.gen(function* () {
    const core = yield* AuthCoordinatorCore;

    return {
      origin: core.origin,
      callbackUrl: core.callbackUrl,
      noteConfigured: core.noteConfigured,
      noteConnected: core.noteConnected,
      noteConnectionError: core.noteConnectionError,
      shouldAttachAuthProvider: core.shouldAttachAuthProvider,
      hasStoredCredentials: core.hasStoredCredentials,
      providerFor: core.providerFor,
      status: core.status,
      setAuthorizedHandler: core.setAuthorizedHandler,
    } satisfies AuthCoordinatorService;
  });
}
