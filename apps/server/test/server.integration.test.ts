import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const serverMainPath = join(repoRoot, "apps/server/src/main.ts");
const fixtureServerPath = join(
  repoRoot,
  "packages/mcp-registry/test/fixtures/stdio-mcp-server.ts",
);
const brokenOutputFixtureServerPath = join(
  repoRoot,
  "packages/mcp-registry/test/fixtures/broken-output-schema-mcp-server.ts",
);

describe("combined Code Mode MCP server", () => {
  let activeClient: Client | undefined;

  afterEach(async () => {
    await activeClient?.close();
    activeClient = undefined;
  });

  it("serves search and execute over stdio", async () => {
    const configPath = await writeFixtureConfig();
    const client = new Client({
      name: "ptools-server-test-client",
      version: "0.0.0",
    });
    activeClient = client;

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", serverMainPath, "--config", configPath],
      cwd: repoRoot,
      stderr: "pipe",
    });

    await client.connect(transport);

    const tools = await client.listTools();

    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      "execute",
      "search",
    ]);

    const fullSearch = await client.callTool({
      name: "search",
      arguments: {},
    });
    const fullContext = fullSearch.structuredContent as {
      readonly declarations: string;
      readonly servers: ReadonlyArray<{
        readonly jsServerName: string;
        readonly tools: ReadonlyArray<{ readonly jsToolName: string }>;
      }>;
    };

    expect([...toToolKeys(fullContext)].sort()).toEqual([
      "fixture.add",
      "fixture.echo",
    ]);
    expect(fullContext.declarations).toContain("namespace fixture");
    expect(fullContext.declarations).toContain("function echo");
    expect(fullContext.declarations).toContain("function add");
    expect(extractTextContent(fullSearch)).toContain(
      "code must be a JavaScript function expression",
    );
    expect(extractTextContent(fullSearch)).not.toContain("Diagnostics:");

    const echoSearch = await client.callTool({
      name: "search",
      arguments: { query: "echo" },
    });
    const echoContext = echoSearch.structuredContent as typeof fullContext;

    expect(toToolKeys(echoContext)).toEqual(["fixture.echo"]);
    expect(echoContext.declarations).toContain("function echo");
    expect(echoContext.declarations).not.toContain("function add");

    const execution = await client.callTool({
      name: "execute",
      arguments: {
        code: `async () => {
          const echo = await fixture.echo({ text: "hello" });
          const add = await fixture.add({ a: 2, b: 3 });

          return { echo, add };
        }`,
      },
    });
    const result = execution.structuredContent as {
      readonly value: unknown;
      readonly logs: ReadonlyArray<unknown>;
    };

    expect(result).toEqual({
      value: {
        echo: { text: "hello" },
        add: { sum: 5 },
      },
      logs: [],
    });
  }, 30_000);

  it("starts with diagnostics when every upstream fails", async () => {
    const configPath = await writeAllFailConfig();
    const client = new Client({
      name: "ptools-server-test-client",
      version: "0.0.0",
    });
    activeClient = client;

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", serverMainPath, "--config", configPath],
      cwd: repoRoot,
      stderr: "pipe",
    });

    await client.connect(transport);

    const tools = await client.listTools();

    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      "execute",
      "search",
    ]);

    const search = await client.callTool({
      name: "search",
      arguments: {},
    });
    const context = search.structuredContent as {
      readonly declarations: string;
      readonly servers: ReadonlyArray<unknown>;
      readonly diagnostics: ReadonlyArray<{
        readonly code: string;
        readonly serverName: string;
      }>;
    };

    expect(context.servers).toEqual([]);
    expect(context.declarations).toBe("");
    expect(context.diagnostics).toEqual([
      expect.objectContaining({
        code: "McpConnectionFailed",
        serverName: "unavailable",
      }),
    ]);
    expect(extractTextContent(search)).toContain("Diagnostics:");
  }, 30_000);

  it("exposes and calls tools with broken optional output schemas", async () => {
    const configPath = await writeBrokenOutputConfig();
    const client = new Client({
      name: "ptools-server-test-client",
      version: "0.0.0",
    });
    activeClient = client;

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", serverMainPath, "--config", configPath],
      cwd: repoRoot,
      stderr: "pipe",
    });

    await client.connect(transport);

    const search = await client.callTool({
      name: "search",
      arguments: {},
    });
    const context = search.structuredContent as {
      readonly declarations: string;
      readonly servers: ReadonlyArray<{
        readonly jsServerName: string;
        readonly tools: ReadonlyArray<{ readonly jsToolName: string }>;
      }>;
      readonly diagnostics: ReadonlyArray<{
        readonly code: string;
        readonly serverName: string;
        readonly toolName?: string;
      }>;
    };

    expect(toToolKeys(context)).toEqual(["broken.upload_design_md"]);
    expect(context.declarations).toContain(
      "function upload_design_md(input: BrokenUploadDesignMdInput): Promise<unknown>;",
    );
    expect(context.diagnostics).toEqual([
      expect.objectContaining({
        code: "InvalidOutputSchema",
        serverName: "broken",
        toolName: "upload_design_md",
      }),
    ]);

    const execution = await client.callTool({
      name: "execute",
      arguments: {
        code: `async () => {
          return await broken.upload_design_md({ text: "hello" });
        }`,
      },
    });
    const result = execution.structuredContent as {
      readonly value: unknown;
      readonly logs: ReadonlyArray<unknown>;
    };

    expect(result).toEqual({
      value: {
        screen: {
          id: "screen-1",
          text: "hello",
        },
      },
      logs: [],
    });
  }, 30_000);
});

const writeFixtureConfig = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "ptools-server-"));
  const configPath = join(dir, "ptools.config.json");

  await writeFile(
    configPath,
    JSON.stringify(
      {
        mcpServers: {
          fixture: {
            transport: "stdio",
            command: process.execPath,
            args: ["--import", "tsx", fixtureServerPath],
          },
        },
      },
      null,
      2,
    ),
  );

  return configPath;
};

const writeAllFailConfig = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "ptools-server-"));
  const configPath = join(dir, "ptools.config.json");

  await writeFile(
    configPath,
    JSON.stringify(
      {
        mcpServers: {
          unavailable: {
            transport: "stdio",
            command: "/path/that/does/not/exist",
          },
        },
      },
      null,
      2,
    ),
  );

  return configPath;
};

const writeBrokenOutputConfig = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "ptools-server-"));
  const configPath = join(dir, "ptools.config.json");

  await writeFile(
    configPath,
    JSON.stringify(
      {
        mcpServers: {
          broken: {
            transport: "stdio",
            command: process.execPath,
            args: ["--import", "tsx", brokenOutputFixtureServerPath],
          },
        },
      },
      null,
      2,
    ),
  );

  return configPath;
};

const toToolKeys = (context: {
  readonly servers: ReadonlyArray<{
    readonly jsServerName: string;
    readonly tools: ReadonlyArray<{ readonly jsToolName: string }>;
  }>;
}): ReadonlyArray<string> =>
  context.servers.flatMap((server) =>
    server.tools.map((tool) => `${server.jsServerName}.${tool.jsToolName}`),
  );

const extractTextContent = (result: unknown): string => {
  const content =
    typeof result === "object" && result !== null && "content" in result
      ? result.content
      : undefined;

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .filter(
      (item): item is { readonly type: "text"; readonly text: string } =>
        typeof item === "object" &&
        item !== null &&
        "type" in item &&
        item.type === "text" &&
        "text" in item &&
        typeof item.text === "string",
    )
    .map((item) => item.text)
    .join("\n");
};
