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
  CredentialError,
  CredentialsStore,
  type AuthCoordinatorOAuthProvider,
  type HttpMcpConfig,
  type UpstreamHttpAuthConfig,
} from "@ptools/auth";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Effect, Layer, Option } from "effect";
import { NodeHostIdentity, NodeHostSettings } from "../platform/index.js";
import { oauthCallbackUrl, type NodeAuthRouteOptions } from "./policy.js";

/** Builds MCP SDK OAuth providers using Node keyring-backed credentials. */
export const NodeAuthProviderFactoryLayer: Layer.Layer<
  AuthProviderFactory,
  never,
  CredentialsStore | NodeHostIdentity | NodeHostSettings
> = Layer.effect(
    AuthProviderFactory,
    Effect.gen(function* () {
      const credentialsStore = yield* CredentialsStore;
      const identity = yield* NodeHostIdentity;
      const settings = yield* NodeHostSettings;

      return AuthProviderFactory.of({
        makeProvider: (input) =>
          Effect.succeed(
            new PtoolsOAuthProvider({
              credentialsStore,
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
  readonly #credentialsStore: ContextCredentialsStore;
  readonly #origin: string;
  readonly #hostId: string;
  readonly #autoOpen: boolean;
  readonly #serverName: string;
  readonly #config: HttpMcpConfig;
  readonly #onAuthorizationUrl: (
    authorizationUrl: URL,
  ) => Effect.Effect<void, AuthError>;
  readonly clientMetadataUrl?: string;
  #codeVerifier: string | undefined;
  #discoveryState: OAuthDiscoveryState | undefined;

  constructor(options: {
    readonly credentialsStore: ContextCredentialsStore;
    readonly origin: string;
    readonly hostId: string;
    readonly autoOpen: boolean;
    readonly serverName: string;
    readonly config: HttpMcpConfig;
    readonly onAuthorizationUrl: (
      authorizationUrl: URL,
    ) => Effect.Effect<void, AuthError>;
  }) {
    this.#credentialsStore = options.credentialsStore;
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

    return this.#readJson<OAuthClientInformationMixed>("client");
  }

  async saveClientInformation(
    clientInformation: OAuthClientInformationMixed,
  ): Promise<void> {
    await this.#writeJson("client", clientInformation);
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return this.#readJson<OAuthTokens>("tokens");
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.#writeJson("tokens", tokens);
  }

  hasStoredCredentials(): Effect.Effect<boolean, CredentialError> {
    return Effect.tryPromise({
      try: () => this.tokens(),
      catch: (cause) =>
        new CredentialError({
          message: `Failed to read stored OAuth credentials for ${this.#serverName}`,
          cause,
        }),
    }).pipe(Effect.map((tokens) => tokens !== undefined));
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    Effect.runSync(this.#onAuthorizationUrl(authorizationUrl));

    if (this.#autoOpen) {
      openUrl(authorizationUrl.toString());
    }
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.#codeVerifier = codeVerifier;
  }

  codeVerifier(): string {
    if (this.#codeVerifier === undefined) {
      throw new Error(
        `Missing OAuth PKCE verifier for ${this.#serverName}. Restart authorization from ptools.`,
      );
    }

    return this.#codeVerifier;
  }

  async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): Promise<void> {
    if (scope === "all" || scope === "tokens") {
      await this.#delete("tokens");
    }

    if (scope === "all" || scope === "client") {
      await this.#delete("client");
    }

    if (scope === "all" || scope === "verifier") {
      this.#codeVerifier = undefined;
    }

    if (scope === "all" || scope === "discovery") {
      this.#discoveryState = undefined;
    }
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.#discoveryState = state;
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.#discoveryState;
  }

  async #readJson<Value>(kind: string): Promise<Value | undefined> {
    const password = await Effect.runPromise(
      this.#credentialsStore.get(this.#key(kind)),
    );

    if (password === undefined) {
      return undefined;
    }

    return JSON.parse(password) as Value;
  }

  async #writeJson(kind: string, value: unknown): Promise<void> {
    await Effect.runPromise(
      this.#credentialsStore.set(this.#key(kind), JSON.stringify(value)),
    );
  }

  async #delete(kind: string): Promise<void> {
    await Effect.runPromise(this.#credentialsStore.delete(this.#key(kind)));
  }

  #key(kind: string): string {
    return `${encodeURIComponent(this.#serverName)}:${hashKey(this.#config.url)}:${kind}`;
  }
}

type ContextCredentialsStore = typeof CredentialsStore.Service;

const redirectUrlFor = (
  route: NodeAuthRouteOptions,
  serverName: string,
  config: Option.Option<UpstreamHttpAuthConfig>,
): string =>
  Option.getOrElse(
    Option.flatMap(config, (auth) => auth.redirectUri),
    () => oauthCallbackUrl({ ...route, serverName }),
  );

const hashKey = (value: string): string => {
  let hash = 0;

  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }

  return hash.toString(16);
};

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
