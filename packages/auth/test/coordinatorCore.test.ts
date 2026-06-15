import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  ResolvedHttpMcpAuthConfig,
  ResolvedHttpMcpConfig,
  ResolvedStdioMcpConfig,
} from "@ptools/config";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";
import {
  AuthCoordinatorCore,
  AuthCoordinatorCoreLayer,
  AuthCoordinatorPolicy,
  AuthProviderFactory,
  CredentialError,
  type AuthCoordinatorOAuthProvider,
  type HttpMcpConfig,
} from "../src/index.js";

const policy = AuthCoordinatorPolicy.of({
  origin: "https://ptools.example",
  authUrl: "https://ptools.example/auth",
  callbackUrl: (serverName) =>
    `https://ptools.example/oauth/callback/${encodeURIComponent(serverName)}`,
  setupUrl: (serverName) =>
    `https://ptools.example/auth/${encodeURIComponent(serverName)}/setup`,
  authorizeUrl: (serverName) =>
    `https://ptools.example/auth/${encodeURIComponent(serverName)}`,
  reauthorizeUrl: (serverName) =>
    `https://ptools.example/auth/${encodeURIComponent(serverName)}?force=1`,
  authRequiredMessage: (serverName) =>
    `Authorize ${serverName} from the test auth center.`,
  dynamicClientRegistrationUnsupportedMessage: (serverName) =>
    `${serverName} needs manual OAuth client configuration.`,
});

describe("AuthCoordinatorCoreLayer", () => {
  it("tracks only HTTP configs and formats host policy URLs", async () => {
    const status = await Effect.runPromise(
      Effect.gen(function* () {
        const core = yield* AuthCoordinatorCore;
        yield* core.noteConfigured("local", "local", stdioConfig("node"));
        yield* core.noteConfigured(
          "notion",
          "notion",
          httpConfig("https://mcp.notion.com/mcp"),
        );

        return yield* core.status;
      }).pipe(Effect.provide(makeCoreLayer())),
    );

    expect(status).toEqual({
      authUrl: "https://ptools.example/auth",
      servers: [
        expect.objectContaining({
          serverName: "notion",
          transport: "http",
          status: "connected",
          reauthorizeUrl: "https://ptools.example/auth/notion?force=1",
        }),
      ],
    });
  });

  it("marks static-header HTTP configs as static_credentials", async () => {
    const status = await Effect.runPromise(
      Effect.gen(function* () {
        const core = yield* AuthCoordinatorCore;
        yield* core.noteConfigured(
          "api",
          "api",
          httpConfig("https://example.com/mcp", {
            headers: { authorization: "Bearer token" },
          }),
        );

        return yield* core.status;
      }).pipe(Effect.provide(makeCoreLayer())),
    );

    expect(status.servers[0]).toEqual(
      expect.objectContaining({
        serverName: "api",
        status: "static_credentials",
      }),
    );
    expect(status.servers[0]?.reauthorizeUrl).toBeUndefined();
  });

  it("maps auth errors into public status", async () => {
    const status = await Effect.runPromise(
      Effect.gen(function* () {
        const core = yield* AuthCoordinatorCore;
        yield* core.noteConfigured(
          "github",
          "github",
          httpConfig("https://github.example/mcp"),
        );
        yield* core.noteConnectionError("github", new Error("unauthorized"));

        return yield* core.status;
      }).pipe(Effect.provide(makeCoreLayer())),
    );

    expect(status.servers[0]).toEqual(
      expect.objectContaining({
        status: "requires_auth",
        authorizeUrl: "https://ptools.example/auth/github",
        message: "Authorize github from the test auth center.",
      }),
    );
  });

  it("maps dynamic client registration errors into setup status", async () => {
    const status = await Effect.runPromise(
      Effect.gen(function* () {
        const core = yield* AuthCoordinatorCore;
        yield* core.noteConfigured(
          "linear",
          "linear",
          httpConfig("https://linear.example/mcp"),
        );
        yield* core.noteConnectionError(
          "linear",
          new Error("dynamic client registration is not supported"),
        );

        return yield* core.status;
      }).pipe(Effect.provide(makeCoreLayer())),
    );

    expect(status.servers[0]).toEqual(
      expect.objectContaining({
        status: "needs_config",
        setupUrl: "https://ptools.example/auth/linear/setup",
        message: "linear needs manual OAuth client configuration.",
      }),
    );
  });

  it("clears stale auth fields when reconfigured to static credentials", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const core = yield* AuthCoordinatorCore;
        yield* core.noteConfigured(
          "github",
          "github",
          httpConfig("https://github.example/mcp"),
        );
        yield* core.setAuthorizationUrl(
          "github",
          new URL("https://github.example/oauth"),
        );
        yield* core.noteConnectionError("github", new Error("network down"));
        yield* core.providerFor(
          "github",
          httpConfig("https://github.example/mcp"),
        );
        yield* core.noteConfigured(
          "github",
          "github",
          httpConfig("https://github.example/mcp", {
            headers: { authorization: "Bearer static" },
          }),
        );

        const status = yield* core.status;
        const shouldAttach = yield* core.shouldAttachAuthProvider("github");

        return { status, shouldAttach };
      }).pipe(Effect.provide(makeCoreLayer())),
    );

    expect(result.status.servers[0]).toEqual(
      expect.objectContaining({
        status: "static_credentials",
      }),
    );
    expect(result.status.servers[0]?.authorizeUrl).toBeUndefined();
    expect(result.status.servers[0]?.reauthorizeUrl).toBeUndefined();
    expect(result.status.servers[0]?.message).toBeUndefined();
    expect(result.status.servers[0]?.lastError).toBeUndefined();
    expect(internalAuthorizationUrl(result.status.servers[0])).toBeUndefined();
    expect(result.shouldAttach).toBe(false);
  });

  it("clears stale provider authorization URL when dynamic client registration needs config", async () => {
    const status = await Effect.runPromise(
      Effect.gen(function* () {
        const core = yield* AuthCoordinatorCore;
        yield* core.noteConfigured(
          "linear",
          "linear",
          httpConfig("https://linear.example/mcp"),
        );
        yield* core.setAuthorizationUrl(
          "linear",
          new URL("https://linear.example/oauth"),
        );
        yield* core.noteConnectionError(
          "linear",
          new Error("dynamic client registration is not supported"),
        );

        return yield* core.status;
      }).pipe(Effect.provide(makeCoreLayer())),
    );

    expect(status.servers[0]).toEqual(
      expect.objectContaining({
        status: "needs_config",
        setupUrl: "https://ptools.example/auth/linear/setup",
        message: "linear needs manual OAuth client configuration.",
      }),
    );
    expect(status.servers[0]?.authorizeUrl).toBeUndefined();
    expect(internalAuthorizationUrl(status.servers[0])).toBeUndefined();
  });

  it("clears stale auth URL and message when generic auth failure follows requires_auth", async () => {
    const status = await Effect.runPromise(
      Effect.gen(function* () {
        const core = yield* AuthCoordinatorCore;
        yield* core.noteConfigured(
          "github",
          "github",
          httpConfig("https://github.example/mcp"),
        );
        yield* core.setAuthorizationUrl(
          "github",
          new URL("https://github.example/oauth"),
        );
        yield* core.noteConnectionError("github", new Error("network down"));

        return yield* core.status;
      }).pipe(Effect.provide(makeCoreLayer())),
    );

    expect(status.servers[0]).toEqual(
      expect.objectContaining({
        status: "auth_failed",
        lastError: "network down",
      }),
    );
    expect(status.servers[0]?.message).toBeUndefined();
    expect(internalAuthorizationUrl(status.servers[0])).toBeUndefined();
  });

  it("clears stale auth fields when authorization succeeds", async () => {
    const status = await Effect.runPromise(
      Effect.gen(function* () {
        const core = yield* AuthCoordinatorCore;
        yield* core.noteConfigured(
          "github",
          "github",
          httpConfig("https://github.example/mcp"),
        );
        yield* core.setAuthorizationUrl(
          "github",
          new URL("https://github.example/oauth"),
        );
        yield* core.noteConnectionError("github", new Error("network down"));
        yield* core.markAuthorized("github");

        return yield* core.status;
      }).pipe(Effect.provide(makeCoreLayer())),
    );

    expect(status.servers[0]).toEqual(
      expect.objectContaining({
        status: "connected",
      }),
    );
    expect(internalAuthorizationUrl(status.servers[0])).toBeUndefined();
    expect(status.servers[0]?.message).toBeUndefined();
    expect(status.servers[0]?.lastError).toBeUndefined();
  });

  it("keeps public authorizeUrl separate from the captured provider authorization URL", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const core = yield* AuthCoordinatorCore;
        yield* core.noteConfigured(
          "github",
          "github",
          httpConfig("https://github.example/mcp"),
        );
        yield* core.setAuthorizationUrl(
          "github",
          new URL("https://github.example/login/oauth/authorize?client_id=abc"),
        );

        const status = yield* core.status;
        const authorizationUrl = yield* core.authorizationUrlFor("github");

        return { status, authorizationUrl };
      }).pipe(Effect.provide(makeCoreLayer())),
    );

    expect(result.status.servers[0]).toEqual(
      expect.objectContaining({
        authorizeUrl: "https://ptools.example/auth/github",
      }),
    );
    expect(result.authorizationUrl).toBe(
      "https://github.example/login/oauth/authorize?client_id=abc",
    );
  });

  it("keeps the captured provider URL while authorization is in progress", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const core = yield* AuthCoordinatorCore;
        yield* core.noteConfigured(
          "github",
          "github",
          httpConfig("https://github.example/mcp"),
        );
        yield* core.setAuthorizationUrl(
          "github",
          new URL("https://github.example/login/oauth/authorize?client_id=abc"),
        );
        yield* core.markAuthorizationInProgress("github");

        const status = yield* core.status;
        const authorizationUrl = yield* core.authorizationUrlFor("github");

        return { status, authorizationUrl };
      }).pipe(Effect.provide(makeCoreLayer())),
    );

    expect(result.status.servers[0]).toEqual(
      expect.objectContaining({
        status: "auth_in_progress",
        message: "Waiting for authorization for github.",
      }),
    );
    expect(result.authorizationUrl).toBe(
      "https://github.example/login/oauth/authorize?client_id=abc",
    );
  });

  it("caches providers and marks OAuth attachment", async () => {
    const calls = { makeProvider: 0 };
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const core = yield* AuthCoordinatorCore;
        const config: HttpMcpConfig = httpConfig("https://github.example/mcp");
        const first = yield* core.providerFor("github", config);
        const second = yield* core.providerFor("github", config);
        const shouldAttach = yield* core.shouldAttachAuthProvider("github");

        return { same: first === second, shouldAttach };
      }).pipe(Effect.provide(makeCoreLayer(calls))),
    );

    expect(calls.makeProvider).toBe(1);
    expect(result).toEqual({ same: true, shouldAttach: true });
  });

  it("invalidates cached providers when a server is reconfigured", async () => {
    const calls = { makeProvider: 0 };
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const core = yield* AuthCoordinatorCore;
        yield* core.noteConfigured(
          "github",
          "github",
          httpConfig("https://github.example/mcp"),
        );
        const first = yield* core.providerFor(
          "github",
          httpConfig("https://github.example/mcp"),
        );
        yield* core.noteConfigured(
          "github",
          "github",
          httpConfig("https://github.example/v2/mcp"),
        );
        const shouldAttachAfterReconfigure =
          yield* core.shouldAttachAuthProvider("github");
        const second = yield* core.providerFor(
          "github",
          httpConfig("https://github.example/v2/mcp"),
        );

        return {
          same: first === second,
          shouldAttachAfterReconfigure,
        };
      }).pipe(Effect.provide(makeCoreLayer(calls))),
    );

    expect(calls.makeProvider).toBe(2);
    expect(result).toEqual({
      same: false,
      shouldAttachAfterReconfigure: false,
    });
  });

  it("removes HTTP auth state when a server is reconfigured to non-HTTP", async () => {
    const status = await Effect.runPromise(
      Effect.gen(function* () {
        const core = yield* AuthCoordinatorCore;
        yield* core.noteConfigured(
          "local",
          "local",
          httpConfig("https://example.com/mcp"),
        );
        yield* core.setAuthorizationUrl(
          "local",
          new URL("https://example.com/oauth"),
        );
        yield* core.noteConfigured("local", "local", stdioConfig("node"));

        return yield* core.status;
      }).pipe(Effect.provide(makeCoreLayer())),
    );

    expect(status.servers).toHaveLength(0);
  });

  it("fails fast when mutating an unconfigured server", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const core = yield* AuthCoordinatorCore;
        return yield* core.noteConnected("missing").pipe(Effect.either);
      }).pipe(Effect.provide(makeCoreLayer())),
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left.message).toBe(
        "No HTTP MCP server named missing is configured.",
      );
    }
  });

  it("returns false when stored credential lookup fails", async () => {
    const hasCredentials = await Effect.runPromise(
      Effect.gen(function* () {
        const core = yield* AuthCoordinatorCore;
        return yield* core.hasStoredCredentials(
          "github",
          httpConfig("https://github.example/mcp"),
        );
      }).pipe(
        Effect.provide(
          makeCoreLayer(undefined, {
            hasStoredCredentials: () =>
              Effect.fail(
                new CredentialError({
                  message: "credential store unavailable",
                }),
              ),
          }),
        ),
      ),
    );

    expect(hasCredentials).toBe(false);
  });

  it("resets runtime-only status when rebuilt", async () => {
    const run = () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const core = yield* AuthCoordinatorCore;
          return yield* core.status;
        }).pipe(Effect.provide(makeCoreLayer())),
      );

    const first = await Effect.runPromise(
      Effect.gen(function* () {
        const core = yield* AuthCoordinatorCore;
        yield* core.noteConfigured(
          "github",
          "github",
          httpConfig("https://github.example/mcp"),
        );
        yield* core.setAuthorizationUrl(
          "github",
          new URL("https://github.example/oauth"),
        );
        return yield* core.status;
      }).pipe(Effect.provide(makeCoreLayer())),
    );
    const second = await run();

    expect(first.servers).toHaveLength(1);
    expect(second.servers).toHaveLength(0);
  });
});

const makeCoreLayer = (
  calls: { makeProvider: number } = { makeProvider: 0 },
  overrides: Partial<AuthCoordinatorOAuthProvider> = {},
) =>
  AuthCoordinatorCoreLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(AuthCoordinatorPolicy, policy),
        Layer.succeed(
          AuthProviderFactory,
          AuthProviderFactory.of({
            makeProvider: (input) =>
              Effect.sync(() => {
                calls.makeProvider += 1;
                return makeProvider(input.config, overrides);
              }),
          }),
        ),
      ),
    ),
  );

const internalAuthorizationUrl = (status: unknown): unknown =>
  (status as Record<string, unknown> | undefined)?.authorizationUrl;

const makeProvider = (
  config: HttpMcpConfig,
  overrides: Partial<AuthCoordinatorOAuthProvider>,
): AuthCoordinatorOAuthProvider => {
  const redirectUrl = String(
    Option.getOrElse(
      Option.flatMap(config.auth, (auth) => auth.redirectUri),
      () => "https://ptools.example/oauth/callback",
    ),
  );

  return {
    get redirectUrl(): string {
      return redirectUrl;
    },
    get clientMetadata(): OAuthClientMetadata {
      return {
        redirect_uris: [redirectUrl],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        client_name: "ptools",
      };
    },
    state: () => "state",
    clientInformation: (): Promise<OAuthClientInformationMixed | undefined> =>
      Promise.resolve(undefined),
    saveClientInformation: (): Promise<void> => Promise.resolve(),
    tokens: (): Promise<OAuthTokens | undefined> => Promise.resolve(undefined),
    saveTokens: (): Promise<void> => Promise.resolve(),
    redirectToAuthorization: () => {},
    saveCodeVerifier: () => {},
    codeVerifier: () => "verifier",
    invalidateCredentials: (): Promise<void> => Promise.resolve(),
    saveDiscoveryState: () => {},
    discoveryState: () => undefined,
    hasStoredCredentials: () => Effect.succeed(false),
    ...overrides,
  };
};

const httpConfig = (
  url: string,
  options: {
    readonly headers?: Readonly<Record<string, string>>;
    readonly auth?: {
      readonly scope?: string;
      readonly resourceMetadataUrl?: string;
      readonly clientId?: string;
      readonly clientSecret?: string;
      readonly clientMetadataUrl?: string;
      readonly redirectUri?: string;
    };
  } = {},
): ResolvedHttpMcpConfig =>
  ResolvedHttpMcpConfig.make({
    url,
    headers: Option.fromNullable(options.headers),
    auth: Option.fromNullable(options.auth).pipe(
      Option.map((auth) =>
        ResolvedHttpMcpAuthConfig.make({
          type: "oauth",
          scope: Option.fromNullable(auth.scope),
          resourceMetadataUrl: Option.fromNullable(auth.resourceMetadataUrl),
          clientId: Option.fromNullable(auth.clientId),
          clientSecret: Option.fromNullable(auth.clientSecret),
          clientMetadataUrl: Option.fromNullable(auth.clientMetadataUrl),
          redirectUri: Option.fromNullable(auth.redirectUri),
        }),
      ),
    ),
  });

const stdioConfig = (command: string): ResolvedStdioMcpConfig =>
  ResolvedStdioMcpConfig.make({
    command,
    args: Option.none(),
    env: Option.none(),
    cwd: Option.none(),
  });
