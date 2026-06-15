import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { AuthCoordinator } from "@ptools/auth";
import {
  ResolvedHttpMcpAuthConfig,
  ResolvedHttpMcpConfig,
  ResolvedStdioMcpConfig,
} from "@ptools/config";
import { HttpMcpConnector, McpConnector } from "@ptools/mcp-registry";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";
import {
  CloudflareHttpMcpConnectorLayer,
  CloudflareMcpConnectorLayer,
} from "../src/layers/mcpConnector.js";

describe("Cloudflare MCP connector layers", () => {
  it("rejects stdio in the top-level Cloudflare McpConnector", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connector = yield* McpConnector;

          return yield* connector
            .connect({
              serverName: "local",
              jsServerName: "local",
              config: ResolvedStdioMcpConfig.make({
                command: "node",
                args: Option.none(),
                env: Option.none(),
                cwd: Option.none(),
              }),
            })
            .pipe(Effect.either);
        }).pipe(
          Effect.provide(
            CloudflareMcpConnectorLayer.pipe(
              Layer.provide(makeUnavailableHttpConnectorLayer()),
            ),
          ),
        ),
      ),
    );

    expect(result._tag).toBe("Left");
    if (result._tag !== "Left") {
      throw new Error("Expected stdio connection to fail.");
    }

    expect(String(result.left.cause)).toContain(
      "stdio MCP over Containers is deferred",
    );
  });

  it("asks AuthCoordinator for an OAuth provider when HTTP config has auth", async () => {
    const calls = { providerFor: 0 };

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connector = yield* HttpMcpConnector;

          yield* connector
            .connect({
              serverName: "remote",
              jsServerName: "remote",
              config: ResolvedHttpMcpConfig.make({
                url: "http://127.0.0.1:1/mcp",
                headers: Option.none(),
                auth: Option.some(emptyAuthConfig()),
              }),
            })
            .pipe(Effect.either);
        }).pipe(
          Effect.provide(
            CloudflareHttpMcpConnectorLayer.pipe(
              Layer.provide(makeTestAuthCoordinatorLayer(calls)),
            ),
          ),
        ),
      ),
    );

    expect(calls.providerFor).toBe(1);
  });

  it("forwards static HTTP headers without creating an OAuth provider", async () => {
    const calls = { providerFor: 0 };
    const captured = await withHeaderCaptureServer(async (url) => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const connector = yield* HttpMcpConnector;

            yield* connector
              .connect({
                serverName: "remote",
                jsServerName: "remote",
                config: ResolvedHttpMcpConfig.make({
                  url,
                  headers: Option.some({
                    authorization: "Bearer static-token",
                  }),
                  auth: Option.none(),
                }),
              })
              .pipe(Effect.either);
          }).pipe(
            Effect.provide(
              CloudflareHttpMcpConnectorLayer.pipe(
                Layer.provide(makeTestAuthCoordinatorLayer(calls)),
              ),
            ),
          ),
        ),
      );
    });

    expect(calls.providerFor).toBe(0);
    expect(captured.authorization).toBe("Bearer static-token");
  });
});

const emptyAuthConfig = (): ResolvedHttpMcpAuthConfig =>
  ResolvedHttpMcpAuthConfig.make({
    type: "oauth",
    scope: Option.none(),
    resourceMetadataUrl: Option.none(),
    clientId: Option.none(),
    clientSecret: Option.none(),
    clientMetadataUrl: Option.none(),
    redirectUri: Option.none(),
  });

const makeUnavailableHttpConnectorLayer = () =>
  Layer.succeed(HttpMcpConnector, {
    connect: () => Effect.die("HTTP connector should not be called"),
  });

const makeTestAuthCoordinatorLayer = (calls: { providerFor: number }) =>
  Layer.succeed(AuthCoordinator, {
    origin: Effect.succeed("https://ptools.example/hosts/demo/auth"),
    callbackUrl: (serverName) =>
      Effect.succeed(
        `https://ptools.example/hosts/demo/oauth/callback/${encodeURIComponent(serverName)}`,
      ),
    noteConfigured: () => Effect.void,
    noteConnected: () => Effect.void,
    noteConnectionError: () => Effect.void,
    shouldAttachAuthProvider: () => Effect.succeed(false),
    hasStoredCredentials: () => Effect.succeed(false),
    providerFor: () => {
      calls.providerFor += 1;

      return Effect.succeed({} as OAuthClientProvider);
    },
    status: Effect.succeed({
      authUrl: "https://ptools.example/hosts/demo/auth",
      servers: [],
    }),
  });

const withHeaderCaptureServer = async (
  run: (url: string) => Promise<void>,
): Promise<IncomingMessage["headers"]> => {
  const captured = await new Promise<IncomingMessage["headers"]>(
    (resolve, reject) => {
      const server = createServer((request, response) => {
        resolve(request.headers);
        response.writeHead(500, { "content-type": "text/plain" });
        response.end("stop");
      });

      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address() as AddressInfo;

        run(`http://127.0.0.1:${address.port}/mcp`).finally(() => {
          server.close();
        });
      });
    },
  );

  return captured;
};
