import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { HostIdentity } from "@ptools/host-context";
import { Context, Data, Effect, Layer, Option } from "effect";
import {
  type AuthCoordinatorOAuthProvider,
  AuthCoordinatorPolicy,
  AuthProviderFactory,
} from "../coordinatorCore.js";
import { AuthError, CredentialError } from "../authErrors.js";
import type { HttpMcpConfig } from "../authTypes.js";
import {
  McpOAuthCredentialStore,
  type McpOAuthCredentialIdentity,
  type McpOAuthCredentialInvalidationScope,
} from "./mcpOAuthCredentialStore.js";
import { McpOAuthStateStore } from "./mcpOAuthStateStore.js";

type McpOAuthProviderServices = McpOAuthCredentialStore | McpOAuthStateStore;

/**
 * Shared factory for MCP SDK OAuth providers.
 *
 * It needs shared stores, stable host identity, and the host-provided auth URL
 * policy. Platform packages should not reimplement provider credential keys,
 * state signing, or MCP SDK provider behavior.
 */
export const McpOAuthProviderFactoryLayer: Layer.Layer<
  AuthProviderFactory,
  never,
  | McpOAuthCredentialStore
  | McpOAuthStateStore
  | HostIdentity
  | AuthCoordinatorPolicy
> = Layer.effect(
  AuthProviderFactory,
  Effect.gen(function* () {
    const identity = yield* HostIdentity;
    const policy = yield* AuthCoordinatorPolicy;
    const services = yield* Effect.context<McpOAuthProviderServices>();

    return AuthProviderFactory.of({
      makeProvider: (input) =>
        Effect.succeed(
          new McpOAuthProvider({
            serverName: input.serverName,
            config: input.config,
            callbackUrl: policy.callbackUrl,
            operations: makeMcpOAuthProviderOperations({
              services,
              hostId: identity.hostId,
              serverName: input.serverName,
              serverUrl: input.config.url,
              onAuthorizationUrl: input.onAuthorizationUrl,
            }),
          }),
        ),
    });
  }),
);

/**
 * Identity-bound operations used by the plain-JavaScript MCP SDK adapter.
 *
 * The factory creates these callbacks while it has access to the configured
 * Effect services. The provider can therefore implement the SDK contract
 * without retaining a broad Effect context or the underlying stores.
 */
export interface McpOAuthProviderOperations {
  readonly createState: () => Promise<string>;
  readonly getClientInformation: () => Promise<
    OAuthClientInformationMixed | undefined
  >;
  readonly setClientInformation: (
    clientInformation: OAuthClientInformationMixed,
  ) => Promise<void>;
  readonly getTokens: () => Promise<OAuthTokens | undefined>;
  readonly setTokens: (tokens: OAuthTokens) => Promise<void>;
  readonly hasStoredCredentials: () => Effect.Effect<boolean, CredentialError>;
  readonly notifyAuthorizationUrl: (authorizationUrl: URL) => void;
  readonly setCodeVerifier: (codeVerifier: string) => Promise<void>;
  readonly getCodeVerifier: () => Promise<string>;
  readonly invalidateCredentials: (
    scope: McpOAuthCredentialInvalidationScope,
  ) => Promise<void>;
  readonly setDiscoveryState: (state: OAuthDiscoveryState) => Promise<void>;
  readonly getDiscoveryState: () => Promise<OAuthDiscoveryState | undefined>;
}

/** Bind one provider identity to the already-built, typed Effect context. */
const makeMcpOAuthProviderOperations = (options: {
  readonly services: Context.Context<McpOAuthProviderServices>;
  readonly hostId: string;
  readonly serverName: string;
  readonly serverUrl: string;
  readonly onAuthorizationUrl: (
    authorizationUrl: URL,
  ) => Effect.Effect<void, AuthError>;
}): McpOAuthProviderOperations => {
  const credentialIdentity: McpOAuthCredentialIdentity = {
    serverName: options.serverName,
    serverUrl: options.serverUrl,
  };
  const runPromise = Effect.runPromiseWith(options.services);
  const runSync = Effect.runSyncWith(options.services);
  const withServices = Effect.provide(options.services);

  return {
    createState: () =>
      runPromise(
        Effect.gen(function* () {
          const oauthStateStore = yield* McpOAuthStateStore;

          return yield* oauthStateStore.sign({
            payload: {
              provider: options.serverName,
              hostId: options.hostId,
              serverName: options.serverName,
              nonce: crypto.randomUUID(),
              issuedAt: new Date().toISOString(),
              expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
            },
          });
        }),
      ),
    getClientInformation: () =>
      runPromise(
        Effect.gen(function* () {
          const oauthCredentials = yield* McpOAuthCredentialStore;
          return yield* oauthCredentials
            .getClientInformation(credentialIdentity)
            .pipe(Effect.map(Option.getOrUndefined));
        }),
      ),
    setClientInformation: (clientInformation) =>
      runPromise(
        Effect.gen(function* () {
          const oauthCredentials = yield* McpOAuthCredentialStore;
          return yield* oauthCredentials.setClientInformation(
            credentialIdentity,
            clientInformation,
          );
        }),
      ),
    getTokens: () =>
      runPromise(
        Effect.gen(function* () {
          const oauthCredentials = yield* McpOAuthCredentialStore;
          return yield* oauthCredentials
            .getTokens(credentialIdentity)
            .pipe(Effect.map(Option.getOrUndefined));
        }),
      ),
    setTokens: (tokens) =>
      runPromise(
        Effect.gen(function* () {
          const oauthCredentials = yield* McpOAuthCredentialStore;
          return yield* oauthCredentials.setTokens(credentialIdentity, tokens);
        }),
      ),
    hasStoredCredentials: () =>
      Effect.gen(function* () {
        const oauthCredentials = yield* McpOAuthCredentialStore;
        return yield* oauthCredentials.hasStoredCredentials(credentialIdentity);
      }).pipe(withServices),
    notifyAuthorizationUrl: (authorizationUrl) => {
      runSync(options.onAuthorizationUrl(authorizationUrl));
    },
    setCodeVerifier: (codeVerifier) =>
      runPromise(
        Effect.gen(function* () {
          const oauthCredentials = yield* McpOAuthCredentialStore;
          return yield* oauthCredentials.setCodeVerifier(
            credentialIdentity,
            codeVerifier,
          );
        }),
      ),
    getCodeVerifier: () =>
      runPromise(
        Effect.gen(function* () {
          const oauthCredentials = yield* McpOAuthCredentialStore;
          return yield* oauthCredentials.getCodeVerifier(credentialIdentity);
        }),
      ),
    invalidateCredentials: (scope) =>
      runPromise(
        Effect.gen(function* () {
          const oauthCredentials = yield* McpOAuthCredentialStore;
          return yield* oauthCredentials.invalidate(credentialIdentity, scope);
        }),
      ),
    setDiscoveryState: (state) =>
      runPromise(
        Effect.gen(function* () {
          const oauthCredentials = yield* McpOAuthCredentialStore;
          return yield* oauthCredentials.setDiscoveryState(
            credentialIdentity,
            state,
          );
        }),
      ),
    getDiscoveryState: () =>
      runPromise(
        Effect.gen(function* () {
          const oauthCredentials = yield* McpOAuthCredentialStore;
          return yield* oauthCredentials
            .getDiscoveryState(credentialIdentity)
            .pipe(Effect.map(Option.getOrUndefined));
        }),
      ),
  };
};

/** MCP SDK OAuth provider adapter for one configured HTTP MCP server. */
export class McpOAuthProvider implements AuthCoordinatorOAuthProvider {
  readonly #operations: McpOAuthProviderOperations;
  readonly #callbackUrl: (serverName: string) => string;
  readonly #serverName: string;
  readonly #auth: OAuthProviderAuth;
  readonly clientMetadataUrl?: string;

  constructor(options: {
    readonly operations: McpOAuthProviderOperations;
    readonly callbackUrl: (serverName: string) => string;
    readonly serverName: string;
    readonly config: HttpMcpConfig;
  }) {
    this.#operations = options.operations;
    this.#callbackUrl = options.callbackUrl;
    this.#serverName = options.serverName;
    this.#auth = makeOAuthProviderAuth(options.config);

    const clientMetadataUrl = Option.flatMap(
      options.config.auth,
      (authConfig) => authConfig.clientMetadataUrl,
    );
    if (Option.isSome(clientMetadataUrl)) {
      this.clientMetadataUrl = clientMetadataUrl.value;
    }
  }

  get redirectUrl(): string {
    return redirectUrlFor(
      { callbackUrl: this.#callbackUrl },
      this.#serverName,
      this.#auth.redirectUri,
    );
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.redirectUrl],
      token_endpoint_auth_method: ClientRegistration.$match(
        this.#auth.clientRegistration,
        {
          Dynamic: () => "none" as const,
          PreRegistered: ({ clientSecret }) =>
            Option.isNone(clientSecret) ? "none" : "client_secret_basic",
        },
      ),
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: "ptools",
      ...Option.match(this.#auth.scope, {
        onNone: () => ({}),
        onSome: (scope) => ({ scope }),
      }),
    };
  }

  state(): Promise<string> {
    return this.#operations.createState();
  }

  clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    return ClientRegistration.$match(this.#auth.clientRegistration, {
      Dynamic: this.#operations.getClientInformation,
      PreRegistered: ({ clientId, clientSecret }) =>
        Promise.resolve({
          client_id: clientId,
          ...Option.match(clientSecret, {
            onNone: () => ({}),
            onSome: (client_secret) => ({ client_secret }),
          }),
        }),
    });
  }

  saveClientInformation(
    clientInformation: OAuthClientInformationMixed,
  ): Promise<void> {
    return this.#operations.setClientInformation(clientInformation);
  }

  tokens(): Promise<OAuthTokens | undefined> {
    return this.#operations.getTokens();
  }

  saveTokens(tokens: OAuthTokens): Promise<void> {
    return this.#operations.setTokens(tokens);
  }

  hasStoredCredentials() {
    return this.#operations.hasStoredCredentials();
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    this.#operations.notifyAuthorizationUrl(authorizationUrl);
  }

  saveCodeVerifier(codeVerifier: string): Promise<void> {
    return this.#operations.setCodeVerifier(codeVerifier);
  }

  codeVerifier(): Promise<string> {
    return this.#operations.getCodeVerifier();
  }

  invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): Promise<void> {
    return this.#operations.invalidateCredentials(scope);
  }

  saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    return this.#operations.setDiscoveryState(state);
  }

  discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return this.#operations.getDiscoveryState();
  }
}

type ClientRegistration = Data.TaggedEnum<{
  readonly Dynamic: {};
  readonly PreRegistered: {
    readonly clientId: string;
    readonly clientSecret: Option.Option<string>;
  };
}>;

const ClientRegistration = Data.taggedEnum<ClientRegistration>();

interface OAuthProviderAuth {
  readonly scope: Option.Option<string>;
  readonly redirectUri: Option.Option<string>;
  readonly clientRegistration: ClientRegistration;
}

const makeOAuthProviderAuth = (config: HttpMcpConfig): OAuthProviderAuth => {
  const auth = config.auth;
  const clientId = auth.pipe(Option.flatMap((value) => value.clientId));

  return {
    scope: auth.pipe(Option.flatMap((value) => value.scope)),
    redirectUri: auth.pipe(Option.flatMap((value) => value.redirectUri)),
    clientRegistration: Option.match(clientId, {
      onNone: ClientRegistration.Dynamic,
      onSome: (value) =>
        ClientRegistration.PreRegistered({
          clientId: value,
          clientSecret: auth.pipe(
            Option.flatMap((configAuth) => configAuth.clientSecret),
          ),
        }),
    }),
  };
};

export const redirectUrlFor = (
  dependencies: {
    readonly callbackUrl: (serverName: string) => string;
  },
  serverName: string,
  redirectUri: Option.Option<string>,
): string =>
  Option.getOrElse(redirectUri, () => dependencies.callbackUrl(serverName));
