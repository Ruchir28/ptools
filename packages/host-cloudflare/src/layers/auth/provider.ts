import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  AuthError,
  CredentialError,
  type AuthCoordinatorOAuthProvider,
  type HttpMcpConfig,
} from "@ptools/auth";
import { Data, Effect, Option } from "effect";
import {
  codeModeObjectCredentialClientKey,
  codeModeObjectCredentialDiscoveryKey,
  codeModeObjectCredentialPkceVerifierKey,
  codeModeObjectCredentialTokensKey,
} from "./keys.js";
import { signOAuthState } from "./oauthState.js";
import type { CloudflareOAuthPlatform } from "./types.js";

/**
 * MCP SDK OAuth provider adapter for one configured HTTP MCP server.
 *
 * Parameters:
 * - platform: private platform facts containing host identity, DO storage, and
 *   CredentialsStore.
 * - serverName: ptools MCP server name.
 * - config: resolved HTTP MCP config for this server.
 * - onAuthorizationUrl: callback used by the coordinator to record the URL
 *   produced by the SDK without making the provider import coordinator state
 *   mutation helpers.
 */
export class CloudflareOAuthProvider implements AuthCoordinatorOAuthProvider {
  readonly #platform: CloudflareOAuthPlatform;
  readonly #serverName: string;
  readonly #auth: OAuthProviderAuth;
  /**
   * Callback invoked when the MCP SDK has produced an Identity Provider (IdP)
   * authorization URL (e.g. GitHub login page). The coordinator uses this to
   * capture the URL so it can be returned to the browser for a 302 redirect.
   */
  readonly #onAuthorizationUrl: (
    authorizationUrl: URL,
  ) => Effect.Effect<void, AuthError>;

  /**
   * Optional URL pointing to a JSON document describing this OAuth client.
   * Used for Dynamic Client Registration (RFC 7591) if the MCP server supports it.
   */
  readonly clientMetadataUrl?: string;

  constructor(options: {
    readonly platform: CloudflareOAuthPlatform;
    readonly serverName: string;
    readonly config: HttpMcpConfig;
    readonly onAuthorizationUrl: (
      authorizationUrl: URL,
    ) => Effect.Effect<void, AuthError>;
  }) {
    this.#platform = options.platform;
    this.#serverName = options.serverName;
    this.#auth = makeOAuthProviderAuth(options.config);
    this.#onAuthorizationUrl = options.onAuthorizationUrl;

    const clientMetadataUrl = Option.flatMap(
      options.config.auth,
      (auth) => auth.clientMetadataUrl,
    );
    if (Option.isSome(clientMetadataUrl)) {
      this.clientMetadataUrl = clientMetadataUrl.value;
    }
  }

  get redirectUrl(): string {
    return redirectUrlFor(
      this.#platform,
      this.#serverName,
      this.#auth.redirectUri,
    );
  }

  /**
   * Static metadata about this OAuth client.
   *
   * If the MCP server does not support Dynamic Client Registration via
   * clientMetadataUrl, it uses this information (provided during the auth flow)
   * to identify our application.
   */
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
    return Effect.runPromise(
      signOAuthState({
        storage: this.#platform.storage,
        payload: {
          provider: this.#serverName,
          hostId: this.#platform.hostId,
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
        Effect.runPromise(
          this.#readOptionalJson<OAuthClientInformationMixed>(
            codeModeObjectCredentialClientKey(this.#serverName),
          ).pipe(Effect.map(Option.getOrUndefined)),
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
    return Effect.runPromise(
      this.#writeJson(
        codeModeObjectCredentialClientKey(this.#serverName),
        clientInformation,
      ),
    );
  }

  tokens(): Promise<OAuthTokens | undefined> {
    return Effect.runPromise(
      this.#readOptionalJson<OAuthTokens>(
        codeModeObjectCredentialTokensKey(this.#serverName),
      ).pipe(Effect.map(Option.getOrUndefined)),
    );
  }

  saveTokens(tokens: OAuthTokens): Promise<void> {
    return Effect.runPromise(
      this.#writeJson(
        codeModeObjectCredentialTokensKey(this.#serverName),
        tokens,
      ),
    );
  }

  hasStoredCredentials(): Effect.Effect<boolean, CredentialError> {
    return this.#readOptionalJson<OAuthTokens>(
      codeModeObjectCredentialTokensKey(this.#serverName),
    ).pipe(Effect.map(Option.isSome));
  }

  /**
   * Captures the Identity Provider (IdP) authorization URL from the MCP SDK.
   *
   * Because this provider runs inside a Durable Object, it cannot perform the
   * redirect itself. Instead, it hands the URL to the coordinator via a
   * callback. The Worker route that initiated the flow will eventually see
   * this URL in the coordinator's state and issue the 302 Redirect.
   *
   * Uses Effect.runSync to bridge the SDK's synchronous requirement with our
   * functional callback.
   */
  redirectToAuthorization(authorizationUrl: URL): void {
    Effect.runSync(this.#onAuthorizationUrl(authorizationUrl));
  }

  /**
   * Saves the PKCE code verifier for the current session.
   *
   * PKCE (Proof Key for Code Exchange) is a security handshake. This verifier
   * is a secret that proves we are the same application that started the
   * login flow when the user eventually returns with an authorization code.
   */
  saveCodeVerifier(codeVerifier: string): Promise<void> {
    return Effect.runPromise(
      this.#platform.credentialsStore.set(
        codeModeObjectCredentialPkceVerifierKey(this.#serverName),
        codeVerifier,
      ),
    );
  }

  /**
   * Loads the PKCE code verifier to complete the security handshake.
   */
  codeVerifier(): Promise<string> {
    return Effect.runPromise(
      this.#platform.credentialsStore
        .get(codeModeObjectCredentialPkceVerifierKey(this.#serverName))
        .pipe(
          Effect.map(Option.fromNullable),
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(
                  new CredentialError({
                    message: `Missing OAuth PKCE verifier for ${this.#serverName}. Restart authorization from the ptools auth route.`,
                  }),
                ),
              onSome: Effect.succeed,
            }),
          ),
        ),
    );
  }

  invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): Promise<void> {
    return Effect.runPromise(
      Effect.all([
        scope === "all" || scope === "tokens"
          ? this.#platform.credentialsStore.delete(
              codeModeObjectCredentialTokensKey(this.#serverName),
            )
          : Effect.void,
        scope === "all" || scope === "client"
          ? this.#platform.credentialsStore.delete(
              codeModeObjectCredentialClientKey(this.#serverName),
            )
          : Effect.void,
        scope === "all" || scope === "verifier"
          ? this.#platform.credentialsStore.delete(
              codeModeObjectCredentialPkceVerifierKey(this.#serverName),
            )
          : Effect.void,
        scope === "all" || scope === "discovery"
          ? this.#platform.credentialsStore.delete(
              codeModeObjectCredentialDiscoveryKey(this.#serverName),
            )
          : Effect.void,
      ]).pipe(Effect.asVoid),
    );
  }

  /**
   * Persists the results of OAuth Discovery (RFC 8414).
   *
   * Discovery is the process of automatically finding the server's auth
   * endpoints. We save the results to avoid redundant network calls on
   * future logins.
   */
  saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    return Effect.runPromise(
      this.#writeJson(
        codeModeObjectCredentialDiscoveryKey(this.#serverName),
        state,
      ),
    );
  }

  /**
   * Loads cached discovery results to speed up the auth flow.
   */
  discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return Effect.runPromise(
      this.#readOptionalJson<OAuthDiscoveryState>(
        codeModeObjectCredentialDiscoveryKey(this.#serverName),
      ).pipe(Effect.map(Option.getOrUndefined)),
    );
  }

  /**
   * Missing credentials are valid absence; malformed stored JSON is an error.
   */
  #readOptionalJson<Value>(
    key: string,
  ): Effect.Effect<Option.Option<Value>, CredentialError> {
    return this.#platform.credentialsStore.get(key).pipe(
      Effect.map(Option.fromNullable),
      Effect.flatMap(
        Effect.transposeMapOption((value) =>
          Effect.try({
            try: () => JSON.parse(value) as Value,
            catch: (cause) =>
              new CredentialError({
                message: `Failed to parse Cloudflare credential ${key}`,
                cause,
              }),
          }),
        ),
      ),
    );
  }

  #writeJson(
    key: string,
    value: unknown,
  ): Effect.Effect<void, CredentialError> {
    return this.#platform.credentialsStore.set(key, JSON.stringify(value));
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
            Option.flatMap((config) => config.clientSecret),
          ),
        }),
    }),
  };
};

export const redirectUrlFor = (
  platform: CloudflareOAuthPlatform,
  serverName: string,
  redirectUri: Option.Option<string>,
): string =>
  Option.getOrElse(
    redirectUri,
    () =>
      `${platform.origin}/hosts/${encodeURIComponent(platform.hostId)}/oauth/callback/${encodeURIComponent(serverName)}`,
  );
