import { auth as sdkAuth } from "@modelcontextprotocol/sdk/client/auth.js";
import { AuthCoordinator, McpOAuthCredentialStore } from "@ptools/auth";
import { HostSecretStorage, ResolvedHttpMcpConfig } from "@ptools/config";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it, vi } from "vitest";
import { NodeAuthCoordinatorLive, NodeMcpAuthFlow } from "../src/auth.js";
import {
  NodeConfigDiscoveryContextLive,
  NodeHostIdentityLive,
  NodeHostSettingsLive,
} from "../src/layers/platform/index.js";

vi.mock("@modelcontextprotocol/sdk/client/auth.js", async (importOriginal) => ({
  ...(await importOriginal()),
  auth: vi.fn(),
}));

describe("NodeAuthCoordinatorLive", () => {
  it("exposes a manual reauthorize URL for connected HTTP servers", async () => {
    const status = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const auth = yield* AuthCoordinator;

          yield* auth.noteConfigured(
            "notion",
            "notion",
            httpConfig("https://mcp.notion.com/mcp"),
          );

          return yield* auth.status;
        }),
      ).pipe(Effect.provide(makeTestNodeAuthCoordinatorLive())),
    );

    expect(status.servers).toHaveLength(1);
    expect(status.servers[0]).toEqual(
      expect.objectContaining({
        serverName: "notion",
        status: "connected",
        reauthorizeUrl: expect.stringMatching(
          /^http:\/\/127\.0\.0\.1:18080\/hosts\/test\/auth\/notion\?force=1$/,
        ),
      }),
    );
    expect(status.servers[0]?.authorizeUrl).toBeUndefined();
  });

  it("does not expose manual reauthorize for static credentials", async () => {
    const status = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const auth = yield* AuthCoordinator;

          yield* auth.noteConfigured(
            "api",
            "api",
            httpConfig("https://example.com/mcp", {
              authorization: "Bearer token",
            }),
          );

          return yield* auth.status;
        }),
      ).pipe(Effect.provide(makeTestNodeAuthCoordinatorLive())),
    );

    expect(status.servers).toHaveLength(1);
    expect(status.servers[0]).toEqual(
      expect.objectContaining({
        serverName: "api",
        status: "static_credentials",
      }),
    );
    expect(status.servers[0]?.reauthorizeUrl).toBeUndefined();
  });

  it("starts reauthorization through the Node auth flow service", async () => {
    vi.mocked(sdkAuth).mockImplementationOnce(async (provider) => {
      provider.redirectToAuthorization(
        new URL("https://accounts.example/authorize?client_id=ptools"),
      );
      return "REDIRECT";
    });

    const response = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const auth = yield* AuthCoordinator;
          const flow = yield* NodeMcpAuthFlow;

          yield* auth.noteConfigured(
            "sheets",
            "sheets",
            httpConfig("https://mcp.example/sheets"),
          );

          return yield* flow.beginAuthorization({
            serverName: "sheets",
            force: true,
          });
        }),
      ).pipe(Effect.provide(makeTestNodeAuthCoordinatorLive())),
    );

    expect(response).toEqual({
      authorizeUrl: "https://accounts.example/authorize?client_id=ptools",
    });
  });

  it("builds OAuth callback URLs on the shared Host API route", async () => {
    const callbackUrl = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const auth = yield* AuthCoordinator;

          yield* auth.noteConfigured(
            "notion",
            "notion",
            httpConfig("https://mcp.notion.com/mcp"),
          );

          return yield* auth.callbackUrl("notion");
        }),
      ).pipe(Effect.provide(makeTestNodeAuthCoordinatorLive())),
    );

    expect(callbackUrl).toBe(
      "http://127.0.0.1:18080/hosts/test/oauth/callback/notion",
    );
  });

  it("uses the configured Host API origin", async () => {
    const origin = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const auth = yield* AuthCoordinator;
          return yield* auth.origin;
        }),
      ).pipe(Effect.provide(makeTestNodeAuthCoordinatorLive())),
    );

    expect(origin).toBe("http://127.0.0.1:18080");
  });
});

const makeTestNodeAuthCoordinatorLive = () => {
  const discoveryLayer = NodeConfigDiscoveryContextLive({ env: {} });
  const settingsLayer = NodeHostSettingsLive({
    publicOrigin: "http://127.0.0.1:18080",
    auth: { autoOpen: false },
  }).pipe(Layer.provide(discoveryLayer));
  const identityLayer = NodeHostIdentityLive("test");

  return NodeAuthCoordinatorLive().pipe(
    Layer.provide(makeMemoryOAuthCredentialStoreLive()),
    Layer.provide(Layer.merge(settingsLayer, identityLayer)),
  );
};

const makeMemoryOAuthCredentialStoreLive = () => {
  const values = new Map<string, string>();
  const storage = {
    get: (key: string) => Effect.succeed(Option.fromNullable(values.get(key))),
    put: (key: string, value: string) =>
      Effect.sync(() => {
        values.set(key, value);
      }),
    delete: (key: string) =>
      Effect.sync(() => {
        values.delete(key);
      }),
  };

  return McpOAuthCredentialStore.Default.pipe(
    Layer.provide(Layer.succeed(HostSecretStorage, storage)),
  );
};

const httpConfig = (
  url: string,
  headers?: Readonly<Record<string, string>>,
): ResolvedHttpMcpConfig =>
  ResolvedHttpMcpConfig.make({
    url,
    headers: Option.fromNullable(headers),
    auth: Option.none(),
  });
