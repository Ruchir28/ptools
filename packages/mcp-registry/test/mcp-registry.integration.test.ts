import { fileURLToPath } from "node:url";
import { AuthCoordinator, AuthError } from "@ptools/auth";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { makeMcpRegistryLive } from "../src/McpRegistryLive.js";
import { McpRegistry } from "../src/registry.js";

describe("McpRegistry stdio integration", () => {
  it("discovers and calls tools from a real stdio MCP server", async () => {
    const fixturePath = fileURLToPath(
      new URL("./fixtures/stdio-mcp-server.ts", import.meta.url),
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* McpRegistry;
        const tools = yield* registry.listTools;
        const echoResult = yield* registry.callTool({
          jsServerName: "fixture",
          jsToolName: "echo",
          arguments: { text: "hello from stdio" },
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
              command: process.execPath,
              args: ["--import", "tsx", fixturePath],
            },
          }).pipe(Layer.provide(makeTestAuthCoordinatorLive())),
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
        content: [{ type: "text", text: "hello from stdio" }],
        structuredContent: { text: "hello from stdio" },
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
    const fixturePath = fileURLToPath(
      new URL("./fixtures/stdio-mcp-server.ts", import.meta.url),
    );

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
              command: process.execPath,
              args: ["--import", "tsx", fixturePath],
            },
            unavailable: {
              transport: "stdio",
              command: "/path/that/does/not/exist",
            },
          }).pipe(Layer.provide(makeTestAuthCoordinatorLive())),
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
              command: "/path/that/does/not/exist",
            },
          }).pipe(Layer.provide(makeTestAuthCoordinatorLive())),
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
    const fixturePath = fileURLToPath(
      new URL("./fixtures/broken-output-schema-mcp-server.ts", import.meta.url),
    );

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
              command: process.execPath,
              args: ["--import", "tsx", fixturePath],
            },
          }).pipe(Layer.provide(makeTestAuthCoordinatorLive())),
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
