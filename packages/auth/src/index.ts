import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  ResolvedHttpMcpAuthConfig,
  ResolvedHttpMcpConfig,
  ResolvedMcpConfig,
  ResolvedMcpServers,
} from "@ptools/config";
import { Context, Data, Effect } from "effect";

export class AuthError extends Data.TaggedError("AuthError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class CredentialError extends Data.TaggedError("CredentialError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export type UpstreamHttpAuthConfig = ResolvedHttpMcpAuthConfig;
export type UpstreamMcpConfig = ResolvedMcpConfig;
export type UpstreamMcpServers = ResolvedMcpServers;
export type HttpMcpConfig = ResolvedHttpMcpConfig;

export interface OAuthStatePayload {
  readonly runtimeId: string;
  readonly serverName: string;
  readonly jsServerName: string;
  readonly nonce: string;
  readonly redirectAfterAuth?: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export type McpAuthStatusValue =
  | "connected"
  | "requires_auth"
  | "auth_in_progress"
  | "auth_failed"
  | "needs_config"
  | "static_credentials"
  | "unsupported_auth"
  | "disabled";

export interface McpAuthServerStatus {
  readonly serverName: string;
  readonly jsServerName: string;
  readonly transport: UpstreamMcpConfig["transport"];
  readonly status: McpAuthStatusValue;
  readonly authUrl?: string;
  readonly authorizeUrl?: string;
  readonly reauthorizeUrl?: string;
  readonly setupUrl?: string;
  readonly message?: string;
  readonly lastError?: string;
}

export interface McpAuthStatus {
  readonly authUrl: string;
  readonly servers: ReadonlyArray<McpAuthServerStatus>;
}

export class CredentialsStore extends Context.Tag("@ptools/CredentialsStore")<
  CredentialsStore,
  {
    readonly get: (
      key: string,
    ) => Effect.Effect<string | undefined, CredentialError>;
    readonly set: (
      key: string,
      value: string,
    ) => Effect.Effect<void, CredentialError>;
    readonly delete: (key: string) => Effect.Effect<void, CredentialError>;
  }
>() {}

export class AuthCoordinator extends Context.Tag("@ptools/AuthCoordinator")<
  AuthCoordinator,
  {
    readonly origin: Effect.Effect<string, AuthError>;
    readonly callbackUrl: (
      serverName: string,
    ) => Effect.Effect<string, AuthError>;
    readonly noteConfigured: (
      serverName: string,
      jsServerName: string,
      config: ResolvedMcpConfig,
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
      handler: (serverName: string) => Promise<void>,
    ) => Effect.Effect<void, never>;
    readonly setRefreshHandler?: (
      handler: (serverName: string) => Promise<void>,
    ) => Effect.Effect<void, never>;
    readonly handleAuthRequest?: (request: Request) => Promise<Response>;
  }
>() {}

export const isAuthRequiredError = (cause: unknown): boolean => {
  if (cause instanceof UnauthorizedError) {
    return true;
  }

  const message = safeErrorMessage(cause).toLowerCase();

  return (
    message.includes("unauthorized") ||
    message.includes("invalid_token") ||
    message.includes("missing or invalid access token") ||
    message.includes("missing required authorization header")
  );
};

export const isDynamicClientRegistrationUnsupported = (
  cause: unknown,
): boolean => {
  const message = safeErrorMessage(cause).toLowerCase();

  return (
    message.includes("dynamic client registration") &&
    (message.includes("does not support") ||
      message.includes("not supported") ||
      message.includes("incompatible auth server"))
  );
};

export const safeErrorMessage = (cause: unknown): string => {
  if (
    typeof cause === "object" &&
    cause !== null &&
    "message" in cause &&
    typeof cause.message === "string"
  ) {
    return cause.message;
  }

  return String(cause);
};

export * from "./coordinatorCore.js";
