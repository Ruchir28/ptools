import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { discoverAllTools, discoverAllToolsDegraded } from "../src/discovery.js";
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

describe("discoverAllToolsDegraded", () => {
  it("keeps healthy clients when another client fails discovery", async () => {
    const closed: Array<string> = [];
    const clients: ReadonlyArray<ConnectedMcpClient> = [
      {
        serverName: "healthy",
        jsServerName: "healthy",
        client: fakeClient({
          listTools: async () => ({
            tools: [mcpTool("echo", "Echo text")],
          }),
          close: async () => {
            closed.push("healthy");
          },
        }),
      },
      {
        serverName: "broken",
        jsServerName: "broken",
        client: fakeClient({
          listTools: async () => {
            throw new Error("boom");
          },
          close: async () => {
            closed.push("broken");
          },
        }),
      },
    ];

    const result = await Effect.runPromise(discoverAllToolsDegraded(clients));

    expect(toToolKeys(result.tools)).toEqual(["healthy.echo"]);
    expect(result.clients.map((client) => client.serverName)).toEqual([
      "healthy",
    ]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "McpDiscoveryFailed",
        severity: "error",
        serverName: "broken",
        message: "boom",
      }),
    ]);
    expect(closed).toEqual(["broken"]);
  });

  it("excludes a server with an invalid input schema", async () => {
    const result = await Effect.runPromise(
      discoverAllToolsDegraded([
        {
          serverName: "broken",
          jsServerName: "broken",
          client: fakeClient({
            listTools: async () => ({
              tools: [
                mcpTool("bad_input", "Bad input", {
                  inputSchema: {
                    type: "object",
                    properties: {
                      missing: { $ref: "#/$defs/Missing" },
                    },
                  },
                  outputSchema: {
                    type: "object",
                    properties: {
                      alsoMissing: { $ref: "#/$defs/AlsoMissing" },
                    },
                  },
                }),
              ],
            }),
          }),
        },
      ]),
    );

    expect(result.tools).toEqual([]);
    expect(result.clients).toEqual([]);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "InvalidInputSchema",
          severity: "error",
          serverName: "broken",
          toolName: "bad_input",
        }),
        expect.objectContaining({
          code: "McpDiscoveryFailed",
          severity: "error",
          serverName: "broken",
        }),
      ]),
    );
    expect(
      result.diagnostics.some(
        (diagnostic) => diagnostic.code === "InvalidOutputSchema",
      ),
    ).toBe(false);
  });

  it("warns for an invalid output schema but keeps the tool exposed", async () => {
    const result = await Effect.runPromise(
      discoverAllToolsDegraded([
        {
          serverName: "stitch",
          jsServerName: "stitch",
          client: fakeClient({
            listTools: async () => ({
              tools: [
                mcpTool("upload_design_md", "Upload design markdown", {
                  outputSchema: {
                    type: "object",
                    properties: {
                      screen: { $ref: "#/$defs/ScreenInstance" },
                    },
                  },
                }),
              ],
            }),
          }),
        },
      ]),
    );

    expect(toToolKeys(result.tools)).toEqual(["stitch.upload_design_md"]);
    expect(result.tools[0]).toEqual(
      expect.objectContaining({
        outputSchemaInvalid: true,
      }),
    );
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "InvalidOutputSchema",
        severity: "warning",
        serverName: "stitch",
        toolName: "upload_design_md",
      }),
    ]);
  });

  it("leaves name-collision cleanup to the caller-owned scope", async () => {
    const closed: Array<string> = [];
    const result = await Effect.runPromise(
      Effect.either(
        discoverAllToolsDegraded([
          {
            serverName: "healthy",
            jsServerName: "healthy",
            client: fakeClient({
              listTools: async () => ({
                tools: [mcpTool("echo", "Echo text")],
              }),
              close: async () => {
                closed.push("healthy");
              },
            }),
          },
          {
            serverName: "colliding",
            jsServerName: "colliding",
            client: fakeClient({
              listTools: async () => ({
                tools: [
                  mcpTool("create-issue", "Create issue"),
                  mcpTool("create_issue", "Create issue duplicate"),
                ],
              }),
              close: async () => {
                closed.push("colliding");
              },
            }),
          },
          {
            serverName: "not-yet-discovered",
            jsServerName: "not_yet_discovered",
            client: fakeClient({
              listTools: async () => ({
                tools: [mcpTool("late", "Late tool")],
              }),
              close: async () => {
                closed.push("not-yet-discovered");
              },
            }),
          },
        ]),
      ),
    );

    expect(result._tag).toBe("Left");
    expect(closed).toEqual([]);
  });
});

const fakeClient = (methods: {
  readonly listTools: (params: unknown) => Promise<{
    readonly tools: ReadonlyArray<McpTool>;
    readonly nextCursor?: string;
  }>;
  readonly close?: () => Promise<void>;
}): Client =>
  ({
    ...methods,
    close: methods.close ?? (async () => undefined),
  }) as unknown as Client;

const mcpTool = (
  name: string,
  description: string,
  options: {
    readonly inputSchema?: unknown;
    readonly outputSchema?: unknown;
  } = {},
): McpTool =>
  ({
    name,
    description,
    inputSchema:
      options.inputSchema ?? {
        type: "object",
        properties: {},
      },
    ...(options.outputSchema === undefined
      ? {}
      : { outputSchema: options.outputSchema }),
  }) as McpTool;

const toToolKeys = (
  tools: ReadonlyArray<{
    readonly jsServerName: string;
    readonly jsToolName: string;
  }>,
) => tools.map((tool) => `${tool.jsServerName}.${tool.jsToolName}`);
