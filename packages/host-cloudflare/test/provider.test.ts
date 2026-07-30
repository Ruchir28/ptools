import {
  McpOAuthProvider,
  mcpOAuthCredentialKey,
  type HttpMcpConfig,
  type McpOAuthCredentialIdentity,
  type McpOAuthCredentialSlot,
  type McpOAuthCredentialStoreService,
  type McpOAuthProviderOperations,
} from "@ptools/auth";
import {
  ResolvedHttpMcpAuthConfig,
  ResolvedHttpMcpConfig,
} from "@ptools/config";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";

describe("McpOAuthProvider", () => {
  it("models missing auth config as dynamic client registration", async () => {
    const provider = makeProvider(httpConfig("https://mcp.example"));

    expect(provider.redirectUrl).toBe(
      "https://ptools.example/hosts/host%20id/oauth/callback/server%2Fname",
    );
    expect(provider.clientMetadataUrl).toBeUndefined();
    expect(provider.clientMetadata).toMatchObject({
      token_endpoint_auth_method: "none",
    });
    expect(provider.clientMetadata).not.toHaveProperty("scope");
    await expect(provider.clientInformation()).resolves.toBeUndefined();
  });

  it("keeps pre-registered client state together", async () => {
    const provider = makeProvider(
      httpConfig("https://mcp.example", {
        scope: "repo",
        clientId: "client-id",
        clientSecret: "client-secret",
        clientMetadataUrl: "https://ptools.example/client.json",
        redirectUri: "https://ptools.example/oauth/callback",
      }),
    );

    expect(provider.redirectUrl).toBe("https://ptools.example/oauth/callback");
    expect(provider.clientMetadataUrl).toBe(
      "https://ptools.example/client.json",
    );
    expect(provider.clientMetadata).toMatchObject({
      scope: "repo",
      token_endpoint_auth_method: "client_secret_basic",
    });
    await expect(provider.clientInformation()).resolves.toEqual({
      client_id: "client-id",
      client_secret: "client-secret",
    });
  });

  it("unwraps stored credential absence only at the SDK boundary", async () => {
    const provider = makeProvider(httpConfig("https://mcp.example"));

    expect(await Effect.runPromise(provider.hasStoredCredentials())).toBe(
      false,
    );
    await provider.saveTokens({ access_token: "token", token_type: "bearer" });
    expect(await Effect.runPromise(provider.hasStoredCredentials())).toBe(true);
    await expect(provider.tokens()).resolves.toEqual({
      access_token: "token",
      token_type: "bearer",
    });
  });

  it("fails when a stored credential contains malformed JSON", async () => {
    const credentials = new Map([
      [
        mcpOAuthCredentialKey(
          { serverName: "server/name", serverUrl: "https://mcp.example" },
          "tokens",
        ),
        "not-json",
      ],
    ]);
    const provider = makeProvider(
      httpConfig("https://mcp.example"),
      makeOperations(credentials),
    );

    await expect(provider.tokens()).rejects.toThrow();
  });
});

const makeProvider = (
  config: HttpMcpConfig,
  operations = makeOperations(),
): McpOAuthProvider =>
  new McpOAuthProvider({
    operations,
    serverName: "server/name",
    config,
    callbackUrl: (serverName) =>
      `https://ptools.example/hosts/host%20id/oauth/callback/${encodeURIComponent(serverName)}`,
  });

const httpConfig = (
  url: string,
  auth?: {
    readonly scope?: string;
    readonly clientId?: string;
    readonly clientSecret?: string;
    readonly clientMetadataUrl?: string;
    readonly redirectUri?: string;
  },
): ResolvedHttpMcpConfig =>
  ResolvedHttpMcpConfig.make({
    url,
    headers: Option.none(),
    auth: Option.fromNullishOr(auth).pipe(
      Option.map((value) =>
        ResolvedHttpMcpAuthConfig.make({
          type: "oauth",
          scope: Option.fromNullishOr(value.scope),
          resourceMetadataUrl: Option.none(),
          clientId: Option.fromNullishOr(value.clientId),
          clientSecret: Option.fromNullishOr(value.clientSecret),
          clientMetadataUrl: Option.fromNullishOr(value.clientMetadataUrl),
          redirectUri: Option.fromNullishOr(value.redirectUri),
        }),
      ),
    ),
  });

const makeCredentialKey = (
  identity: McpOAuthCredentialIdentity,
  slot: McpOAuthCredentialSlot,
) => mcpOAuthCredentialKey(identity, slot);

const makeMemoryOAuthCredentialStore = (
  credentials: Map<string, string>,
): McpOAuthCredentialStoreService => ({
  getClientInformation: (identity: McpOAuthCredentialIdentity) =>
    readJson(credentials, identity, "client") as ReturnType<
      McpOAuthCredentialStoreService["getClientInformation"]
    >,
  setClientInformation: (
    identity: McpOAuthCredentialIdentity,
    value: unknown,
  ) => writeJson(credentials, identity, "client", value),
  getTokens: (identity: McpOAuthCredentialIdentity) =>
    readJson(credentials, identity, "tokens") as ReturnType<
      McpOAuthCredentialStoreService["getTokens"]
    >,
  setTokens: (identity: McpOAuthCredentialIdentity, value: unknown) =>
    writeJson(credentials, identity, "tokens", value),
  getCodeVerifier: (identity: McpOAuthCredentialIdentity) =>
    Effect.succeed(
      credentials.get(makeCredentialKey(identity, "pkce-verifier")) ??
        "verifier",
    ),
  setCodeVerifier: (identity: McpOAuthCredentialIdentity, value: string) =>
    Effect.sync(() => {
      credentials.set(makeCredentialKey(identity, "pkce-verifier"), value);
    }),
  getDiscoveryState: (identity: McpOAuthCredentialIdentity) =>
    readJson(credentials, identity, "discovery") as ReturnType<
      McpOAuthCredentialStoreService["getDiscoveryState"]
    >,
  setDiscoveryState: (identity: McpOAuthCredentialIdentity, value: unknown) =>
    writeJson(credentials, identity, "discovery", value),
  hasStoredCredentials: (identity: McpOAuthCredentialIdentity) =>
    Effect.succeed(credentials.has(makeCredentialKey(identity, "tokens"))),
  invalidate: (identity, scope) =>
    Effect.sync(() => {
      for (const slot of [
        "client",
        "tokens",
        "pkce-verifier",
        "discovery",
      ] as const) {
        if (
          scope === "all" ||
          scope === slot ||
          (scope === "verifier" && slot === "pkce-verifier")
        ) {
          credentials.delete(makeCredentialKey(identity, slot));
        }
      }
    }),
});

const readJson = (
  credentials: Map<string, string>,
  identity: McpOAuthCredentialIdentity,
  slot: McpOAuthCredentialSlot,
) =>
  Effect.sync(() =>
    Option.fromNullishOr(credentials.get(makeCredentialKey(identity, slot))),
  ).pipe(
    Effect.flatMap((value) =>
      Option.match(value, {
        onNone: () => Effect.succeedNone,
        onSome: (json) =>
          Effect.sync(() => JSON.parse(json) as unknown).pipe(
            Effect.map(Option.some),
          ),
      }),
    ),
  );

const writeJson = (
  credentials: Map<string, string>,
  identity: McpOAuthCredentialIdentity,
  slot: McpOAuthCredentialSlot,
  value: unknown,
) =>
  Effect.sync(() => {
    credentials.set(makeCredentialKey(identity, slot), JSON.stringify(value));
  });

const makeOperations = (
  credentials = new Map<string, string>(),
): McpOAuthProviderOperations => {
  const identity: McpOAuthCredentialIdentity = {
    serverName: "server/name",
    serverUrl: "https://mcp.example",
  };
  const store = makeMemoryOAuthCredentialStore(credentials);

  return {
    createState: () => Promise.resolve("signed-state"),
    getClientInformation: () =>
      Effect.runPromise(
        store
          .getClientInformation(identity)
          .pipe(Effect.map(Option.getOrUndefined)),
      ),
    setClientInformation: (information) =>
      Effect.runPromise(store.setClientInformation(identity, information)),
    getTokens: () =>
      Effect.runPromise(
        store.getTokens(identity).pipe(Effect.map(Option.getOrUndefined)),
      ),
    setTokens: (tokens) => Effect.runPromise(store.setTokens(identity, tokens)),
    hasStoredCredentials: () => store.hasStoredCredentials(identity),
    notifyAuthorizationUrl: () => undefined,
    setCodeVerifier: (verifier) =>
      Effect.runPromise(store.setCodeVerifier(identity, verifier)),
    getCodeVerifier: () => Effect.runPromise(store.getCodeVerifier(identity)),
    invalidateCredentials: (scope) =>
      Effect.runPromise(store.invalidate(identity, scope)),
    setDiscoveryState: (state) =>
      Effect.runPromise(store.setDiscoveryState(identity, state)),
    getDiscoveryState: () =>
      Effect.runPromise(
        store
          .getDiscoveryState(identity)
          .pipe(Effect.map(Option.getOrUndefined)),
      ),
  };
};
