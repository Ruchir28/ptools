import { fileURLToPath } from "node:url";
import { Effect } from "effect";
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
          }),
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
});
