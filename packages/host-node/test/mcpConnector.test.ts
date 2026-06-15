import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { AuthCoordinator } from "@ptools/auth";
import {
  ResolvedHttpMcpAuthConfig,
  ResolvedHttpMcpConfig,
  ResolvedStdioMcpConfig,
} from "@ptools/config";
import { HttpMcpConnector, StdioMcpConnector } from "@ptools/mcp-registry";
import {
  NodeHttpMcpConnectorLive,
  NodeStdioMcpConnectorLive,
} from "../src/index.js";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";

const fixturePath = fileURLToPath(
  new URL(
    "../../mcp-registry/test/fixtures/stdio-mcp-server.ts",
    import.meta.url,
  ),
);

describe("Node MCP connector layers", () => {
  it("connects to a real stdio MCP server and closes it with the scope", async () => {
    const tools = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connector = yield* StdioMcpConnector;
          const connected = yield* connector.connect({
            serverName: "fixture",
            jsServerName: "fixture",
            config: ResolvedStdioMcpConfig.make({
              command: process.execPath,
              args: Option.some(["--import", "tsx", fixturePath]),
              env: Option.none(),
              cwd: Option.none(),
            }),
          });

          return yield* Effect.promise(() => connected.client.listTools()).pipe(
            Effect.map(
              (page) =>
                page as {
                  readonly tools: ReadonlyArray<{ readonly name: string }>;
                },
            ),
          );
        }).pipe(Effect.provide(NodeStdioMcpConnectorLive)),
      ),
    );

    expect(toToolNames(tools)).toEqual(["echo", "add"]);
  }, 30_000);

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
            NodeHttpMcpConnectorLive.pipe(
              Layer.provide(makeTestAuthCoordinatorLive(calls)),
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
              NodeHttpMcpConnectorLive.pipe(
                Layer.provide(makeTestAuthCoordinatorLive(calls)),
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

const makeTestAuthCoordinatorLive = (calls: { providerFor: number }) =>
  Layer.succeed(AuthCoordinator, {
    origin: Effect.succeed("http://127.0.0.1/auth"),
    callbackUrl: (serverName) =>
      Effect.succeed(
        `http://127.0.0.1/oauth/callback/${encodeURIComponent(serverName)}`,
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
      authUrl: "http://127.0.0.1/auth",
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

const toToolNames = (page: {
  readonly tools: ReadonlyArray<{ readonly name: string }>;
}): ReadonlyArray<string> => page.tools.map((tool) => tool.name);
