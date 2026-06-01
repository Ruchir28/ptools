import { generateText, stepCountIs } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { toAISDKTools } from "../src/ai-sdk.js";
import type { CodeModeOperation, PtoolsSession } from "../src/types.js";

describe("AI SDK adapter integration", () => {
  it("runs generateText against client-backed Code Mode tools", async () => {
    const calls: Array<{
      readonly name: CodeModeOperation;
      readonly input: unknown;
    }> = [];
    const ptools = fakeSession(calls);
    let generateCount = 0;
    const model = new MockLanguageModelV3({
      provider: "ptools-test",
      modelId: "configured-mock-model",
      doGenerate: async () => {
        generateCount += 1;

        switch (generateCount) {
          case 1:
            return mockModelToolCall("call-search", "ptools_search", {
              query: "echo",
            });
          case 2:
            return mockModelToolCall("call-schema", "ptools_get_tool_schema", {
              toolIds: ["fixture.echo"],
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
    expect(calls.map((call) => call.name)).toEqual([
      "search",
      "get_tool_schema",
      "execute",
    ]);
    expect(model.doGenerateCalls).toHaveLength(4);
    expect(model.doGenerateCalls[0]?.tools?.map((tool) => tool.name)).toEqual([
      "ptools_search_providers",
      "ptools_search",
      "ptools_get_tool_schema",
      "ptools_execute",
    ]);
    expect(result.steps[0]?.toolResults[0]).toEqual(
      expect.objectContaining({
        toolName: "ptools_search",
        output: expect.objectContaining({
          actions: [
            expect.objectContaining({
              toolId: "fixture.echo",
            }),
          ],
        }),
      }),
    );
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
  });
});

const fakeSession = (
  calls: Array<{ readonly name: CodeModeOperation; readonly input: unknown }>,
): PtoolsSession => ({
  callCodeModeTool: async (name, input) => {
    calls.push({ name, input });

    switch (name) {
      case "auth_status":
        return { authUrl: "http://127.0.0.1:9999/auth", servers: [] };
      case "refresh":
        return { refreshed: true };
      case "search_providers":
        return {
          providers: [{ provider: "fixture" }],
          diagnostics: [],
        };
      case "search":
        return {
          actions: [{ toolId: "fixture.echo" }],
          diagnostics: [],
        };
      case "get_tool_schema":
        return {
          tools: [{ jsServerName: "fixture", jsToolName: "echo" }],
          declarationsByServer: [],
          diagnostics: [],
        };
      case "execute":
        return {
          value: { text: "hello from generateText" },
          logs: [],
        };
    }
  },
  diagnostics: async () => [],
  close: async () => {},
});

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
