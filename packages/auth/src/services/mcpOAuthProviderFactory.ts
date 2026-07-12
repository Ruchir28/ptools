import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { HostIdentity } from "@ptools/host-context";
import { Data, Effect, Layer, Option, Runtime } from "effect";
import {
  type AuthCoordinatorOAuthProvider,
  AuthCoordinatorPolicy,
  AuthProviderFactory,
} from "../coordinatorCore.js";
import { AuthError } from "../authErrors.js";
import type { HttpMcpConfig } from "../authTypes.js";
import {
  McpOAuthCredentialStore,
  type McpOAuthCredentialIdentity,
  type McpOAuthCredentialStoreService,
} from "./mcpOAuthCredentialStore.js";
import {
  McpOAuthStateStore,
  type McpOAuthStateStoreService,
} from "./mcpOAuthStateStore.js";

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
    const oauthCredentials = yield* McpOAuthCredentialStore;
    const oauthStateStore = yield* McpOAuthStateStore;
    const identity = yield* HostIdentity;
    const policy = yield* AuthCoordinatorPolicy;
    const runtime = yield* Effect.runtime<never>();
    const dependencies: McpOAuthProviderDependencies = {
      oauthCredentials,
      oauthStateStore,
      hostId: identity.hostId,
      callbackUrl: policy.callbackUrl,
      runtime,
    };

    return AuthProviderFactory.of({
      makeProvider: (input) =>
        Effect.succeed(
          new McpOAuthProvider({
            dependencies,
            serverName: input.serverName,
            config: input.config,
            onAuthorizationUrl: input.onAuthorizationUrl,
          }),
        ),
    });
  }),
);

export interface McpOAuthProviderDependencies {
  readonly oauthCredentials: ContextMcpOAuthCredentialStore;
  readonly oauthStateStore: ContextMcpOAuthStateStore;
  readonly hostId: string;
  readonly callbackUrl: (serverName: string) => string;
  /** Runtime captured when the configured auth layer is built. */
  readonly runtime: Runtime.Runtime<never>;
}

type ContextMcpOAuthCredentialStore = McpOAuthCredentialStoreService;
type ContextMcpOAuthStateStore = McpOAuthStateStoreService;

/** MCP SDK OAuth provider adapter for one configured HTTP MCP server. */
export class McpOAuthProvider implements AuthCoordinatorOAuthProvider {
  readonly #dependencies: McpOAuthProviderDependencies;
  readonly #serverName: string;
  readonly #serverUrl: string;
  readonly #auth: OAuthProviderAuth;
  readonly #onAuthorizationUrl: (
    authorizationUrl: URL,
  ) => Effect.Effect<void, AuthError>;
  readonly clientMetadataUrl?: string;

  constructor(options: {
    readonly dependencies: McpOAuthProviderDependencies;
    readonly serverName: string;
    readonly config: HttpMcpConfig;
    readonly onAuthorizationUrl: (
      authorizationUrl: URL,
    ) => Effect.Effect<void, AuthError>;
  }) {
    this.#dependencies = options.dependencies;
    this.#serverName = options.serverName;
    this.#serverUrl = options.config.url;
    this.#auth = makeOAuthProviderAuth(options.config);
    this.#onAuthorizationUrl = options.onAuthorizationUrl;

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
      this.#dependencies,
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
    return Runtime.runPromise(
      this.#dependencies.runtime,
      this.#dependencies.oauthStateStore.sign({
        payload: {
          provider: this.#serverName,
          hostId: this.#dependencies.hostId,
          serverName: this.#serverName,
          nonce: crypto.randomUUID(),
          issuedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        },
      }),
    );
  }

  clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    return ClientRegistration.$match(this.#auth.clientRegistration, {
      Dynamic: () =>
        Runtime.runPromise(
          this.#dependencies.runtime,
          this.#dependencies.oauthCredentials
            .getClientInformation(this.#credentialIdentity())
            .pipe(Effect.map(Option.getOrUndefined)),
        ),
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
    return Runtime.runPromise(
      this.#dependencies.runtime,
      this.#dependencies.oauthCredentials.setClientInformation(
        this.#credentialIdentity(),
        clientInformation,
      ),
    );
  }

  tokens(): Promise<OAuthTokens | undefined> {
    return Runtime.runPromise(
      this.#dependencies.runtime,
      this.#dependencies.oauthCredentials
        .getTokens(this.#credentialIdentity())
        .pipe(Effect.map(Option.getOrUndefined)),
    );
  }

  saveTokens(tokens: OAuthTokens): Promise<void> {
    return Runtime.runPromise(
      this.#dependencies.runtime,
      this.#dependencies.oauthCredentials.setTokens(
        this.#credentialIdentity(),
        tokens,
      ),
    );
  }

  hasStoredCredentials() {
    return this.#dependencies.oauthCredentials.hasStoredCredentials(
      this.#credentialIdentity(),
    );
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    Runtime.runSync(
      this.#dependencies.runtime,
      this.#onAuthorizationUrl(authorizationUrl),
    );
  }

  saveCodeVerifier(codeVerifier: string): Promise<void> {
    return Runtime.runPromise(
      this.#dependencies.runtime,
      this.#dependencies.oauthCredentials.setCodeVerifier(
        this.#credentialIdentity(),
        codeVerifier,
      ),
    );
  }

  codeVerifier(): Promise<string> {
    return Runtime.runPromise(
      this.#dependencies.runtime,
      this.#dependencies.oauthCredentials.getCodeVerifier(
        this.#credentialIdentity(),
      ),
    );
  }

  invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): Promise<void> {
    return Runtime.runPromise(
      this.#dependencies.runtime,
      this.#dependencies.oauthCredentials.invalidate(
        this.#credentialIdentity(),
        scope,
      ),
    );
  }

  saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    return Runtime.runPromise(
      this.#dependencies.runtime,
      this.#dependencies.oauthCredentials.setDiscoveryState(
        this.#credentialIdentity(),
        state,
      ),
    );
  }

  discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return Runtime.runPromise(
      this.#dependencies.runtime,
      this.#dependencies.oauthCredentials
        .getDiscoveryState(this.#credentialIdentity())
        .pipe(Effect.map(Option.getOrUndefined)),
    );
  }

  #credentialIdentity(): McpOAuthCredentialIdentity {
    return {
      serverName: this.#serverName,
      serverUrl: this.#serverUrl,
    };
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
  dependencies: Pick<McpOAuthProviderDependencies, "callbackUrl">,
  serverName: string,
  redirectUri: Option.Option<string>,
): string =>
  Option.getOrElse(redirectUri, () => dependencies.callbackUrl(serverName));
