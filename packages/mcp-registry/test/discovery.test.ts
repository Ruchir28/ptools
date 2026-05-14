import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { discoverAllTools } from "../src/discovery.js";
import type { ConnectedMcpClient } from "../src/types.js";

describe("discoverAllTools", () => {
  it("discovers all tools across all clients and all pages", async () => {
    const githubListCalls: Array<unknown> = [];
    const linearListCalls: Array<unknown> = [];

    const clients: ReadonlyArray<ConnectedMcpClient> = [
      {
        serverName: "github",
        jsServerName: "github",
        client: fakeClient({
          listTools: async (params: unknown) => {
            githubListCalls.push(params);

            if (params === undefined) {
              return {
                tools: [
                  mcpTool("create-issue", "Create a GitHub issue"),
                  mcpTool("list_issues", "List GitHub issues"),
                ],
                nextCursor: "page-2",
              };
            }

            return {
              tools: [mcpTool("close_issue", "Close a GitHub issue")],
            };
          },
        }),
      },
      {
        serverName: "linear",
        jsServerName: "linear",
        client: fakeClient({
          listTools: async (params: unknown) => {
            linearListCalls.push(params);

            return {
              tools: [mcpTool("search-issues", "Search Linear issues")],
            };
          },
        }),
      },
    ];

    const tools = await Effect.runPromise(discoverAllTools(clients));

    expect(githubListCalls).toEqual([undefined, { cursor: "page-2" }]);
    expect(linearListCalls).toEqual([undefined]);
    expect(toToolKeys(tools)).toEqual([
      "github.create_issue",
      "github.list_issues",
      "github.close_issue",
      "linear.search_issues",
    ]);

    expect(tools).toContainEqual(
      expect.objectContaining({
        serverName: "github",
        originalToolName: "create-issue",
        jsToolName: "create_issue",
        description: "Create a GitHub issue",
      }),
    );
  });
});

const fakeClient = (methods: {
  readonly listTools: (params: unknown) => Promise<{
    readonly tools: ReadonlyArray<McpTool>;
    readonly nextCursor?: string;
  }>;
}): Client => methods as unknown as Client;

const mcpTool = (name: string, description: string): McpTool => ({
  name,
  description,
  inputSchema: {
    type: "object",
    properties: {},
  },
});

const toToolKeys = (
  tools: ReadonlyArray<{
    readonly jsServerName: string;
    readonly jsToolName: string;
  }>,
) => tools.map((tool) => `${tool.jsServerName}.${tool.jsToolName}`);
