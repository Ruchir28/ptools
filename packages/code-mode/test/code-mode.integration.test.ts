import { AuthCoordinator, AuthError } from "@ptools/auth";
import { makeLocalSandboxExecutorLive } from "@ptools/executor";
import { ResolvedStdioMcpConfig } from "@ptools/config";
import {
  makeMcpRegistryLive,
  McpConnector,
  type ConnectedMcpClient,
} from "@ptools/mcp-registry";
import { Effect, Either, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";
import { CodeMode, makeCodeModeLive } from "../src/index.js";
import { CodeModeExecuteError } from "../src/errors.js";

describe("CodeMode stdio MCP integration", () => {
  it("discovers and executes MCP-backed provider calls through the local executor", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const codeMode = yield* CodeMode;
        const providerResult = yield* codeMode.searchProviders();
        const echoContext = yield* codeMode.search({ query: "echo" });
        const echoSchema = yield* codeMode.toolSchema({
          toolIds: ["fixture.echo"],
        });
        const echoRun = yield* codeMode.execute({
          code: `async () => {
            console.log("calling echo");
            return await fixture.echo({ text: "hello from code mode" });
          }`,
        });
        const addRun = yield* codeMode.execute({
          code: `async () => {
            return await fixture.add({ a: 2, b: 3 });
          }`,
        });
        const caughtProviderError = yield* codeMode.execute({
          code: `async () => {
            try {
              await fixture.add({ a: "bad", b: 3 });
            } catch (error) {
              return {
                name: error.name,
                message: error.message,
              };
            }
          }`,
        });
        const uncaughtProviderError = yield* Effect.either(
          codeMode.execute({
            code: `async () => {
              return await fixture.add({ a: "bad", b: 3 });
            }`,
          }),
        );

        return {
          providerResult,
          echoContext,
          echoSchema,
          echoRun,
          addRun,
          caughtProviderError,
          uncaughtProviderError,
        };
      }).pipe(Effect.provide(makeIntegrationLive())),
    );

    expect(
      result.providerResult.providers.map((item) => item.provider),
    ).toEqual(["fixture"]);
    expect(toToolKeys(result.echoContext)).toEqual(["fixture.echo"]);
    expect(result.providerResult).not.toHaveProperty("declarations");
    expect(result.echoSchema.tools[0]).not.toHaveProperty("declaration");
    expect(result.echoSchema.declarationsByServer[0]?.declaration).toContain(
      "declare namespace fixture",
    );
    expect(result.echoRun.value).toEqual({ text: "hello from code mode" });
    expect(result.echoRun.logs[0]?.message).toBe("calling echo");
    expect(result.addRun.value).toEqual({ sum: 5 });
    expect(result.caughtProviderError.value).toEqual(
      expect.objectContaining({
        name: "Error",
      }),
    );
    expect(Either.isLeft(result.uncaughtProviderError)).toBe(true);

    if (Either.isLeft(result.uncaughtProviderError)) {
      expect(result.uncaughtProviderError.left).toBeInstanceOf(
        CodeModeExecuteError,
      );
    }
  });
});

const makeIntegrationLive = () =>
  makeCodeModeLive().pipe(
    Layer.provide(
      Layer.merge(
        makeMcpRegistryLive({
          fixture: ResolvedStdioMcpConfig.make({
            command: "ignored-by-fake-connector",
            args: Option.none(),
            env: Option.none(),
            cwd: Option.none(),
          }),
        }).pipe(
          Layer.provide(makeFakeMcpConnectorLive()),
          Layer.provide(makeTestAuthCoordinatorLive()),
        ),
        makeLocalSandboxExecutorLive(),
      ),
    ),
  );

const makeFakeMcpConnectorLive = () =>
  Layer.succeed(McpConnector, {
    connect: ({ serverName, jsServerName }) =>
      Effect.succeed({
        serverName,
        jsServerName,
        client: {
          listTools: async () => ({
            tools: [
              {
                name: "echo",
                title: "Echo",
                description: "Echo text back to the caller",
                inputSchema: {
                  type: "object",
                  properties: {
                    text: { type: "string" },
                  },
                  required: ["text"],
                },
              },
              {
                name: "add",
                title: "Add",
                description: "Add two numbers",
                inputSchema: {
                  type: "object",
                  properties: {
                    a: { type: "number" },
                    b: { type: "number" },
                  },
                  required: ["a", "b"],
                },
              },
            ],
          }),
          callTool: async (request: {
            readonly name: string;
            readonly arguments?: Record<string, unknown>;
          }) => {
            if (request.name === "echo") {
              return {
                content: [
                  { type: "text", text: String(request.arguments?.text) },
                ],
                structuredContent: { text: request.arguments?.text },
              };
            }

            if (
              typeof request.arguments?.a !== "number" ||
              typeof request.arguments?.b !== "number"
            ) {
              throw new Error("Invalid add arguments");
            }

            const a = request.arguments.a;
            const b = request.arguments.b;
            const sum = a + b;

            return {
              content: [{ type: "text", text: String(sum) }],
              structuredContent: { sum },
            };
          },
          close: async () => undefined,
        },
      } as unknown as ConnectedMcpClient),
  });

const makeTestAuthCoordinatorLive = () =>
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
    providerFor: (serverName) =>
      Effect.fail(
        new AuthError({
          message: `Unexpected auth provider request for ${serverName}`,
        }),
      ),
    status: Effect.succeed({
      authUrl: "http://127.0.0.1/auth",
      servers: [],
    }),
  });

const toToolKeys = (context: {
  readonly actions: ReadonlyArray<{ readonly toolId: string }>;
}) => context.actions.map((action) => action.toolId);
