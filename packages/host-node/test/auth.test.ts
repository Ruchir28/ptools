import { auth as sdkAuth } from "@modelcontextprotocol/sdk/client/auth.js";
import { AuthCoordinator, CredentialsStore } from "@ptools/auth";
import { ResolvedHttpMcpConfig } from "@ptools/config";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it, vi } from "vitest";
import { NodeAuthCoordinatorLive } from "../src/auth.js";

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
          /^http:\/\/127\.0\.0\.1:\d+\/auth\/notion\?force=1$/,
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

  it("starts reauthorization from a connected HTTP server", async () => {
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

          yield* auth.noteConfigured(
            "sheets",
            "sheets",
            httpConfig("https://mcp.example/sheets"),
          );

          const origin = yield* auth.origin;

          return yield* Effect.promise(() =>
            fetch(`${origin}/auth/sheets?force=1`, { redirect: "manual" }),
          );
        }),
      ).pipe(Effect.provide(makeTestNodeAuthCoordinatorLive())),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://accounts.example/authorize?client_id=ptools",
    );
  });

  it("serves the auth status from the local callback server", async () => {
    const responseStatus = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const auth = yield* AuthCoordinator;

          yield* auth.noteConfigured(
            "notion",
            "notion",
            httpConfig("https://mcp.notion.com/mcp"),
          );

          const origin = yield* auth.origin;

          return yield* Effect.promise(async () => {
            const response = await fetch(`${origin}/status.json`);
            return (await response.json()) as unknown;
          });
        }),
      ).pipe(Effect.provide(makeTestNodeAuthCoordinatorLive())),
    );

    expect(responseStatus).toEqual(
      expect.objectContaining({
        servers: [
          expect.objectContaining({
            serverName: "notion",
            status: "connected",
          }),
        ],
      }),
    );
  });

  it("runs manual per-server refresh from the auth center", async () => {
    const refreshedServers: Array<string> = [];
    const responseText = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const auth = yield* AuthCoordinator;

          if (auth.setRefreshHandler === undefined) {
            throw new Error("Node auth coordinator does not expose refresh");
          }

          yield* auth.setRefreshHandler((serverName) => {
            refreshedServers.push(serverName);
            return Promise.resolve();
          });

          const origin = yield* auth.origin;

          return yield* Effect.promise(async () => {
            const response = await fetch(`${origin}/refresh/notion`);
            return response.text();
          });
        }),
      ).pipe(Effect.provide(makeTestNodeAuthCoordinatorLive())),
    );

    expect(responseText).toContain("Refresh complete");
    expect(refreshedServers).toEqual(["notion"]);
  });
});

const makeTestNodeAuthCoordinatorLive = () =>
  NodeAuthCoordinatorLive({ runtimeId: "test", autoOpen: false }).pipe(
    Layer.provide(makeMemoryCredentialsStoreLive()),
  );

const makeMemoryCredentialsStoreLive = () => {
  const values = new Map<string, string>();

  return Layer.succeed(CredentialsStore, {
    get: (key) => Effect.succeed(values.get(key)),
    set: (key, value) =>
      Effect.sync(() => {
        values.set(key, value);
      }),
    delete: (key) =>
      Effect.sync(() => {
        values.delete(key);
      }),
  });
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
