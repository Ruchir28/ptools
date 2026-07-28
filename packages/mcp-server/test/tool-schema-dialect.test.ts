/**
 * The MCP SDK's high-level server validates ptools tool calls with Zod, but its
 * default tools/list conversion advertises JSON Schema draft-07. Clients that
 * use the MCP default Ajv validator compile only JSON Schema 2020-12 and reject
 * those tools before dispatch.
 *
 * What this proves:
 * 1. Every ptools input and output schema is advertised as JSON Schema 2020-12.
 * 2. The MCP SDK's default Ajv validator can compile every advertised schema.
 *
 * The MCP client/server and in-memory protocol transport are real. Only the
 * Code Mode client behind the tool callbacks is faked because no tool is called.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { JsonSchemaType } from "@modelcontextprotocol/sdk/validation";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { afterEach, describe, expect, it } from "vitest";
import { registerCodeModeTools } from "../src/server.js";

const JSON_SCHEMA_2020_12 =
  "https://json-schema.org/draft/2020-12/schema";

describe("public MCP tool schema dialect", () => {
  let client: Client | undefined;
  let server: McpServer | undefined;

  afterEach(async () => {
    await client?.close();
    await server?.close();
  });

  it("advertises schemas accepted by the default MCP Ajv validator", async () => {
    server = new McpServer({ name: "ptools-schema-test", version: "0.0.0" });
    registerCodeModeTools(server, {
      call: async () => {
        throw new Error("The schema-list test must not call Code Mode");
      },
    });

    client = new Client({ name: "ptools-schema-test-client", version: "0.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const tools = await client.listTools();
    const validator = new AjvJsonSchemaValidator();

    expect(tools.tools).toHaveLength(6);
    for (const tool of tools.tools) {
      expect(tool.inputSchema.$schema).toBe(JSON_SCHEMA_2020_12);
      expect(tool.outputSchema?.$schema).toBe(JSON_SCHEMA_2020_12);

      // The SDK's Tool schema and validator use structurally compatible but
      // separately declared JSON Schema types.
      expect(() =>
        validator.getValidator(tool.inputSchema as JsonSchemaType),
      ).not.toThrow();
      expect(() =>
        validator.getValidator(tool.outputSchema as JsonSchemaType),
      ).not.toThrow();
    }
  });
});
