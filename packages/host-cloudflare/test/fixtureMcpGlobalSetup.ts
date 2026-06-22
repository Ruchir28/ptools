import { createServer, type IncomingMessage } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

export const FIXTURE_MCP_PORT = 19719;

export default async function setup(): Promise<() => Promise<void>> {
  const server = createServer(async (request, response) => {
    if (request.url !== "/mcp") {
      response.writeHead(404).end();
      return;
    }

    if (request.method !== "POST") {
      response.writeHead(405, { "content-type": "application/json" }).end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Method not allowed." },
          id: null,
        }),
      );
      return;
    }

    const mcp = makeFixtureMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    } as unknown as ConstructorParameters<typeof StreamableHTTPServerTransport>[0]);

    try {
      await mcp.connect(transport as Parameters<typeof mcp.connect>[0]);
      await transport.handleRequest(
        request,
        response,
        await readJsonBody(request),
      );
    } catch (cause) {
      console.error("Fixture MCP server failed", cause);
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "application/json" }).end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal server error" },
            id: null,
          }),
        );
      }
    } finally {
      response.on("close", () => {
        void transport.close();
        void mcp.close();
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(FIXTURE_MCP_PORT, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  return () =>
    new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
}

const makeFixtureMcpServer = (): McpServer => {
  const server = new McpServer({
    name: "ptools-cloudflare-fixture",
    version: "0.0.0",
  });

  server.registerTool(
    "echo",
    {
      title: "Echo",
      description: "Echo text back to the caller",
      inputSchema: { text: z.string() },
      outputSchema: { text: z.string() },
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
      inputSchema: { a: z.number(), b: z.number() },
      outputSchema: { sum: z.number() },
    },
    async ({ a, b }) => {
      const sum = a + b;
      return {
        content: [{ type: "text", text: String(sum) }],
        structuredContent: { sum },
      };
    },
  );

  return server;
};

const readJsonBody = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Array<Uint8Array> = [];

  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }

  const body = Buffer.concat(chunks).toString("utf8");
  return body === "" ? undefined : JSON.parse(body);
};
