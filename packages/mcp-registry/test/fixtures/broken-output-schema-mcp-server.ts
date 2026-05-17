import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  {
    name: "ptools-broken-output-fixture",
    version: "0.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "upload_design_md",
      description: "Return a screen while advertising a broken output schema",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string" },
        },
        required: ["text"],
      },
      outputSchema: {
        type: "object",
        properties: {
          screen: { $ref: "#/$defs/ScreenInstance" },
        },
        required: ["screen"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const text =
    typeof request.params.arguments === "object" &&
    request.params.arguments !== null &&
    "text" in request.params.arguments &&
    typeof request.params.arguments.text === "string"
      ? request.params.arguments.text
      : "";

  return {
    content: [{ type: "text", text }],
    structuredContent: {
      screen: {
        id: "screen-1",
        text,
      },
    },
  };
});

await server.connect(new StdioServerTransport());
