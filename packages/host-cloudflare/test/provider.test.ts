import {
  mcpOAuthCredentialKey,
  type HttpMcpConfig,
  type McpOAuthCredentialIdentity,
  type McpOAuthCredentialSlot,
  type McpOAuthCredentialStoreService,
} from "@ptools/auth";
import {
  ResolvedHttpMcpAuthConfig,
  ResolvedHttpMcpConfig,
} from "@ptools/config";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import { CloudflareOAuthProvider } from "../src/layers/auth/provider.js";
import type { CloudflareOAuthPlatform } from "../src/layers/auth/types.js";

describe("CloudflareOAuthProvider", () => {
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
      makePlatform(credentials),
    );

    await expect(provider.tokens()).rejects.toThrow();
  });
});

const makeProvider = (
  config: HttpMcpConfig,
  platform = makePlatform(),
): CloudflareOAuthProvider =>
  new CloudflareOAuthProvider({
    platform,
    serverName: "server/name",
    config,
    onAuthorizationUrl: () => Effect.void,
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
    auth: Option.fromNullable(auth).pipe(
      Option.map((value) =>
        ResolvedHttpMcpAuthConfig.make({
          type: "oauth",
          scope: Option.fromNullable(value.scope),
          resourceMetadataUrl: Option.none(),
          clientId: Option.fromNullable(value.clientId),
          clientSecret: Option.fromNullable(value.clientSecret),
          clientMetadataUrl: Option.fromNullable(value.clientMetadataUrl),
          redirectUri: Option.fromNullable(value.redirectUri),
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
  setClientInformation: (identity: McpOAuthCredentialIdentity, value: unknown) =>
    writeJson(credentials, identity, "client", value),
  getTokens: (identity: McpOAuthCredentialIdentity) =>
    readJson(credentials, identity, "tokens") as ReturnType<
      McpOAuthCredentialStoreService["getTokens"]
    >,
  setTokens: (identity: McpOAuthCredentialIdentity, value: unknown) =>
    writeJson(credentials, identity, "tokens", value),
  getCodeVerifier: (identity: McpOAuthCredentialIdentity) =>
    Effect.succeed(
      credentials.get(makeCredentialKey(identity, "pkce-verifier")) ?? "verifier",
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
      for (const slot of ["client", "tokens", "pkce-verifier", "discovery"] as const) {
        if (scope === "all" || scope === slot || (scope === "verifier" && slot === "pkce-verifier")) {
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
  Effect.sync(() => Option.fromNullable(credentials.get(makeCredentialKey(identity, slot)))).pipe(
    Effect.flatMap(
      Effect.transposeMapOption((value) => Effect.sync(() => JSON.parse(value) as unknown)),
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

const makePlatform = (
  credentials = new Map<string, string>(),
): CloudflareOAuthPlatform => {
  return {
    oauthStateStore: {
      sign: () => Effect.succeed("signed-state"),
      verifyAndConsume: () => Effect.die("not used in provider tests"),
    },
    hostId: "host id",
    origin: "https://ptools.example",
    oauthCredentials: makeMemoryOAuthCredentialStore(credentials),
  };
};
