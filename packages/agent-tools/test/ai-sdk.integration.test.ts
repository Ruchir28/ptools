import { fileURLToPath } from "node:url";
import { generateText, stepCountIs, type ToolSet } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { toAISDKTools } from "../src/ai-sdk.js";
import { createPtoolsSession } from "../src/session.js";

describe("AI SDK adapter integration", () => {
  it("runs a real Code Mode vertical slice through AI SDK tools", async () => {
    const fixturePath = fileURLToPath(
      new URL(
        "../../mcp-registry/test/fixtures/stdio-mcp-server.ts",
        import.meta.url,
      ),
    );
    const ptools = await createPtoolsSession({
      mcpServers: {
        fixture: {
          transport: "stdio",
          command: process.execPath,
          args: ["--import", "tsx", fixturePath],
        },
      },
    });

    try {
      const tools = toAISDKTools(ptools);
      const search = await runAISDKToolExecuteForTest(
        tools,
        "ptools_search",
        {},
      );
      const schema = await runAISDKToolExecuteForTest(
        tools,
        "ptools_get_tool_schema",
        {
          tools: [{ jsServerName: "fixture", jsToolName: "echo" }],
        },
      );
      const run = await runAISDKToolExecuteForTest(tools, "ptools_execute", {
        code: `async () => {
          return await fixture.echo({ text: "hello from ai sdk adapter" });
        }`,
      });

      expect(toToolKeys(search)).toEqual(["fixture.echo", "fixture.add"]);
      console.log("schema", JSON.stringify(schema, null, 2));
      expect(toSchemaToolKeys(schema)).toEqual(["fixture.echo"]);
      expect(run).toEqual(
        expect.objectContaining({
          value: { text: "hello from ai sdk adapter" },
        }),
      );
    } finally {
      await ptools.close();
    }
  });

  it("runs generateText against Code Mode tools loaded from a real MCP server", async () => {
    const fixturePath = fileURLToPath(
      new URL(
        "../../mcp-registry/test/fixtures/stdio-mcp-server.ts",
        import.meta.url,
      ),
    );
    const ptools = await createPtoolsSession({
      mcpServers: {
        fixture: {
          transport: "stdio",
          command: process.execPath,
          args: ["--import", "tsx", fixturePath],
        },
      },
    });
    let generateCount = 0;
    const model = new MockLanguageModelV3({
      provider: "ptools-test",
      modelId: "configured-mock-model",
      doGenerate: async () => {
        generateCount += 1;

        switch (generateCount) {
          case 1:
            return mockModelToolCall("call-search", "ptools_search", {});
          case 2:
            return mockModelToolCall("call-schema", "ptools_get_tool_schema", {
              tools: [{ jsServerName: "fixture", jsToolName: "echo" }],
            });
          case 3:
            return mockModelToolCall("call-execute", "ptools_execute", {
              code: `async () => {
                return await fixture.echo({ text: "hello from generateText" });
              }`,
            });
          default:
            return {
              content: [
                {
                  type: "text",
                  text: "The fixture MCP echo tool returned hello from generateText.",
                },
              ],
              finishReason: { unified: "stop" as const, raw: "stop" },
              usage: emptyUsage,
              warnings: [],
            };
        }
      },
    });

    try {
      const result = await generateText({
        model,
        tools: toAISDKTools(ptools),
        stopWhen: stepCountIs(4),
        prompt:
          "Discover the fixture MCP tools, inspect echo, then execute echo.",
      });

      expect(result.text).toBe(
        "The fixture MCP echo tool returned hello from generateText.",
      );
      expect(model.doGenerateCalls).toHaveLength(4);
      expect(model.doGenerateCalls[0]?.tools?.map((tool) => tool.name)).toEqual(
        ["ptools_search", "ptools_get_tool_schema", "ptools_execute"],
      );
      expect(result.steps[0]?.toolResults[0]).toEqual(
        expect.objectContaining({
          toolName: "ptools_search",
          output: expect.objectContaining({
            servers: [
              expect.objectContaining({
                jsServerName: "fixture",
                tools: [
                  expect.objectContaining({ jsToolName: "echo" }),
                  expect.objectContaining({ jsToolName: "add" }),
                ],
              }),
            ],
          }),
        }),
      );
      expect(model.doGenerateCalls[1]?.prompt.at(-1)).toEqual({
        role: "tool",
        content: [
          expect.objectContaining({
            type: "tool-result",
            toolCallId: "call-search",
            toolName: "ptools_search",
            output: expect.objectContaining({
              type: "json",
              value: expect.objectContaining({
                servers: [
                  expect.objectContaining({
                    jsServerName: "fixture",
                  }),
                ],
              }),
            }),
          }),
        ],
      });
      expect(model.doGenerateCalls[2]?.prompt.at(-1)).toEqual({
        role: "tool",
        content: [
          expect.objectContaining({
            type: "tool-result",
            toolCallId: "call-schema",
            toolName: "ptools_get_tool_schema",
            output: expect.objectContaining({
              type: "json",
              value: expect.objectContaining({
                tools: [
                  expect.objectContaining({
                    jsServerName: "fixture",
                    jsToolName: "echo",
                  }),
                ],
              }),
            }),
          }),
        ],
      });
      expect(model.doGenerateCalls[3]?.prompt.at(-1)).toEqual({
        role: "tool",
        content: [
          expect.objectContaining({
            type: "tool-result",
            toolCallId: "call-execute",
            toolName: "ptools_execute",
            output: {
              type: "json",
              value: {
                value: { text: "hello from generateText" },
                logs: [],
              },
            },
          }),
        ],
      });
    } finally {
      await ptools.close();
    }
  });
});

const runAISDKToolExecuteForTest = async (
  tools: ToolSet,
  name: string,
  input: unknown,
): Promise<unknown> => {
  const execute = (tools[name] as { execute?: (input: unknown) => unknown })
    .execute;

  if (execute === undefined) {
    throw new Error(`Tool ${name} does not have an execute function`);
  }

  return await execute(input);
};

const toToolKeys = (value: unknown): ReadonlyArray<string> => {
  const context = value as {
    readonly servers: ReadonlyArray<{
      readonly jsServerName: string;
      readonly tools: ReadonlyArray<{ readonly jsToolName: string }>;
    }>;
  };

  return context.servers.flatMap((server) =>
    server.tools.map((tool) => `${server.jsServerName}.${tool.jsToolName}`),
  );
};

const toSchemaToolKeys = (value: unknown): ReadonlyArray<string> => {
  const context = value as {
    readonly tools: ReadonlyArray<{
      readonly jsServerName: string;
      readonly jsToolName: string;
    }>;
  };

  return context.tools.map((tool) => `${tool.jsServerName}.${tool.jsToolName}`);
};

const mockModelToolCall = (
  toolCallId: string,
  toolName: string,
  input: unknown,
) => ({
  content: [
    {
      type: "tool-call" as const,
      toolCallId,
      toolName,
      input: JSON.stringify(input),
    },
  ],
  finishReason: { unified: "tool-calls" as const, raw: "tool-calls" },
  usage: emptyUsage,
  warnings: [],
});

const emptyUsage = {
  inputTokens: {
    total: 0,
    noCache: 0,
    cacheRead: 0,
    cacheWrite: 0,
  },
  outputTokens: {
    total: 0,
    text: 0,
    reasoning: 0,
  },
};
