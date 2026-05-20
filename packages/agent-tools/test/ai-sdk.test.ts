import type { ToolSet } from "ai";
import { describe, expect, it } from "vitest";
import { toAISDKTools } from "../src/ai-sdk.js";
import type { CodeModeToolName, PtoolsSession } from "../src/types.js";

describe("toAISDKTools", () => {
  it("returns exactly three default-prefixed tools", () => {
    const tools = toAISDKTools(fakeSession());

    expect(Object.keys(tools)).toEqual([
      "ptools_search",
      "ptools_get_tool_schema",
      "ptools_execute",
    ]);
  });

  it("can expose unprefixed Code Mode names", () => {
    const tools = toAISDKTools(fakeSession(), { toolNamePrefix: false });

    expect(Object.keys(tools)).toEqual([
      "search",
      "get_tool_schema",
      "execute",
    ]);
  });

  it("can expose custom-prefixed names", () => {
    const tools = toAISDKTools(fakeSession(), { toolNamePrefix: "mcp_" });

    expect(Object.keys(tools)).toEqual([
      "mcp_search",
      "mcp_get_tool_schema",
      "mcp_execute",
    ]);
  });

  it("executes visible tools through their canonical Code Mode names", async () => {
    const calls: Array<{
      readonly name: CodeModeToolName;
      readonly input: unknown;
    }> = [];
    const tools = toAISDKTools(fakeSession(calls), { toolNamePrefix: "mcp_" });

    await expect(
      runAISDKToolExecuteForTest(tools, "mcp_search", { query: "auth" }),
    ).resolves.toEqual({ name: "search", input: { query: "auth" } });
    await expect(
      runAISDKToolExecuteForTest(tools, "mcp_get_tool_schema", {
        tools: [{ jsServerName: "github", jsToolName: "create_issue" }],
      }),
    ).resolves.toEqual({
      name: "get_tool_schema",
      input: {
        tools: [{ jsServerName: "github", jsToolName: "create_issue" }],
      },
    });
    await expect(
      runAISDKToolExecuteForTest(tools, "mcp_execute", {
        code: "async () => 1",
      }),
    ).resolves.toEqual({
      name: "execute",
      input: { code: "async () => 1" },
    });

    expect(calls.map((call) => call.name)).toEqual([
      "search",
      "get_tool_schema",
      "execute",
    ]);
  });

  it("every tool has a non-empty description string", () => {
    const tools = toAISDKTools(fakeSession());

    for (const [name, t] of Object.entries(tools)) {
      const desc = (t as { description?: unknown }).description;
      expect(typeof desc, `${name}.description`).toBe("string");
      expect((desc as string).length, `${name}.description`).toBeGreaterThan(0);
    }
  });

  it("every tool has an inputSchema", () => {
    const tools = toAISDKTools(fakeSession());

    for (const name of Object.keys(tools)) {
      expect(
        (tools[name] as { inputSchema?: unknown }).inputSchema,
        `${name}.inputSchema`,
      ).toBeDefined();
    }
  });

  it("empty string prefix produces bare canonical names like false does", () => {
    const tools = toAISDKTools(fakeSession(), { toolNamePrefix: "" });

    expect(Object.keys(tools)).toEqual([
      "search",
      "get_tool_schema",
      "execute",
    ]);
  });

  it("throws tool execution failures instead of turning them into output", async () => {
    const tools = toAISDKTools({
      callCodeModeTool: async () => {
        throw new Error("code mode failed");
      },
      diagnostics: async () => [],
      close: async () => {},
    });

    await expect(
      runAISDKToolExecuteForTest(tools, "ptools_search", {}),
    ).rejects.toThrow("code mode failed");
  });
});

const fakeSession = (
  calls: Array<{
    readonly name: CodeModeToolName;
    readonly input: unknown;
  }> = [],
): PtoolsSession => ({
  callCodeModeTool: async (name, input) => {
    calls.push({ name, input });
    return { name, input };
  },
  diagnostics: async () => [],
  close: async () => {},
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
