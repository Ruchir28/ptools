import type { HttpMcpConfig } from "@ptools/auth";
import {
  ResolvedHttpMcpAuthConfig,
  ResolvedHttpMcpConfig,
} from "@ptools/config";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import { codeModeObjectCredentialTokensKey } from "../src/layers/auth/keys.js";
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
      [codeModeObjectCredentialTokensKey("server/name"), "not-json"],
    ]);
    const provider = makeProvider(
      httpConfig("https://mcp.example"),
      makePlatform(credentials),
    );

    await expect(provider.tokens()).rejects.toThrow(
      "Failed to parse Cloudflare credential",
    );
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

const makePlatform = (
  credentials = new Map<string, string>(),
): CloudflareOAuthPlatform => {
  return {
    storage: {
      get: () => Effect.succeed(Option.none()),
      put: () => Effect.void,
      delete: () => Effect.void,
      list: () => Effect.succeed(new Map()),
    },
    hostId: "host id",
    origin: "https://ptools.example",
    credentialsStore: {
      get: (key) => Effect.succeed(credentials.get(key)),
      set: (key, value) =>
        Effect.sync(() => {
          credentials.set(key, value);
        }),
      delete: (key) =>
        Effect.sync(() => {
          credentials.delete(key);
        }),
    },
  };
};
