import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
  name: "ptools-test-fixture",
  version: "0.0.0",
});

server.registerTool(
  "echo",
  {
    title: "Echo",
    description: "Echo text back to the caller",
    inputSchema: {
      text: z.string(),
    },
    outputSchema: {
      text: z.string(),
    },
  },
  async ({ text }) => ({
    content: [{ type: "text", text }],
    structuredContent: { text },
  }),
);

server.registerTool(
  "add",
  {
    title: "Add",
    description: "Add two numbers",
    inputSchema: {
      a: z.number(),
      b: z.number(),
    },
    outputSchema: {
      sum: z.number(),
    },
  },
  async ({ a, b }) => {
    const sum = a + b;

    return {
      content: [{ type: "text", text: String(sum) }],
      structuredContent: { sum },
    };
  },
);

await server.connect(new StdioServerTransport());
