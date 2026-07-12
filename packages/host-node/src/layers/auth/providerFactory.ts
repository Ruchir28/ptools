import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  AuthError,
  AuthProviderFactory,
  McpOAuthCredentialStore,
  type AuthCoordinatorOAuthProvider,
  type HttpMcpConfig,
  type McpOAuthCredentialIdentity,
  type UpstreamHttpAuthConfig,
} from "@ptools/auth";
import { HostIdentity } from "@ptools/host-context";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Effect, Layer, Option } from "effect";
import { NodeHostSettings } from "../platform/index.js";
import { oauthCallbackUrl, type NodeAuthRouteOptions } from "./policy.js";

/** Builds MCP SDK OAuth providers using Node keyring-backed credentials. */
export const NodeAuthProviderFactoryLayer: Layer.Layer<
  AuthProviderFactory,
  never,
  McpOAuthCredentialStore | HostIdentity | NodeHostSettings
> = Layer.effect(
  AuthProviderFactory,
  Effect.gen(function* () {
    const oauthCredentials = yield* McpOAuthCredentialStore;
    const identity = yield* HostIdentity;
    const settings = yield* NodeHostSettings;

    return AuthProviderFactory.of({
      makeProvider: (input) =>
        Effect.succeed(
          new PtoolsOAuthProvider({
            oauthCredentials,
            origin: settings.publicOrigin,
            hostId: identity.hostId,
            autoOpen: settings.auth.autoOpen ?? false,
            serverName: input.serverName,
            config: input.config,
            onAuthorizationUrl: input.onAuthorizationUrl,
          }),
        ),
    });
  }),
);

class PtoolsOAuthProvider implements AuthCoordinatorOAuthProvider {
  readonly #oauthCredentials: typeof McpOAuthCredentialStore.Service;
  readonly #origin: string;
  readonly #hostId: string;
  readonly #autoOpen: boolean;
  readonly #serverName: string;
  readonly #config: HttpMcpConfig;
  readonly #onAuthorizationUrl: (
    authorizationUrl: URL,
  ) => Effect.Effect<void, AuthError>;
  readonly clientMetadataUrl?: string;

  constructor(options: {
    readonly oauthCredentials: typeof McpOAuthCredentialStore.Service;
    readonly origin: string;
    readonly hostId: string;
    readonly autoOpen: boolean;
    readonly serverName: string;
    readonly config: HttpMcpConfig;
    readonly onAuthorizationUrl: (
      authorizationUrl: URL,
    ) => Effect.Effect<void, AuthError>;
  }) {
    this.#oauthCredentials = options.oauthCredentials;
    this.#origin = options.origin;
    this.#hostId = options.hostId;
    this.#autoOpen = options.autoOpen;
    this.#serverName = options.serverName;
    this.#config = options.config;
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
      { origin: this.#origin, hostId: this.#hostId },
      this.#serverName,
      this.#config.auth,
    );
  }

  get clientMetadata(): OAuthClientMetadata {
    const auth = Option.getOrUndefined(this.#config.auth);

    return {
      redirect_uris: [this.redirectUrl],
      token_endpoint_auth_method:
        auth === undefined || Option.isNone(auth.clientSecret)
          ? "none"
          : "client_secret_basic",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: "ptools",
      ...Option.match(auth?.scope ?? Option.none(), {
        onNone: () => ({}),
        onSome: (scope) => ({ scope }),
      }),
    };
  }

  state(): string {
    return randomUUID();
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const auth = Option.getOrUndefined(this.#config.auth);

    if (auth !== undefined && Option.isSome(auth.clientId)) {
      return {
        client_id: auth.clientId.value,
        ...Option.match(auth.clientSecret, {
          onNone: () => ({}),
          onSome: (client_secret) => ({ client_secret }),
        }),
      };
    }

    return Effect.runPromise(
      this.#oauthCredentials
        .getClientInformation(this.#credentialIdentity())
        .pipe(Effect.map(Option.getOrUndefined)),
    );
  }

  async saveClientInformation(
    clientInformation: OAuthClientInformationMixed,
  ): Promise<void> {
    await Effect.runPromise(
      this.#oauthCredentials.setClientInformation(
        this.#credentialIdentity(),
        clientInformation,
      ),
    );
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return Effect.runPromise(
      this.#oauthCredentials
        .getTokens(this.#credentialIdentity())
        .pipe(Effect.map(Option.getOrUndefined)),
    );
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await Effect.runPromise(
      this.#oauthCredentials.setTokens(this.#credentialIdentity(), tokens),
    );
  }

  hasStoredCredentials() {
    return this.#oauthCredentials.hasStoredCredentials(
      this.#credentialIdentity(),
    );
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    Effect.runSync(this.#onAuthorizationUrl(authorizationUrl));

    if (this.#autoOpen) {
      openUrl(authorizationUrl.toString());
    }
  }

  saveCodeVerifier(codeVerifier: string): Promise<void> {
    return Effect.runPromise(
      this.#oauthCredentials.setCodeVerifier(
        this.#credentialIdentity(),
        codeVerifier,
      ),
    );
  }

  codeVerifier(): Promise<string> {
    return Effect.runPromise(
      this.#oauthCredentials.getCodeVerifier(this.#credentialIdentity()),
    );
  }

  async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): Promise<void> {
    await Effect.runPromise(
      this.#oauthCredentials.invalidate(this.#credentialIdentity(), scope),
    );
  }

  saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    return Effect.runPromise(
      this.#oauthCredentials.setDiscoveryState(
        this.#credentialIdentity(),
        state,
      ),
    );
  }

  discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return Effect.runPromise(
      this.#oauthCredentials
        .getDiscoveryState(this.#credentialIdentity())
        .pipe(Effect.map(Option.getOrUndefined)),
    );
  }

  #credentialIdentity(): McpOAuthCredentialIdentity {
    return {
      serverName: this.#serverName,
      serverUrl: this.#config.url,
    };
  }
}

const redirectUrlFor = (
  route: NodeAuthRouteOptions,
  serverName: string,
  config: Option.Option<UpstreamHttpAuthConfig>,
): string =>
  Option.getOrElse(
    Option.flatMap(config, (auth) => auth.redirectUri),
    () => oauthCallbackUrl({ ...route, serverName }),
  );

const openUrl = (url: string): void => {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];

  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
  });

  child.unref();
};
