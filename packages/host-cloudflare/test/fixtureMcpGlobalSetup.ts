import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import {
  FIXTURE_MCP_ORIGIN,
  FIXTURE_MCP_PORT,
  FIXTURE_OAUTH_ACCESS_TOKEN,
  FIXTURE_OAUTH_AUTHORIZATION_CODE,
  FIXTURE_STATIC_BEARER_TOKEN,
  OAUTH_AUTHORIZATION_SERVER_METADATA_PATH,
  OAUTH_AUTHORIZE_PATH,
  OAUTH_PROTECTED_MCP_PATH,
  OAUTH_PROTECTED_MCP_URL,
  OAUTH_PROTECTED_RESOURCE_METADATA_PATH,
  OAUTH_TOKEN_PATH,
  PUBLIC_MCP_PATH,
  STATIC_BEARER_MCP_PATH,
} from "./support/fixtureMcpEndpoints.js";

/**
 * Start one local MCP/OAuth fixture for the workerd integration suite.
 *
 * The fixture has three deliberately separate MCP resources:
 *
 * - `/mcp/public` requires no authentication.
 * - `/mcp/static-bearer-protected` validates a secret-backed configured header.
 * - `/mcp/oauth-protected` validates the access token issued by `/token`.
 *
 * Only the OAuth resource publishes RFC 9728 protected-resource metadata. All
 * OAuth resources in this fixture share one RFC 8414 authorization server.
 */
export default async function setup(): Promise<() => Promise<void>> {
  const server = createServer((request, response) =>
    routeFixtureRequest(request, response).catch((cause) => {
      console.error("Fixture server failed", cause);
      if (!response.headersSent) {
        writeJson(response, 500, { error: "internal_server_error" });
      } else {
        response.end();
      }
    }),
  );

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(FIXTURE_MCP_PORT, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  return () =>
    new Promise<void>((resolve, reject) => {
      server.close((error) =>
        error === undefined ? resolve() : reject(error),
      );
    });
}

/** Route one fixture request without mixing endpoint policy with MCP setup. */
const routeFixtureRequest = async (
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> => {
  switch (requestPathname(request)) {
    case OAUTH_PROTECTED_RESOURCE_METADATA_PATH:
      writeProtectedResourceMetadata(response);
      return;
    case OAUTH_AUTHORIZATION_SERVER_METADATA_PATH:
      writeAuthorizationServerMetadata(response);
      return;
    case OAUTH_TOKEN_PATH:
      await handleTokenExchange(request, response);
      return;
    case PUBLIC_MCP_PATH:
      await handleMcpRequest(request, response);
      return;
    case STATIC_BEARER_MCP_PATH:
      if (
        !requireAuthorization(
          request,
          response,
          `Bearer ${FIXTURE_STATIC_BEARER_TOKEN}`,
        )
      ) {
        return;
      }
      await handleMcpRequest(request, response);
      return;
    case OAUTH_PROTECTED_MCP_PATH:
      if (
        !requireAuthorization(
          request,
          response,
          `Bearer ${FIXTURE_OAUTH_ACCESS_TOKEN}`,
        )
      ) {
        return;
      }
      await handleMcpRequest(request, response);
      return;
    default:
      writeJson(response, 404, { error: "not_found" });
  }
};

const writeProtectedResourceMetadata = (response: ServerResponse): void => {
  writeJson(response, 200, {
    resource: OAUTH_PROTECTED_MCP_URL,
    authorization_servers: [FIXTURE_MCP_ORIGIN],
  });
};

const writeAuthorizationServerMetadata = (response: ServerResponse): void => {
  writeJson(response, 200, {
    issuer: FIXTURE_MCP_ORIGIN,
    authorization_endpoint: `${FIXTURE_MCP_ORIGIN}${OAUTH_AUTHORIZE_PATH}`,
    token_endpoint: `${FIXTURE_MCP_ORIGIN}${OAUTH_TOKEN_PATH}`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
  });
};

const handleTokenExchange = async (
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> => {
  if (request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed" });
    return;
  }

  const params = new URLSearchParams(await readBody(request));
  if (params.get("code") !== FIXTURE_OAUTH_AUTHORIZATION_CODE) {
    writeJson(response, 400, { error: "invalid_grant" });
    return;
  }

  writeJson(response, 200, {
    access_token: FIXTURE_OAUTH_ACCESS_TOKEN,
    token_type: "Bearer",
  });
};

/** Validate one deterministic Authorization header without implementing OAuth. */
const requireAuthorization = (
  request: IncomingMessage,
  response: ServerResponse,
  expected: string,
): boolean => {
  if (request.headers.authorization === expected) return true;

  writeJson(response, 401, {
    jsonrpc: "2.0",
    error: { code: -32001, message: "Unauthorized" },
    id: null,
  });
  return false;
};

/** Serve one stateless Streamable HTTP MCP request with the official SDK. */
const handleMcpRequest = async (
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> => {
  if (request.method !== "POST") {
    writeJson(response, 405, {
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    });
    return;
  }

  const mcp = makeFixtureMcpServer();
  // The SDK's runtime constructor accepts this stateless configuration, while
  // its published type currently requires additional optional server fields.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  } as unknown as ConstructorParameters<
    typeof StreamableHTTPServerTransport
  >[0]);

  response.once("close", () => {
    void transport.close();
    void mcp.close();
  });

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
      writeJson(response, 500, {
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
};

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

const requestPathname = (request: IncomingMessage): string =>
  new URL(request.url ?? "/", FIXTURE_MCP_ORIGIN).pathname;

const writeJson = (
  response: ServerResponse,
  status: number,
  body: unknown,
): void => {
  response
    .writeHead(status, { "content-type": "application/json" })
    .end(JSON.stringify(body));
};

const readJsonBody = async (request: IncomingMessage): Promise<unknown> => {
  const body = await readBody(request);
  return body === "" ? undefined : JSON.parse(body);
};

const readBody = async (request: IncomingMessage): Promise<string> => {
  const chunks: Array<Uint8Array> = [];

  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }

  return Buffer.concat(chunks).toString("utf8");
};
