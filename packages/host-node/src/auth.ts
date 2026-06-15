import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { AsyncEntry } from "@napi-rs/keyring";
import {
  AuthCoordinator,
  AuthCoordinatorCore,
  AuthCoordinatorCoreLayer,
  AuthCoordinatorPolicy,
  AuthError,
  AuthProviderFactory,
  CredentialError,
  CredentialsStore,
  isDynamicClientRegistrationUnsupported,
  safeErrorMessage,
  type AuthCoordinatorOAuthProvider,
  type HttpMcpConfig,
  type UpstreamHttpAuthConfig,
} from "@ptools/auth";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { Context, Effect, Layer, Option, Scope } from "effect";

const DEFAULT_HOST = "127.0.0.1";

type CredentialsStoreService = Context.Tag.Service<typeof CredentialsStore>;
type AuthCoordinatorCoreService = Context.Tag.Service<
  typeof AuthCoordinatorCore
>;

export const NodeCredentialsStoreLive = (options: {
  readonly serviceName: string;
}): Layer.Layer<CredentialsStore, never, never> =>
  Layer.sync(CredentialsStore, () => ({
    get: (key) =>
      Effect.tryPromise({
        try: () => new AsyncEntry(options.serviceName, key).getPassword(),
        catch: (cause) =>
          new CredentialError({
            message: `Failed to read credential ${key}`,
            cause,
          }),
      }).pipe(Effect.map((value) => value ?? undefined)),
    set: (key, value) =>
      Effect.tryPromise({
        try: () => new AsyncEntry(options.serviceName, key).setPassword(value),
        catch: (cause) =>
          new CredentialError({
            message: `Failed to write credential ${key}`,
            cause,
          }),
      }),
    delete: (key) =>
      Effect.tryPromise({
        try: async () => {
          await new AsyncEntry(options.serviceName, key)
            .deleteCredential()
            .catch(() => false);
        },
        catch: (cause) =>
          new CredentialError({
            message: `Failed to delete credential ${key}`,
            cause,
          }),
      }),
  }));

export const NodeAuthCoordinatorLive = (options: {
  readonly runtimeId: string;
  readonly autoOpen?: boolean;
}): Layer.Layer<AuthCoordinator, AuthError, CredentialsStore> =>
  Layer.scoped(
    AuthCoordinator,
    Effect.gen(function* () {
      const credentialsStore = yield* CredentialsStore;
      const manager = yield* PtoolsAuthManager.make({
        credentialsStore,
        autoOpen: options.autoOpen ?? false,
      });
      const core = manager.core;

      return AuthCoordinator.of({
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
        setRefreshHandler: (handler) => manager.setRefreshHandler(handler),
      });
    }).pipe(
      Effect.mapError(
        (cause) =>
          new AuthError({
            message: "Failed to start ptools auth coordinator.",
            cause,
          }),
      ),
    ),
  );

interface PtoolsAuthManagerOptions {
  readonly credentialsStore: CredentialsStoreService;
  readonly autoOpen: boolean;
}

class PtoolsAuthManager {
  readonly core: AuthCoordinatorCoreService;
  readonly #server: Server;
  readonly #port: number;
  #refreshHandler: ((serverName: string) => Promise<void>) | undefined;

  private constructor(
    server: Server,
    port: number,
    core: AuthCoordinatorCoreService,
  ) {
    this.#server = server;
    this.#port = port;
    this.core = core;
  }

  static make = (
    options: PtoolsAuthManagerOptions,
  ): Effect.Effect<PtoolsAuthManager, AuthError, Scope.Scope> =>
    Effect.acquireRelease(
      Effect.tryPromise({
        try: () => PtoolsAuthManager.start(options),
        catch: (cause) =>
          new AuthError({
            message: "Failed to start local ptools auth center.",
            cause,
          }),
      }),
      (manager) => Effect.promise(() => manager.close()).pipe(Effect.ignore),
    );

  static async start(
    options: PtoolsAuthManagerOptions,
  ): Promise<PtoolsAuthManager> {
    let manager: PtoolsAuthManager | undefined;
    const server = createServer((request, response) => {
      manager?.handleRequest(request, response);
    });
    const port = await listen(server);
    const origin = `http://${DEFAULT_HOST}:${port}`;
    const coreLayer = AuthCoordinatorCoreLayer.pipe(
      Layer.provide(
        Layer.mergeAll(
          NodeAuthProviderFactoryLayer({
            credentialsStore: options.credentialsStore,
            origin,
            autoOpen: options.autoOpen,
          }),
          NodeAuthPolicyLayer(origin),
        ),
      ),
    );
    const core = await Effect.runPromise(
      AuthCoordinatorCore.pipe(Effect.provide(coreLayer)),
    );

    manager = new PtoolsAuthManager(server, port, core);
    return manager;
  }

  get authUrl(): string {
    return `${this.#origin}/auth`;
  }

  get origin(): string {
    return this.#origin;
  }

  get #origin(): string {
    return `http://${DEFAULT_HOST}:${this.#port}`;
  }

  async beginAuthorization(
    serverName: string,
    options: { readonly force?: boolean } = {},
  ): Promise<string> {
    const config = await Effect.runPromise(this.core.httpConfigFor(serverName));
    const provider = await Effect.runPromise(
      this.core.providerFor(serverName, config),
    );

    if (options.force === true) {
      await provider.invalidateCredentials?.("all");
    }

    let result: Awaited<ReturnType<typeof auth>>;

    try {
      result = await auth(provider, authOptions(config));
    } catch (cause) {
      if (isDynamicClientRegistrationUnsupported(cause)) {
        await Effect.runPromise(
          this.core.noteConnectionError(serverName, cause),
        );
        return this.#setupUrl(serverName);
      }

      throw cause;
    }

    if (result === "AUTHORIZED") {
      await Effect.runPromise(this.core.markAuthorized(serverName));
      return this.authUrl;
    }

    await Effect.runPromise(this.core.markAuthorizationInProgress(serverName));
    return Effect.runPromise(this.core.authorizationUrlFor(serverName));
  }

  async finishAuthorization(serverName: string, code: string): Promise<void> {
    const config = await Effect.runPromise(this.core.httpConfigFor(serverName));
    const provider = await Effect.runPromise(
      this.core.providerFor(serverName, config),
    );

    await auth(provider, {
      ...authOptions(config),
      authorizationCode: code,
    });
    await Effect.runPromise(this.core.markAuthorized(serverName));
  }

  async logout(serverName: string): Promise<void> {
    const config = await Effect.runPromise(this.core.httpConfigFor(serverName));
    const provider = await Effect.runPromise(
      this.core.providerFor(serverName, config),
    );

    await provider.invalidateCredentials?.("all");
    await Effect.runPromise(
      this.core.noteConnectionError(
        serverName,
        new Error(`Logged out of ${serverName}.`),
      ),
    );
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.#server.close(() => resolve());
    });
  }

  setRefreshHandler(
    handler: (serverName: string) => Promise<void>,
  ): Effect.Effect<void> {
    this.#refreshHandler = handler;
    return this.core.setRefreshHandler(handler);
  }

  redirectUrlFor(
    serverName: string,
    config: Option.Option<UpstreamHttpAuthConfig>,
  ): string {
    return Option.getOrElse(
      Option.flatMap(config, (auth) => auth.redirectUri),
      () => `${this.#origin}/oauth/callback/${encodeURIComponent(serverName)}`,
    );
  }

  async handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    try {
      const url = new URL(request.url ?? "/", this.#origin);

      if (request.method !== "GET" && request.method !== "POST") {
        sendText(response, 405, "Method not allowed");
        return;
      }

      if (url.pathname === "/" || url.pathname === "/auth") {
        sendHtml(response, await this.#renderAuthPage());
        return;
      }

      if (url.pathname.startsWith("/refresh/")) {
        const serverName = decodeURIComponent(
          url.pathname.slice("/refresh/".length),
        );

        if (this.#refreshHandler === undefined) {
          sendHtml(
            response,
            this.#renderMessagePage(
              "Refresh unavailable",
              "This ptools auth center was not started with a refresh handler.",
            ),
          );
          return;
        }

        await this.#refreshHandler(serverName);
        sendHtml(
          response,
          this.#renderMessagePage(
            "Refresh complete",
            `ptools reconnected and rediscovered ${serverName}.`,
          ),
        );
        return;
      }

      if (url.pathname.startsWith("/auth/")) {
        const serverName = decodeURIComponent(
          url.pathname.slice("/auth/".length),
        );
        if (serverName.endsWith("/setup")) {
          const actualServerName = serverName.slice(0, -"/setup".length);
          sendHtml(response, await this.#renderSetupPage(actualServerName));
          return;
        }

        const authorizationUrl = await this.beginAuthorization(serverName, {
          force:
            url.searchParams.get("force") === "1" ||
            url.searchParams.get("force") === "true",
        });

        response.statusCode = 302;
        response.setHeader("location", authorizationUrl);
        response.end();
        return;
      }

      if (url.pathname.startsWith("/oauth/callback/")) {
        const serverName = decodeURIComponent(
          url.pathname.slice("/oauth/callback/".length),
        );
        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");

        if (error !== null) {
          await Effect.runPromise(
            this.core.noteConnectionError(serverName, new Error(error)),
          );
          sendHtml(
            response,
            this.#renderMessagePage("Authorization failed", error),
          );
          return;
        }

        if (code === null || code.trim().length === 0) {
          sendText(response, 400, "Missing OAuth authorization code.");
          return;
        }

        await this.finishAuthorization(serverName, code);
        sendHtml(
          response,
          this.#renderMessagePage(
            "Authorization complete",
            `${serverName} is connected. You can return to your MCP client and retry.`,
          ),
        );
        return;
      }

      if (url.pathname === "/status.json") {
        sendJson(response, await Effect.runPromise(this.core.status));
        return;
      }

      sendText(response, 404, "Not found");
    } catch (cause) {
      sendText(response, 500, safeErrorMessage(cause));
    }
  }

  async #renderAuthPage(): Promise<string> {
    const status = await Effect.runPromise(this.core.status);
    const rows = status.servers
      .map((server) => {
        const actions = [
          `<a class="button secondary" href="/refresh/${encodeURIComponent(server.serverName)}">Refresh</a>`,
          server.setupUrl !== undefined
            ? `<a class="button secondary" href="${escapeHtml(server.setupUrl)}">Setup</a>`
            : server.authorizeUrl !== undefined
              ? `<a class="button" href="${escapeHtml(server.authorizeUrl)}">Authorize</a>`
              : server.transport === "http" &&
                  server.status !== "static_credentials"
                ? `<a class="button secondary" href="/auth/${encodeURIComponent(server.serverName)}?force=1">Reauthorize</a>`
                : `<span class="muted">No OAuth action</span>`,
        ].join(" ");

        return `<tr>
  <td>${escapeHtml(server.serverName)}</td>
  <td>${escapeHtml(server.transport)}</td>
  <td><span class="status">${escapeHtml(server.status)}</span></td>
  <td>${escapeHtml(server.message ?? server.lastError ?? "")}</td>
  <td>${actions}</td>
</tr>`;
      })
      .join("\n");

    return authPageHtml(rows);
  }

  async #renderSetupPage(serverName: string): Promise<string> {
    const config = await Effect.runPromise(
      this.core.httpConfigFor(serverName).pipe(Effect.either),
    );

    if (config._tag === "Left") {
      return this.#renderMessagePage(
        "Setup unavailable",
        `No HTTP MCP server named ${serverName} is configured.`,
      );
    }

    const envPrefix = toEnvPrefix(serverName);
    const oauthSnippet = JSON.stringify(
      {
        mcpServers: {
          [serverName]: {
            url: config.right.url,
            auth: {
              type: "oauth",
              clientId: `\${env:${envPrefix}_CLIENT_ID}`,
              clientSecret: `\${env:${envPrefix}_CLIENT_SECRET}`,
            },
          },
        },
      },
      null,
      2,
    );
    const publicClientSnippet = JSON.stringify(
      {
        mcpServers: {
          [serverName]: {
            url: config.right.url,
            auth: {
              type: "oauth",
              clientId: `\${env:${envPrefix}_CLIENT_ID}`,
            },
          },
        },
      },
      null,
      2,
    );
    const tokenSnippet = JSON.stringify(
      {
        mcpServers: {
          [serverName]: {
            url: config.right.url,
            headers: {
              Authorization: `Bearer \${env:${envPrefix}_TOKEN}`,
            },
          },
        },
      },
      null,
      2,
    );

    return setupPageHtml(
      serverName,
      oauthSnippet,
      publicClientSnippet,
      tokenSnippet,
    );
  }

  #renderMessagePage(title: string, message: string): string {
    return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title></head>
<body style="font-family: system-ui, sans-serif; padding: 32px;">
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(message)}</p>
<p><a href="/auth">Back to auth center</a></p>
</body>
</html>`;
  }

  #setupUrl(serverName: string): string {
    return `${this.#origin}/auth/${encodeURIComponent(serverName)}/setup`;
  }
}

const NodeAuthPolicyLayer = (
  origin: string,
): Layer.Layer<AuthCoordinatorPolicy> =>
  Layer.succeed(
    AuthCoordinatorPolicy,
    AuthCoordinatorPolicy.of({
      origin,
      authUrl: `${origin}/auth`,
      callbackUrl: (serverName) =>
        `${origin}/oauth/callback/${encodeURIComponent(serverName)}`,
      setupUrl: (serverName) =>
        `${origin}/auth/${encodeURIComponent(serverName)}/setup`,
      authorizeUrl: (serverName) =>
        `${origin}/auth/${encodeURIComponent(serverName)}`,
      reauthorizeUrl: (serverName) =>
        `${origin}/auth/${encodeURIComponent(serverName)}?force=1`,
      authRequiredMessage: (serverName) =>
        `Authorize ${serverName} from the ptools auth center.`,
      dynamicClientRegistrationUnsupportedMessage: (serverName) =>
        `${serverName} does not support dynamic OAuth client registration. ` +
        `Add auth.clientId, and auth.clientSecret if required, or use another auth method for this server.`,
    }),
  );

const NodeAuthProviderFactoryLayer = (options: {
  readonly credentialsStore: CredentialsStoreService;
  readonly origin: string;
  readonly autoOpen: boolean;
}): Layer.Layer<AuthProviderFactory> =>
  Layer.succeed(
    AuthProviderFactory,
    AuthProviderFactory.of({
      makeProvider: (input) =>
        Effect.succeed(
          new PtoolsOAuthProvider({
            credentialsStore: options.credentialsStore,
            origin: options.origin,
            autoOpen: options.autoOpen,
            serverName: input.serverName,
            config: input.config,
            onAuthorizationUrl: input.onAuthorizationUrl,
          }),
        ),
    }),
  );

class PtoolsOAuthProvider implements AuthCoordinatorOAuthProvider {
  readonly #credentialsStore: CredentialsStoreService;
  readonly #origin: string;
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
    readonly credentialsStore: CredentialsStoreService;
    readonly origin: string;
    readonly autoOpen: boolean;
    readonly serverName: string;
    readonly config: HttpMcpConfig;
    readonly onAuthorizationUrl: (
      authorizationUrl: URL,
    ) => Effect.Effect<void, AuthError>;
  }) {
    this.#credentialsStore = options.credentialsStore;
    this.#origin = options.origin;
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
    return redirectUrlFor(this.#origin, this.#serverName, this.#config.auth);
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
        `Missing OAuth PKCE verifier for ${this.#serverName}. Restart authorization from the ptools auth center.`,
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

const listen = (server: Server): Promise<number> =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, DEFAULT_HOST, () => {
      server.off("error", reject);
      const address = server.address();

      if (typeof address === "object" && address !== null) {
        resolve(address.port);
        return;
      }

      reject(new Error("Unable to start ptools auth center."));
    });
  });

const authOptions = (config: HttpMcpConfig) => ({
  serverUrl: config.url,
  ...Option.match(
    Option.flatMap(config.auth, (auth) => auth.scope),
    {
      onNone: () => ({}),
      onSome: (scope) => ({ scope }),
    },
  ),
  ...Option.match(
    Option.flatMap(config.auth, (auth) => auth.resourceMetadataUrl),
    {
      onNone: () => ({}),
      onSome: (resourceMetadataUrl) => ({
        resourceMetadataUrl: new URL(resourceMetadataUrl),
      }),
    },
  ),
});

const redirectUrlFor = (
  origin: string,
  serverName: string,
  config: Option.Option<UpstreamHttpAuthConfig>,
): string =>
  Option.getOrElse(
    Option.flatMap(config, (auth) => auth.redirectUri),
    () => `${origin}/oauth/callback/${encodeURIComponent(serverName)}`,
  );

const hashKey = (value: string): string => {
  let hash = 0;

  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }

  return hash.toString(16);
};

const sendHtml = (response: ServerResponse, html: string): void => {
  response.statusCode = 200;
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(html);
};

const sendJson = (response: ServerResponse, value: unknown): void => {
  response.statusCode = 200;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(value, null, 2));
};

const sendText = (
  response: ServerResponse,
  statusCode: number,
  text: string,
): void => {
  response.statusCode = statusCode;
  response.setHeader("content-type", "text/plain; charset=utf-8");
  response.end(text);
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

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const toEnvPrefix = (serverName: string): string =>
  serverName
    .replaceAll(/[^A-Za-z0-9]+/g, "_")
    .replaceAll(/^_+|_+$/g, "")
    .toUpperCase() || "MCP";

const authPageHtml = (rows: string): string => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ptools auth center</title>
  <style>
    body { color: #171717; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; background: #f7f7f5; }
    main { max-width: 960px; margin: 0 auto; padding: 32px 20px; }
    h1 { font-size: 24px; margin: 0 0 8px; }
    p { color: #555; margin: 0 0 24px; }
    table { width: 100%; border-collapse: collapse; background: white; border: 1px solid #ddd; }
    th, td { text-align: left; border-bottom: 1px solid #eee; padding: 12px; font-size: 14px; vertical-align: top; }
    th { background: #fafafa; color: #444; font-weight: 600; }
    .status { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
    .button { display: inline-block; color: white; background: #1f6feb; border-radius: 6px; padding: 7px 10px; text-decoration: none; }
    .button.secondary { background: #555; }
    .muted { color: #777; }
  </style>
</head>
<body>
  <main>
    <h1>ptools auth center</h1>
    <p>Configured upstream MCP servers and their current auth state.</p>
    <table>
      <thead>
        <tr><th>MCP Server</th><th>Type</th><th>Status</th><th>Message</th><th>Action</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </main>
</body>
</html>`;

const setupPageHtml = (
  serverName: string,
  oauthSnippet: string,
  publicClientSnippet: string,
  tokenSnippet: string,
): string => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(serverName)} setup</title>
  <style>
    body { color: #171717; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; background: #f7f7f5; }
    main { max-width: 920px; margin: 0 auto; padding: 32px 20px; }
    h1 { font-size: 24px; margin: 0 0 8px; }
    h2 { font-size: 16px; margin: 28px 0 8px; }
    p, li { color: #555; line-height: 1.5; }
    pre { background: #171717; color: #f4f4f5; border-radius: 8px; overflow-x: auto; padding: 14px; font-size: 13px; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    a { color: #1f6feb; }
  </style>
</head>
<body>
  <main>
    <p><a href="/auth">Back to auth center</a></p>
    <h1>${escapeHtml(serverName)} needs auth configuration</h1>
    <p>This authorization server does not support Dynamic Client Registration, so ptools cannot create an OAuth client automatically.</p>
    <p>Use one of these options, depending on what this MCP server supports.</p>

    <h2>Option 1: Pre-registered OAuth client</h2>
    <p>Create/register an OAuth client with the provider, then add its client id and secret to environment variables.</p>
    <pre><code>${escapeHtml(oauthSnippet)}</code></pre>

    <h2>Option 2: Public OAuth client with PKCE</h2>
    <p>If the provider gives you a public client id and does not require a secret, omit <code>clientSecret</code>.</p>
    <pre><code>${escapeHtml(publicClientSnippet)}</code></pre>

    <h2>Option 3: Static bearer token</h2>
    <p>Use this only if the MCP server supports bearer token authentication. Not every OAuth-backed MCP server accepts manually supplied tokens.</p>
    <pre><code>${escapeHtml(tokenSnippet)}</code></pre>
  </main>
</body>
</html>`;
