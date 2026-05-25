import {
  auth,
  UnauthorizedError,
} from "@modelcontextprotocol/sdk/client/auth.js";
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
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { Effect, Scope } from "effect";
import type {
  McpAuthServerStatus,
  McpAuthStatus,
  McpAuthStatusValue,
  UpstreamHttpAuthConfig,
  UpstreamMcpConfig,
} from "./types.js";

const KEYRING_SERVICE = "ptools-mcp-oauth";
const DEFAULT_HOST = "127.0.0.1";

interface AuthServerRecord {
  readonly serverName: string;
  readonly jsServerName: string;
  readonly transport: UpstreamMcpConfig["transport"];
  readonly url?: string;
  readonly auth?: UpstreamHttpAuthConfig;
  status: McpAuthStatusValue;
  authorizationUrl?: string;
  message?: string;
  lastError?: string;
}

interface AuthServerRecordUpdate {
  readonly status?: McpAuthStatusValue;
  readonly authorizationUrl?: string | undefined;
  readonly message?: string | undefined;
  readonly lastError?: string | undefined;
}

interface PtoolsAuthManagerOptions {
  readonly onAuthorized?: (serverName: string) => Promise<void>;
  readonly autoOpen?: boolean;
}

export class PtoolsAuthManager {
  readonly #records = new Map<string, AuthServerRecord>();
  readonly #providers = new Map<string, PtoolsOAuthProvider>();
  readonly #oauthServers = new Set<string>();
  readonly #server: Server;
  readonly #port: number;
  readonly #onAuthorized: ((serverName: string) => Promise<void>) | undefined;
  readonly #autoOpen: boolean;

  private constructor(
    server: Server,
    port: number,
    options: PtoolsAuthManagerOptions,
  ) {
    this.#server = server;
    this.#port = port;
    this.#onAuthorized = options.onAuthorized;
    this.#autoOpen = options.autoOpen ?? false;
  }

  static make = (
    options: PtoolsAuthManagerOptions = {},
  ): Effect.Effect<PtoolsAuthManager, never, Scope.Scope> =>
    Effect.acquireRelease(
      Effect.promise(() => PtoolsAuthManager.start(options)),
      (manager) => Effect.promise(() => manager.close()).pipe(Effect.ignore),
    );

  static async start(
    options: PtoolsAuthManagerOptions = {},
  ): Promise<PtoolsAuthManager> {
    let manager: PtoolsAuthManager | undefined;
    const server = createServer((request, response) => {
      manager?.handleRequest(request, response);
    });

    const port = await new Promise<number>((resolve, reject) => {
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

    manager = new PtoolsAuthManager(server, port, options);
    return manager;
  }

  get authUrl(): string {
    return `${this.#origin}/auth`;
  }

  get #origin(): string {
    return `http://${DEFAULT_HOST}:${this.#port}`;
  }

  noteConfigured(
    serverName: string,
    jsServerName: string,
    config: UpstreamMcpConfig,
  ): void {
    const existing = this.#records.get(serverName);
    const hasStaticHeaders =
      config.transport === "http" &&
      config.headers !== undefined &&
      Object.keys(config.headers).length > 0;
    const status: McpAuthStatusValue =
      config.transport === "stdio"
        ? "connected"
        : hasStaticHeaders
          ? "static_credentials"
          : (existing?.status ?? "connected");

    this.#records.set(serverName, {
      serverName,
      jsServerName,
      transport: config.transport,
      ...(config.transport === "http" ? { url: config.url } : {}),
      ...(config.transport === "http" && config.auth !== undefined
        ? { auth: config.auth }
        : {}),
      status,
      ...(existing?.authorizationUrl === undefined
        ? {}
        : { authorizationUrl: existing.authorizationUrl }),
      ...(existing?.message === undefined ? {} : { message: existing.message }),
      ...(existing?.lastError === undefined
        ? {}
        : { lastError: existing.lastError }),
    });
  }

  noteConnected(serverName: string): void {
    this.#update(serverName, {
      status: "connected",
      authorizationUrl: undefined,
      message: undefined,
      lastError: undefined,
    });
  }

  noteConnectionError(serverName: string, error: unknown): void {
    if (isDynamicClientRegistrationUnsupported(error)) {
      this.#update(serverName, {
        status: "needs_config",
        message:
          `${serverName} does not support dynamic OAuth client registration. ` +
          `Add auth.clientId, and auth.clientSecret if required, or use another auth method for this server.`,
        lastError: safeErrorMessage(error),
      });
      return;
    }

    if (isAuthRequiredError(error)) {
      this.#update(serverName, {
        status: "requires_auth",
        message: `Authorize ${serverName} from the ptools auth center.`,
        lastError: undefined,
      });
      return;
    }

    this.#update(serverName, {
      status: "auth_failed",
      lastError: safeErrorMessage(error),
    });
  }

  providerFor(
    serverName: string,
    config: Extract<UpstreamMcpConfig, { readonly transport: "http" }>,
  ): OAuthClientProvider {
    this.#oauthServers.add(serverName);
    const existing = this.#providers.get(serverName);

    if (existing !== undefined) {
      return existing;
    }

    const provider = new PtoolsOAuthProvider(this, serverName, config);
    this.#providers.set(serverName, provider);
    return provider;
  }

  shouldAttachAuthProvider(serverName: string): boolean {
    return this.#oauthServers.has(serverName);
  }

  async hasStoredCredentials(
    serverName: string,
    config: Extract<UpstreamMcpConfig, { readonly transport: "http" }>,
  ): Promise<boolean> {
    const existing = this.#providers.get(serverName);
    const provider =
      existing ?? new PtoolsOAuthProvider(this, serverName, config);

    try {
      const hasCredentials = await provider.hasStoredCredentials();

      if (hasCredentials) {
        this.#providers.set(serverName, provider);
        this.#oauthServers.add(serverName);
      }

      return hasCredentials;
    } catch {
      return false;
    }
  }

  status(): McpAuthStatus {
    return {
      authUrl: this.authUrl,
      servers: [...this.#records.values()].map((record) =>
        this.#toPublicStatus(record),
      ),
    };
  }

  async beginAuthorization(serverName: string): Promise<string> {
    const record = this.#records.get(serverName);

    if (record?.url === undefined || record.transport !== "http") {
      throw new Error(
        `MCP server ${serverName} does not support ptools OAuth.`,
      );
    }

    const provider = this.providerFor(serverName, {
      transport: "http",
      url: record.url,
      ...(record.auth === undefined ? {} : { auth: record.auth }),
    });

    this.#update(serverName, {
      status: "auth_in_progress",
      message: `Waiting for authorization for ${serverName}.`,
      lastError: undefined,
    });

    let result: Awaited<ReturnType<typeof auth>>;

    try {
      result = await auth(provider, {
        serverUrl: record.url,
        ...(record.auth?.scope === undefined
          ? {}
          : { scope: record.auth.scope }),
        ...(record.auth?.resourceMetadataUrl === undefined
          ? {}
          : { resourceMetadataUrl: new URL(record.auth.resourceMetadataUrl) }),
      });
    } catch (cause) {
      if (isDynamicClientRegistrationUnsupported(cause)) {
        this.#update(serverName, {
          status: "needs_config",
          message:
            `${serverName} does not support dynamic OAuth client registration. ` +
            `Add auth.clientId, and auth.clientSecret if required, or use another auth method for this server.`,
          lastError: safeErrorMessage(cause),
        });
        return this.#setupUrl(serverName);
      }

      throw cause;
    }

    if (result === "AUTHORIZED") {
      await this.#handleAuthorized(serverName);
      return this.authUrl;
    }

    const authorizationUrl = this.#records.get(serverName)?.authorizationUrl;

    if (authorizationUrl === undefined) {
      throw new Error(
        `OAuth authorization URL was not produced for ${serverName}.`,
      );
    }

    return authorizationUrl;
  }

  async finishAuthorization(serverName: string, code: string): Promise<void> {
    const provider = this.#providers.get(serverName);
    const record = this.#records.get(serverName);

    if (provider === undefined || record?.url === undefined) {
      throw new Error(
        `MCP server ${serverName} does not support ptools OAuth.`,
      );
    }

    await auth(provider, {
      serverUrl: record.url,
      authorizationCode: code,
      ...(record.auth?.scope === undefined ? {} : { scope: record.auth.scope }),
      ...(record.auth?.resourceMetadataUrl === undefined
        ? {}
        : { resourceMetadataUrl: new URL(record.auth.resourceMetadataUrl) }),
    });
    await this.#handleAuthorized(serverName);
  }

  async logout(serverName: string): Promise<void> {
    const provider = this.#providers.get(serverName);

    await provider?.invalidateCredentials?.("all");
    this.#update(serverName, {
      status: "requires_auth",
      authorizationUrl: undefined,
      message: `Logged out of ${serverName}.`,
      lastError: undefined,
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.#server.close(() => resolve());
    });
  }

  setAuthorizationUrl(serverName: string, authorizationUrl: URL): void {
    this.#update(serverName, {
      status: "requires_auth",
      authorizationUrl: authorizationUrl.toString(),
      message: `Authorize ${serverName} from the ptools auth center.`,
      lastError: undefined,
    });

    if (this.#autoOpen) {
      openUrl(authorizationUrl.toString());
    }
  }

  redirectUrlFor(
    serverName: string,
    config: UpstreamHttpAuthConfig | undefined,
  ): string {
    return (
      config?.redirectUri ??
      `${this.#origin}/oauth/callback/${encodeURIComponent(serverName)}`
    );
  }

  async #handleAuthorized(serverName: string): Promise<void> {
    this.#oauthServers.add(serverName);
    this.#update(serverName, {
      status: "connected",
      authorizationUrl: undefined,
      message: `Authorized ${serverName}.`,
      lastError: undefined,
    });

    await this.#onAuthorized?.(serverName);
  }

  #update(serverName: string, update: AuthServerRecordUpdate): void {
    const record = this.#records.get(serverName);

    if (record === undefined) {
      return;
    }

    if (update.status !== undefined) {
      record.status = update.status;
    }

    if ("authorizationUrl" in update) {
      if (update.authorizationUrl === undefined) {
        delete record.authorizationUrl;
      } else {
        record.authorizationUrl = update.authorizationUrl;
      }
    }

    if ("message" in update) {
      if (update.message === undefined) {
        delete record.message;
      } else {
        record.message = update.message;
      }
    }

    if ("lastError" in update) {
      if (update.lastError === undefined) {
        delete record.lastError;
      } else {
        record.lastError = update.lastError;
      }
    }
  }

  #toPublicStatus(record: AuthServerRecord): McpAuthServerStatus {
    const shouldShowAuthorize =
      record.transport === "http" &&
      (record.status === "requires_auth" ||
        record.status === "auth_failed" ||
        record.authorizationUrl !== undefined);

    return {
      serverName: record.serverName,
      jsServerName: record.jsServerName,
      transport: record.transport,
      status: record.status,
      authUrl: this.authUrl,
      ...(record.status === "needs_config"
        ? { setupUrl: this.#setupUrl(record.serverName) }
        : {}),
      ...(!shouldShowAuthorize
        ? {}
        : {
            authorizeUrl: `${this.#origin}/auth/${encodeURIComponent(record.serverName)}`,
          }),
      ...(record.message === undefined ? {} : { message: record.message }),
      ...(record.lastError === undefined
        ? {}
        : { lastError: record.lastError }),
    };
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
        sendHtml(response, this.#renderAuthPage());
        return;
      }

      if (url.pathname.startsWith("/auth/")) {
        const serverName = decodeURIComponent(
          url.pathname.slice("/auth/".length),
        );
        if (serverName.endsWith("/setup")) {
          const actualServerName = serverName.slice(0, -"/setup".length);
          sendHtml(response, this.#renderSetupPage(actualServerName));
          return;
        }

        const authorizationUrl = await this.beginAuthorization(serverName);

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
          this.#update(serverName, {
            status: "auth_failed",
            lastError: error,
          });
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
        sendJson(response, this.status());
        return;
      }

      sendText(response, 404, "Not found");
    } catch (cause) {
      sendText(response, 500, safeErrorMessage(cause));
    }
  }

  #renderAuthPage(): string {
    const rows = this.status()
      .servers.map((server) => {
        const action =
          server.setupUrl !== undefined
            ? `<a class="button secondary" href="${escapeHtml(server.setupUrl)}">Setup</a>`
            : server.authorizeUrl === undefined
              ? `<span class="muted">No OAuth action</span>`
              : `<a class="button" href="${escapeHtml(server.authorizeUrl)}">Authorize</a>`;

        return `<tr>
  <td>${escapeHtml(server.serverName)}</td>
  <td>${escapeHtml(server.transport)}</td>
  <td><span class="status">${escapeHtml(server.status)}</span></td>
  <td>${escapeHtml(server.message ?? server.lastError ?? "")}</td>
  <td>${action}</td>
</tr>`;
      })
      .join("\n");

    return `<!doctype html>
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
  }

  #renderSetupPage(serverName: string): string {
    const record = this.#records.get(serverName);

    if (record === undefined || record.url === undefined) {
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
            url: record.url,
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
            url: record.url,
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
            url: record.url,
            headers: {
              Authorization: `Bearer \${env:${envPrefix}_TOKEN}`,
            },
          },
        },
      },
      null,
      2,
    );

    return `<!doctype html>
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

class PtoolsOAuthProvider implements OAuthClientProvider {
  readonly #manager: PtoolsAuthManager;
  readonly #serverName: string;
  readonly #config: Extract<UpstreamMcpConfig, { readonly transport: "http" }>;
  readonly clientMetadataUrl?: string;
  #codeVerifier: string | undefined;
  #discoveryState: OAuthDiscoveryState | undefined;

  constructor(
    manager: PtoolsAuthManager,
    serverName: string,
    config: Extract<UpstreamMcpConfig, { readonly transport: "http" }>,
  ) {
    this.#manager = manager;
    this.#serverName = serverName;
    this.#config = config;

    if (config.auth?.clientMetadataUrl !== undefined) {
      this.clientMetadataUrl = config.auth.clientMetadataUrl;
    }
  }

  get redirectUrl(): string {
    return this.#manager.redirectUrlFor(this.#serverName, this.#config.auth);
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.redirectUrl],
      token_endpoint_auth_method:
        this.#config.auth?.clientSecret === undefined
          ? "none"
          : "client_secret_basic",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: "ptools",
      ...(this.#config.auth?.scope === undefined
        ? {}
        : { scope: this.#config.auth.scope }),
    };
  }

  state(): string {
    return randomUUID();
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    if (this.#config.auth?.clientId !== undefined) {
      return {
        client_id: this.#config.auth.clientId,
        ...(this.#config.auth.clientSecret === undefined
          ? {}
          : { client_secret: this.#config.auth.clientSecret }),
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

  async hasStoredCredentials(): Promise<boolean> {
    return (await this.tokens()) !== undefined;
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    this.#manager.setAuthorizationUrl(this.#serverName, authorizationUrl);
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
    const password = await new AsyncEntry(
      KEYRING_SERVICE,
      this.#key(kind),
    ).getPassword();

    if (password === undefined) {
      return undefined;
    }

    return JSON.parse(password) as Value;
  }

  async #writeJson(kind: string, value: unknown): Promise<void> {
    await new AsyncEntry(KEYRING_SERVICE, this.#key(kind)).setPassword(
      JSON.stringify(value),
    );
  }

  async #delete(kind: string): Promise<void> {
    await new AsyncEntry(KEYRING_SERVICE, this.#key(kind))
      .deleteCredential()
      .catch(() => false);
  }

  #key(kind: string): string {
    return `${encodeURIComponent(this.#serverName)}:${hashKey(this.#config.url)}:${kind}`;
  }
}

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

const safeErrorMessage = (cause: unknown): string => {
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
