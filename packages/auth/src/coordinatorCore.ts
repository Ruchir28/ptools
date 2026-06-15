import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { ResolvedHttpMcpConfig } from "@ptools/config";
import { Context, Data, Effect, Layer, Option, SynchronizedRef } from "effect";
import {
  AuthError,
  CredentialError,
  isAuthRequiredError,
  isDynamicClientRegistrationUnsupported,
  safeErrorMessage,
  type HttpMcpConfig,
  type McpAuthServerStatus,
  type McpAuthStatus,
  type UpstreamHttpAuthConfig,
  type UpstreamMcpConfig,
} from "./index.js";

/**
 * Host-specific projection policy for HTTP MCP auth state.
 *
 * This is not mutable state and it does not perform OAuth. It only tells the
 * shared auth core how to build host-specific URLs and user-facing messages.
 */
export class AuthCoordinatorPolicy extends Context.Tag(
  "@ptools/AuthCoordinatorPolicy",
)<
  AuthCoordinatorPolicy,
  {
    /** Public origin for this host's auth surface. */
    readonly origin: string;
    /** Human-facing auth center/root URL for this host. */
    readonly authUrl: string;
    /**
     * Default OAuth redirect callback URL for an HTTP MCP server.
     *
     * This is the host-specific default. It can be overridden per server
     * via `auth.redirectUri` in the MCP server config (see HttpMcpAuthConfig).
     */
    readonly callbackUrl: (serverName: string) => string;
    /** Human-facing setup URL for manual OAuth client configuration. */
    readonly setupUrl: (serverName: string) => string;
    /** Human-facing URL that starts authorization for an HTTP MCP server. */
    readonly authorizeUrl: (serverName: string) => string;
    /** Human-facing URL that forces reauthorization for an HTTP MCP server. */
    readonly reauthorizeUrl: (serverName: string) => string;
    /** Message shown when an HTTP MCP server requires OAuth authorization. */
    readonly authRequiredMessage: (serverName: string) => string;
    /** Message shown when dynamic OAuth client registration is unsupported. */
    readonly dynamicClientRegistrationUnsupportedMessage: (
      serverName: string,
    ) => string;
  }
>() {}

export interface AuthCoordinatorOAuthProvider extends OAuthClientProvider {
  /**
   * Host-specific credential probe used by the shared core.
   *
   * Credential persistence itself remains in the host provider implementation.
   */
  readonly hasStoredCredentials: () => Effect.Effect<boolean, CredentialError>;
}

/**
 * Host-specific factory for MCP SDK OAuth providers.
 *
 * The shared core decides when a provider is needed and caches it. The host
 * decides how that provider is constructed because credential storage,
 * callback state, and redirect behavior differ per platform.
 */
export class AuthProviderFactory extends Context.Tag(
  "@ptools/AuthProviderFactory",
)<
  AuthProviderFactory,
  {
    /**
     * Create an OAuthClientProvider for one resolved HTTP MCP config.
     *
     * serverName: internal runtime server name.
     * config: resolved HTTP MCP config.
     * onAuthorizationUrl: callback invoked by the provider when it receives an
     * authorization URL; the core records that URL into public auth status.
     */
    readonly makeProvider: (input: {
      readonly serverName: string;
      readonly config: HttpMcpConfig;
      readonly onAuthorizationUrl: (
        authorizationUrl: URL,
      ) => Effect.Effect<void, AuthError>;
    }) => Effect.Effect<AuthCoordinatorOAuthProvider, AuthError>;
  }
>() {}

/**
 * Shared HTTP MCP auth state machine.
 *
 * Implemented once in @ptools/auth. Created once per host runtime layer graph.
 * It owns only in-memory runtime coordination state; host providers own
 * credential persistence.
 */
export class AuthCoordinatorCore extends Context.Tag(
  "@ptools/AuthCoordinatorCore",
)<
  AuthCoordinatorCore,
  {
    /** Return AuthCoordinatorPolicy.origin. */
    readonly origin: Effect.Effect<string, AuthError>;
    /** Build callback URL for serverName through policy.callbackUrl. */
    readonly callbackUrl: (
      serverName: string,
    ) => Effect.Effect<string, AuthError>;
    /** Return the configured HTTP MCP config for host OAuth flows. */
    readonly httpConfigFor: (
      serverName: string,
    ) => Effect.Effect<HttpMcpConfig, AuthError>;
    /**
     * Reconcile the auth core with the latest authoritative server config.
     *
     * HTTP configs replace the previous runtime auth record and invalidate any
     * cached OAuth provider so its next use observes the new URL/auth config.
     * Non-HTTP configs remove stale HTTP auth state while remaining known to
     * the core, allowing later connection lifecycle events to be ignored.
     */
    readonly noteConfigured: (
      serverName: string,
      jsServerName: string,
      config: UpstreamMcpConfig,
    ) => Effect.Effect<void>;
    /** Mark an HTTP server connected and clear pending auth fields. */
    readonly noteConnected: (
      serverName: string,
    ) => Effect.Effect<void, AuthError>;
    /** Record an HTTP connection/auth error. */
    readonly noteConnectionError: (
      serverName: string,
      error: unknown,
    ) => Effect.Effect<void, AuthError>;
    /** Return true when the HTTP connector should attach an OAuth provider. */
    readonly shouldAttachAuthProvider: (
      serverName: string,
    ) => Effect.Effect<boolean>;
    /** Ask the host OAuth provider whether credentials are already stored. */
    readonly hasStoredCredentials: (
      serverName: string,
      config: HttpMcpConfig,
    ) => Effect.Effect<boolean>;
    /** Return the cached OAuth provider or create one through the factory. */
    readonly providerFor: (
      serverName: string,
      config: HttpMcpConfig,
    ) => Effect.Effect<AuthCoordinatorOAuthProvider, AuthError>;
    /** Project current HTTP auth state into McpAuthStatus. */
    readonly status: Effect.Effect<McpAuthStatus>;
    /** Register callback invoked after a server finishes authorization. */
    readonly setAuthorizedHandler: (
      handler: (serverName: string) => Promise<void>,
    ) => Effect.Effect<void>;
    /** Register callback invoked when a server should be refreshed/reloaded. */
    readonly setRefreshHandler: (
      handler: (serverName: string) => Promise<void>,
    ) => Effect.Effect<void>;
    /** Store latest authorization URL and mark server requires_auth. */
    readonly setAuthorizationUrl: (
      serverName: string,
      authorizationUrl: URL,
    ) => Effect.Effect<void, AuthError>;
    /** Return the latest IdP/provider authorization URL captured for a server. */
    readonly authorizationUrlFor: (
      serverName: string,
    ) => Effect.Effect<string, AuthError>;
    /** Mark a server as waiting for the browser/provider authorization step. */
    readonly markAuthorizationInProgress: (
      serverName: string,
    ) => Effect.Effect<void, AuthError>;
    /** Mark OAuth complete for serverName and invoke authorized handler. */
    readonly markAuthorized: (
      serverName: string,
    ) => Effect.Effect<void, AuthError>;
  }
>() {}

interface AuthServerRecord {
  readonly serverName: string;
  readonly jsServerName: string;
  readonly url: string;
  readonly auth: Option.Option<UpstreamHttpAuthConfig>;
  readonly authState: HttpMcpAuthState;
}

/**
 * Complete runtime auth state for one configured HTTP MCP server.
 *
 * Coordinator operations replace this value atomically. Each variant owns
 * only the information that is valid for that state, so stale URLs, messages,
 * and errors cannot survive a state change through partial record patching.
 */
type HttpMcpAuthState = Data.TaggedEnum<{
  readonly Connected: {};
  readonly StaticCredentials: {};
  readonly AuthorizationRequired: {
    readonly authorizationUrl: Option.Option<string>;
    readonly message: string;
  };
  readonly AuthorizationInProgress: {
    readonly authorizationUrl: string;
    readonly message: string;
  };
  readonly ClientConfigurationRequired: {
    readonly message: string;
    readonly lastError: string;
  };
  readonly ConnectionFailed: {
    readonly lastError: string;
  };
}>;

const HttpMcpAuthState = Data.taggedEnum<HttpMcpAuthState>();

interface AuthCoordinatorCoreSnapshot {
  /** Current HTTP-only auth/status projection, keyed by runtime server name. */
  readonly records: ReadonlyMap<string, AuthServerRecord>;
  /**
   * Providers capture the config supplied when they are constructed, so this
   * cache must be invalidated whenever that server is reconfigured.
   */
  readonly providers: ReadonlyMap<string, AuthCoordinatorOAuthProvider>;
  /** Servers whose connector calls should attach their cached OAuth provider. */
  readonly oauthServers: ReadonlySet<string>;
  /**
   * Configured non-HTTP servers. Tracking these distinguishes an intentional
   * HTTP-auth no-op from an invalid lifecycle event for an unknown server.
   */
  readonly ignoredServers: ReadonlySet<string>;
  readonly authorizedHandler?: (serverName: string) => Promise<void>;
  readonly refreshHandler?: (serverName: string) => Promise<void>;
}

/**
 * Builds one shared in-memory core instance from host policy and provider
 * factory.
 */
export const AuthCoordinatorCoreLayer: Layer.Layer<
  AuthCoordinatorCore,
  never,
  AuthCoordinatorPolicy | AuthProviderFactory
> = Layer.effect(
  AuthCoordinatorCore,
  Effect.gen(function* () {
    const policy = yield* AuthCoordinatorPolicy;
    const providerFactory = yield* AuthProviderFactory;
    const snapshot = yield* SynchronizedRef.make<AuthCoordinatorCoreSnapshot>({
      records: new Map(),
      providers: new Map(),
      oauthServers: new Set(),
      ignoredServers: new Set(),
    });

    const service = AuthCoordinatorCore.of({
      origin: Effect.succeed(policy.origin),
      callbackUrl: (serverName) =>
        // Per-server redirectUri from auth config overrides the host
        // policy default. Used e.g. for custom domains, proxies, and
        // pre-registered OAuth clients with fixed redirect URIs.
        getHttpRecord(snapshot, serverName).pipe(
          Effect.map((record) =>
            Option.getOrElse(
              Option.flatMap(record.auth, (auth) => auth.redirectUri),
              () => policy.callbackUrl(serverName),
            ),
          ),
        ),
      httpConfigFor: (serverName) =>
        getHttpRecord(snapshot, serverName).pipe(
          Effect.map(httpConfigFromRecord),
        ),
      noteConfigured: (serverName, jsServerName, config) =>
        noteConfigured(snapshot, serverName, jsServerName, config),
      noteConnected: (serverName) =>
        updateAuthState(snapshot, serverName, HttpMcpAuthState.Connected()),
      noteConnectionError: (serverName, error) =>
        noteConnectionError(snapshot, policy, serverName, error),
      shouldAttachAuthProvider: (serverName) =>
        SynchronizedRef.get(snapshot).pipe(
          Effect.map((state) => state.oauthServers.has(serverName)),
        ),
      hasStoredCredentials: (serverName, config) =>
        getOrCreateProvider(snapshot, providerFactory, serverName, config, {
          attach: false,
          policy,
        }).pipe(
          Effect.flatMap((provider) => provider.hasStoredCredentials()),
          Effect.tap((hasCredentials) =>
            hasCredentials
              ? markOAuthServer(snapshot, serverName)
              : Effect.void,
          ),
          Effect.catchAll(() => Effect.succeed(false)),
        ),
      providerFor: (serverName, config) =>
        getOrCreateProvider(snapshot, providerFactory, serverName, config, {
          attach: true,
          policy,
        }),
      status: authStatus(snapshot, policy),
      setAuthorizedHandler: (handler) =>
        SynchronizedRef.update(snapshot, (state) => ({
          ...state,
          authorizedHandler: handler,
        })),
      setRefreshHandler: (handler) =>
        SynchronizedRef.update(snapshot, (state) => ({
          ...state,
          refreshHandler: handler,
        })),
      setAuthorizationUrl: (serverName, authorizationUrl) =>
        updateAuthState(
          snapshot,
          serverName,
          HttpMcpAuthState.AuthorizationRequired({
            authorizationUrl: Option.some(authorizationUrl.toString()),
            message: policy.authRequiredMessage(serverName),
          }),
        ),
      authorizationUrlFor: (serverName) =>
        getHttpRecord(snapshot, serverName).pipe(
          Effect.flatMap((record) =>
            Option.match(getAuthorizationUrl(record.authState), {
              onNone: () =>
                Effect.fail(
                  new AuthError({
                    message: `OAuth authorization URL was not produced for ${serverName}.`,
                  }),
                ),
              onSome: Effect.succeed,
            }),
          ),
        ),
      markAuthorizationInProgress: (serverName) =>
        markAuthorizationInProgress(snapshot, serverName),
      markAuthorized: (serverName) => markAuthorized(snapshot, serverName),
    });

    return service;
  }),
);

/**
 * Replaces all derived runtime auth state for one authoritative config entry.
 *
 * This intentionally does not try to preserve a provider or previous status:
 * providers close over their construction config, and status fields describe
 * the previous connection attempt. Keeping either after a config change could
 * use stale credentials, URLs, or OAuth client metadata.
 */
const noteConfigured = (
  snapshot: SynchronizedRef.SynchronizedRef<AuthCoordinatorCoreSnapshot>,
  serverName: string,
  jsServerName: string,
  config: UpstreamMcpConfig,
): Effect.Effect<void> => {
  if (config.transport !== "http") {
    return SynchronizedRef.update(snapshot, (state) => ({
      ...state,
      // A transport change from HTTP must remove every HTTP-only derivative.
      records: removeKey(state.records, serverName),
      providers: removeKey(state.providers, serverName),
      oauthServers: removeSetValue(state.oauthServers, serverName),
      // Preserve knowledge that this is configured, so later registry
      // lifecycle events are intentional no-ops rather than unknown-server
      // contract failures.
      ignoredServers: new Set(state.ignoredServers).add(serverName),
    }));
  }

  return SynchronizedRef.update(snapshot, (state) => {
    const hasStaticHeaders = Option.exists(
      config.headers,
      (headers) => Object.keys(headers).length > 0,
    );

    return {
      ...state,
      // OAuth providers capture URL/auth/client metadata at construction time.
      // Removing both entries forces the connector to create and explicitly
      // attach a provider from this latest config on its next auth attempt.
      providers: removeKey(state.providers, serverName),
      oauthServers: removeSetValue(state.oauthServers, serverName),
      ignoredServers: removeSetValue(state.ignoredServers, serverName),
      // Replace rather than merge the record. Authorization URLs, errors, and
      // messages belong to the old config/connection attempt and must not leak
      // into the newly configured state.
      records: new Map(state.records).set(serverName, {
        serverName,
        jsServerName,
        url: config.url,
        auth: config.auth,
        authState: hasStaticHeaders
          ? HttpMcpAuthState.StaticCredentials()
          : HttpMcpAuthState.Connected(),
      }),
    };
  });
};

const noteConnectionError = (
  snapshot: SynchronizedRef.SynchronizedRef<AuthCoordinatorCoreSnapshot>,
  policy: Context.Tag.Service<typeof AuthCoordinatorPolicy>,
  serverName: string,
  error: unknown,
): Effect.Effect<void, AuthError> => {
  if (isDynamicClientRegistrationUnsupported(error)) {
    return updateAuthState(
      snapshot,
      serverName,
      HttpMcpAuthState.ClientConfigurationRequired({
        message: policy.dynamicClientRegistrationUnsupportedMessage(serverName),
        lastError: safeErrorMessage(error),
      }),
    );
  }

  if (isAuthRequiredError(error)) {
    return updateAuthState(
      snapshot,
      serverName,
      HttpMcpAuthState.AuthorizationRequired({
        authorizationUrl: Option.none(),
        message: policy.authRequiredMessage(serverName),
      }),
    );
  }

  return updateAuthState(
    snapshot,
    serverName,
    HttpMcpAuthState.ConnectionFailed({
      lastError: safeErrorMessage(error),
    }),
  );
};

const getOrCreateProvider = (
  snapshot: SynchronizedRef.SynchronizedRef<AuthCoordinatorCoreSnapshot>,
  providerFactory: Context.Tag.Service<typeof AuthProviderFactory>,
  serverName: string,
  config: HttpMcpConfig,
  options: {
    readonly attach: boolean;
    readonly policy: Context.Tag.Service<typeof AuthCoordinatorPolicy>;
  },
): Effect.Effect<AuthCoordinatorOAuthProvider, AuthError> =>
  // Provider lookup/creation and cache publication happen under one
  // SynchronizedRef modification, preventing concurrent callers from
  // constructing and publishing different providers for the same server.
  SynchronizedRef.modifyEffect(snapshot, (state) => {
    const existing = state.providers.get(serverName);

    if (existing !== undefined) {
      const nextState =
        options.attach && !state.oauthServers.has(serverName)
          ? {
              ...state,
              oauthServers: new Set(state.oauthServers).add(serverName),
            }
          : state;

      return Effect.succeed([existing, nextState] as const);
    }

    return providerFactory
      .makeProvider({
        serverName,
        config,
        onAuthorizationUrl: (authorizationUrl) =>
          updateAuthState(
            snapshot,
            serverName,
            HttpMcpAuthState.AuthorizationRequired({
              authorizationUrl: Option.some(authorizationUrl.toString()),
              message: options.policy.authRequiredMessage(serverName),
            }),
          ),
      })
      .pipe(
        Effect.map(
          (provider) =>
            [
              provider,
              {
                ...state,
                providers: new Map(state.providers).set(serverName, provider),
                ...(options.attach
                  ? {
                      oauthServers: new Set(state.oauthServers).add(serverName),
                    }
                  : {}),
              },
            ] as const,
        ),
      );
  });

const markOAuthServer = (
  snapshot: SynchronizedRef.SynchronizedRef<AuthCoordinatorCoreSnapshot>,
  serverName: string,
): Effect.Effect<void> =>
  SynchronizedRef.update(snapshot, (state) => ({
    ...state,
    oauthServers: new Set(state.oauthServers).add(serverName),
  }));

const getHttpRecord = (
  snapshot: SynchronizedRef.SynchronizedRef<AuthCoordinatorCoreSnapshot>,
  serverName: string,
): Effect.Effect<AuthServerRecord, AuthError> =>
  SynchronizedRef.get(snapshot).pipe(
    Effect.flatMap((state) => {
      const record = state.records.get(serverName);

      return record === undefined
        ? Effect.fail(
            new AuthError({
              message: `No HTTP MCP server named ${serverName} is configured.`,
            }),
          )
        : Effect.succeed(record);
    }),
  );

/**
 * Atomically replaces one server's complete runtime auth state.
 *
 * Callers provide a named state variant rather than a partial record patch.
 * Stable server identity and resolved HTTP config remain unchanged.
 */
const updateAuthState = (
  snapshot: SynchronizedRef.SynchronizedRef<AuthCoordinatorCoreSnapshot>,
  serverName: string,
  authState: HttpMcpAuthState,
): Effect.Effect<void, AuthError> =>
  SynchronizedRef.modifyEffect(snapshot, (state) => {
    const record = state.records.get(serverName);

    if (record === undefined) {
      if (state.ignoredServers.has(serverName)) {
        // Registry lifecycle events also apply to stdio servers, but this core
        // deliberately coordinates HTTP MCP auth only.
        return Effect.succeed([undefined, state] as const);
      }

      return Effect.fail(unconfiguredHttpServerError(serverName));
    }

    return Effect.succeed([
      undefined,
      {
        ...state,
        records: new Map(state.records).set(serverName, {
          ...record,
          authState,
        }),
      },
    ] as const);
  });

const markAuthorizationInProgress = (
  snapshot: SynchronizedRef.SynchronizedRef<AuthCoordinatorCoreSnapshot>,
  serverName: string,
): Effect.Effect<void, AuthError> =>
  SynchronizedRef.modifyEffect(snapshot, (state) => {
    const record = state.records.get(serverName);

    if (record === undefined) {
      if (state.ignoredServers.has(serverName)) {
        return Effect.succeed([undefined, state] as const);
      }

      return Effect.fail(unconfiguredHttpServerError(serverName));
    }

    return Option.match(getAuthorizationUrl(record.authState), {
      onNone: () =>
        Effect.fail(
          new AuthError({
            message: `OAuth authorization URL was not produced for ${serverName}.`,
          }),
        ),
      onSome: (authorizationUrl) =>
        Effect.succeed([
          undefined,
          {
            ...state,
            records: new Map(state.records).set(serverName, {
              ...record,
              authState: HttpMcpAuthState.AuthorizationInProgress({
                authorizationUrl,
                message: `Waiting for authorization for ${serverName}.`,
              }),
            }),
          },
        ] as const),
    });
  });

const markAuthorized = (
  snapshot: SynchronizedRef.SynchronizedRef<AuthCoordinatorCoreSnapshot>,
  serverName: string,
): Effect.Effect<void, AuthError> =>
  Effect.gen(function* () {
    const handler = yield* SynchronizedRef.modifyEffect(snapshot, (state) => {
      const record = state.records.get(serverName);

      if (record === undefined) {
        return Effect.fail(unconfiguredHttpServerError(serverName));
      }

      return Effect.succeed([
        state.authorizedHandler,
        {
          ...state,
          oauthServers: new Set(state.oauthServers).add(serverName),
          records: new Map(state.records).set(serverName, {
            ...record,
            authState: HttpMcpAuthState.Connected(),
          }),
        },
      ] as const);
    });

    // Publish the connected state before invoking host work such as reconnect
    // or refresh. The handler runs outside the synchronized state update and
    // may safely call back into the coordinator.
    if (handler !== undefined) {
      yield* Effect.promise(() => handler(serverName));
    }
  });

const authStatus = (
  snapshot: SynchronizedRef.SynchronizedRef<AuthCoordinatorCoreSnapshot>,
  policy: Context.Tag.Service<typeof AuthCoordinatorPolicy>,
): Effect.Effect<McpAuthStatus> =>
  SynchronizedRef.get(snapshot).pipe(
    Effect.map((state) => ({
      authUrl: policy.authUrl,
      servers: [...state.records.values()].map((record) =>
        toPublicStatus(policy, record),
      ),
    })),
  );

const toPublicStatus = (
  policy: Context.Tag.Service<typeof AuthCoordinatorPolicy>,
  record: AuthServerRecord,
): McpAuthServerStatus => ({
  serverName: record.serverName,
  jsServerName: record.jsServerName,
  transport: "http",
  authUrl: policy.authUrl,
  ...publicStatusFields(policy, record.serverName, record.authState),
});

type PublicAuthStatusFields = Pick<
  McpAuthServerStatus,
  | "status"
  | "authorizeUrl"
  | "reauthorizeUrl"
  | "setupUrl"
  | "message"
  | "lastError"
>;

/**
 * Projects one internal auth-state variant into its complete public fields.
 *
 * Each state owns its URL, message, and error rules. This avoids rebuilding
 * those rules later from loose optional fields and status-condition checks.
 */
const publicStatusFields = (
  policy: Context.Tag.Service<typeof AuthCoordinatorPolicy>,
  serverName: string,
  state: HttpMcpAuthState,
): PublicAuthStatusFields =>
  HttpMcpAuthState.$match(state, {
    Connected: (): PublicAuthStatusFields => ({
      status: "connected",
      reauthorizeUrl: policy.reauthorizeUrl(serverName),
    }),
    StaticCredentials: (): PublicAuthStatusFields => ({
      status: "static_credentials",
    }),
    AuthorizationRequired: ({ message }): PublicAuthStatusFields => ({
      status: "requires_auth",
      authorizeUrl: policy.authorizeUrl(serverName),
      reauthorizeUrl: policy.reauthorizeUrl(serverName),
      message,
    }),
    AuthorizationInProgress: ({ message }): PublicAuthStatusFields => ({
      status: "auth_in_progress",
      authorizeUrl: policy.authorizeUrl(serverName),
      reauthorizeUrl: policy.reauthorizeUrl(serverName),
      message,
    }),
    ClientConfigurationRequired: ({
      message,
      lastError,
    }): PublicAuthStatusFields => ({
      status: "needs_config",
      setupUrl: policy.setupUrl(serverName),
      message,
      lastError,
    }),
    ConnectionFailed: ({ lastError }): PublicAuthStatusFields => ({
      status: "auth_failed",
      authorizeUrl: policy.authorizeUrl(serverName),
      reauthorizeUrl: policy.reauthorizeUrl(serverName),
      lastError,
    }),
  });

const getAuthorizationUrl = (state: HttpMcpAuthState): Option.Option<string> =>
  HttpMcpAuthState.$match(state, {
    Connected: Option.none,
    StaticCredentials: Option.none,
    AuthorizationRequired: ({ authorizationUrl }) => authorizationUrl,
    AuthorizationInProgress: ({ authorizationUrl }) =>
      Option.some(authorizationUrl),
    ClientConfigurationRequired: Option.none,
    ConnectionFailed: Option.none,
  });

const httpConfigFromRecord = (record: AuthServerRecord): HttpMcpConfig =>
  ResolvedHttpMcpConfig.make({
    url: record.url,
    headers: Option.none(),
    auth: record.auth,
  });

const unconfiguredHttpServerError = (serverName: string): AuthError =>
  new AuthError({
    message: `No HTTP MCP server named ${serverName} is configured.`,
  });

const removeKey = <K, V>(map: ReadonlyMap<K, V>, key: K): ReadonlyMap<K, V> => {
  if (!map.has(key)) {
    return map;
  }

  const next = new Map(map);
  next.delete(key);
  return next;
};

const removeSetValue = <T>(set: ReadonlySet<T>, value: T): ReadonlySet<T> => {
  if (!set.has(value)) {
    return set;
  }

  const next = new Set(set);
  next.delete(value);
  return next;
};
