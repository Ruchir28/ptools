import { AuthCoordinator, AuthError } from "@ptools/auth";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { McpConnector } from "../src/connector.js";
import { McpConnectionError } from "../src/errors.js";
import { makeMcpRegistryLive } from "../src/McpRegistryLive.js";
import { McpRegistry } from "../src/registry.js";
import type { ConnectedMcpClient } from "../src/types.js";

describe("McpRegistry connector integration", () => {
  it("discovers and calls tools from the injected MCP connector", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* McpRegistry;
        const tools = yield* registry.listTools;
        const echoResult = yield* registry.callTool({
          jsServerName: "fixture",
          jsToolName: "echo",
          arguments: { text: "hello from connector" },
        });
        const addResult = yield* registry.callTool({
          jsServerName: "fixture",
          jsToolName: "add",
          arguments: { a: 2, b: 3 },
        });

        return { tools, echoResult, addResult };
      }).pipe(
        Effect.provide(
          makeMcpRegistryLive({
            fixture: {
              transport: "stdio",
              command: "ignored-by-fake-connector",
            },
          }).pipe(
            Layer.provide(makeFakeMcpConnectorLive()),
            Layer.provide(makeTestAuthCoordinatorLive()),
          ),
        ),
      ),
    );

    expect(
      result.tools.map((tool) => `${tool.jsServerName}.${tool.jsToolName}`),
    ).toEqual(["fixture.echo", "fixture.add"]);

    expect(result.tools).toContainEqual(
      expect.objectContaining({
        serverName: "fixture",
        originalToolName: "echo",
        jsServerName: "fixture",
        jsToolName: "echo",
        title: "Echo",
        description: "Echo text back to the caller",
        inputSchema: expect.objectContaining({
          type: "object",
          properties: expect.objectContaining({
            text: expect.objectContaining({ type: "string" }),
          }),
        }),
      }),
    );

    expect(result.echoResult).toEqual(
      expect.objectContaining({
        content: [{ type: "text", text: "hello from connector" }],
        structuredContent: { text: "hello from connector" },
      }),
    );
    expect(result.addResult).toEqual(
      expect.objectContaining({
        content: [{ type: "text", text: "5" }],
        structuredContent: { sum: 5 },
      }),
    );
  });

  it("starts with healthy tools when another upstream fails to connect", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* McpRegistry;
        const tools = yield* registry.listTools;
        const diagnostics = yield* registry.diagnostics;

        return { tools, diagnostics };
      }).pipe(
        Effect.provide(
          makeMcpRegistryLive({
            fixture: {
              transport: "stdio",
              command: "ignored-by-fake-connector",
            },
            unavailable: {
              transport: "stdio",
              command: "ignored-by-fake-connector",
            },
          }).pipe(
            Layer.provide(makeFakeMcpConnectorLive()),
            Layer.provide(makeTestAuthCoordinatorLive()),
          ),
        ),
      ),
    );

    expect(
      result.tools.map((tool) => `${tool.jsServerName}.${tool.jsToolName}`),
    ).toEqual(["fixture.echo", "fixture.add"]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "McpConnectionFailed",
        severity: "error",
        serverName: "unavailable",
      }),
    ]);
  });

  it("starts empty when every upstream fails", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* McpRegistry;
        const tools = yield* registry.listTools;
        const diagnostics = yield* registry.diagnostics;

        return { tools, diagnostics };
      }).pipe(
        Effect.provide(
          makeMcpRegistryLive({
            unavailable: {
              transport: "stdio",
              command: "ignored-by-fake-connector",
            },
          }).pipe(
            Layer.provide(makeFakeMcpConnectorLive()),
            Layer.provide(makeTestAuthCoordinatorLive()),
          ),
        ),
      ),
    );

    expect(result.tools).toEqual([]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "McpConnectionFailed",
        severity: "error",
        serverName: "unavailable",
      }),
    ]);
  });

  it("warns for a broken optional output schema while keeping the tool callable", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* McpRegistry;
        const tools = yield* registry.listTools;
        const diagnostics = yield* registry.diagnostics;
        const callResult = yield* registry.callTool({
          jsServerName: "broken",
          jsToolName: "upload_design_md",
          arguments: { text: "hello" },
        });

        return { tools, diagnostics, callResult };
      }).pipe(
        Effect.provide(
          makeMcpRegistryLive({
            broken: {
              transport: "stdio",
              command: "ignored-by-fake-connector",
            },
          }).pipe(
            Layer.provide(makeFakeMcpConnectorLive()),
            Layer.provide(makeTestAuthCoordinatorLive()),
          ),
        ),
      ),
    );

    expect(
      result.tools.map((tool) => `${tool.jsServerName}.${tool.jsToolName}`),
    ).toEqual(["broken.upload_design_md"]);
    expect(result.tools[0]).toEqual(
      expect.objectContaining({
        outputSchemaInvalid: true,
      }),
    );
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "InvalidOutputSchema",
        severity: "warning",
        serverName: "broken",
        toolName: "upload_design_md",
      }),
    ]);
    expect(result.callResult).toEqual(
      expect.objectContaining({
        structuredContent: {
          screen: {
            id: "screen-1",
            text: "hello",
          },
        },
      }),
    );
  });
});

const makeFakeMcpConnectorLive = () =>
  Layer.succeed(McpConnector, {
    connect: ({ serverName, jsServerName }) => {
      if (serverName === "unavailable") {
        return Effect.fail(
          new McpConnectionError({
            serverName,
            cause: new Error("Fixture failed to connect"),
          }),
        );
      }

      return Effect.succeed({
        serverName,
        jsServerName,
        client: makeFakeClient(serverName),
      } as unknown as ConnectedMcpClient);
    },
  });

const makeFakeClient = (serverName: string) => {
  const tools =
    serverName === "broken"
      ? [
          {
            name: "upload_design_md",
            description: "Return a screen while advertising a broken schema",
            inputSchema: textInputSchema,
            outputSchema: {
              type: "object",
              properties: {
                screen: { $ref: "#/$defs/ScreenInstance" },
              },
              required: ["screen"],
            },
          },
        ]
      : [
          {
            name: "echo",
            title: "Echo",
            description: "Echo text back to the caller",
            inputSchema: textInputSchema,
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
        ];

  return {
    listTools: async () => ({ tools }),
    callTool: async (request: {
      readonly name: string;
      readonly arguments?: Record<string, unknown>;
    }) => {
      if (request.name === "echo") {
        const text = request.arguments?.text;

        return {
          content: [{ type: "text", text }],
          structuredContent: { text },
        };
      }

      if (request.name === "add") {
        const a = Number(request.arguments?.a);
        const b = Number(request.arguments?.b);
        const sum = a + b;

        return {
          content: [{ type: "text", text: String(sum) }],
          structuredContent: { sum },
        };
      }

      const text = request.arguments?.text;

      return {
        content: [{ type: "text", text }],
        structuredContent: {
          screen: {
            id: "screen-1",
            text,
          },
        },
      };
    },
    close: async () => undefined,
  };
};

const textInputSchema = {
  type: "object",
  properties: {
    text: { type: "string" },
  },
  required: ["text"],
};

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
