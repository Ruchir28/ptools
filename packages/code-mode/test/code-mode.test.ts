import type {
  ExecuteRequest,
  ExecuteResult,
  ExecutorError,
} from "@ptools/executor";
import { CodeExecutor } from "@ptools/executor";
import type {
  CallToolRequest,
  DiscoveredMcpTool,
  InvalidToolArguments,
  McpCallError,
  McpRegistryDiagnostic,
  ToolNotFound,
} from "@ptools/mcp-registry";
import { McpRegistry } from "@ptools/mcp-registry";
import { Effect, Either, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { CodeMode, makeCodeModeLive } from "../src/CodeMode.js";
import {
  buildExecutorProviders,
  filterCodeModeServers,
  groupDiscoveredMcpTools,
} from "../src/context.js";
import {
  generateDeclarations,
  type SchemaCompiler,
} from "../src/declarations.js";
import { CodeModeInvariantError } from "../src/errors.js";
import { unwrapMcpToolResult } from "../src/unwrap.js";

describe("Code Mode context and search", () => {
  it("groups flat registry tools into server metadata", () => {
    const servers = groupDiscoveredMcpTools([
      mcpTool({
        serverName: "github",
        originalToolName: "create-issue",
        jsServerName: "github",
        jsToolName: "create_issue",
        description: "Create a GitHub issue",
      }),
      mcpTool({
        serverName: "github",
        originalToolName: "list_issues",
        jsServerName: "github",
        jsToolName: "list_issues",
        description: "List GitHub issues",
      }),
      mcpTool({
        serverName: "slack",
        originalToolName: "send-message",
        jsServerName: "slack",
        jsToolName: "send_message",
        description: "Send a Slack message",
      }),
    ]);

    expect(servers.map((server) => server.jsServerName)).toEqual([
      "github",
      "slack",
    ]);
    expect(servers[0]?.tools.map((tool) => tool.jsToolName)).toEqual([
      "create_issue",
      "list_issues",
    ]);
    expect(servers[0]?.tools[0]).toEqual(
      expect.objectContaining({
        originalToolName: "create-issue",
        jsToolName: "create_issue",
        description: "Create a GitHub issue",
      }),
    );
  });

  it("search returns the full API surface when query is absent", async () => {
    const result = await runWithCodeMode(
      Effect.gen(function* () {
        const codeMode = yield* CodeMode;
        return yield* codeMode.search();
      }),
      [fixtureAddTool(), fixtureEchoTool()],
    );

    expect(toToolKeys(result)).toEqual(["fixture.add", "fixture.echo"]);
    expect(result.servers[0]?.tools[0]).not.toHaveProperty("inputSchema");
    expect(result.servers[0]?.tools[0]).not.toHaveProperty("outputSchema");
    expect(result).not.toHaveProperty("declarations");
  });

  it("search filters schema-free metadata by query", async () => {
    const result = await runWithCodeMode(
      Effect.gen(function* () {
        const codeMode = yield* CodeMode;
        return yield* codeMode.search({ query: "echo" });
      }),
      [fixtureAddTool(), fixtureEchoTool()],
    );

    expect(toToolKeys(result)).toEqual(["fixture.echo"]);
    expect(result.servers[0]?.tools[0]).toEqual(
      expect.objectContaining({
        jsToolName: "echo",
        inputSchemaAvailable: true,
        outputSchemaAvailable: true,
      }),
    );
  });

  it("search does not mark invalid output schemas as available", async () => {
    const result = await runWithCodeMode(
      Effect.gen(function* () {
        const codeMode = yield* CodeMode;
        return yield* codeMode.search();
      }),
      [
        mcpTool({
          originalToolName: "broken-output",
          jsToolName: "broken_output",
          outputSchema: {
            type: "object",
            properties: {
              value: { $ref: "#/$defs/Missing" },
            },
          },
          outputSchemaInvalid: true,
        }),
      ],
    );

    expect(result.servers[0]?.tools[0]).toEqual(
      expect.objectContaining({
        jsToolName: "broken_output",
        outputSchemaInvalid: true,
      }),
    );
    expect(result.servers[0]?.tools[0]).not.toHaveProperty(
      "outputSchemaAvailable",
    );
  });

  it("toolSchema returns full schemas per tool and merged declarations per requested server", async () => {
    const result = await runWithCodeMode(
      Effect.gen(function* () {
        const codeMode = yield* CodeMode;
        return yield* codeMode.toolSchema({
          tools: [
            { jsServerName: "fixture", jsToolName: "add" },
            { jsServerName: "fixture", jsToolName: "echo" },
          ],
        });
      }),
      [fixtureAddTool(), fixtureEchoTool()],
    );

    expect(result.tools.map((tool) => `${tool.jsServerName}.${tool.jsToolName}`)).toEqual([
      "fixture.add",
      "fixture.echo",
    ]);
    expect(result.tools[0]?.inputSchema).toEqual(
      expect.objectContaining({ type: "object" }),
    );
    expect(result.tools[0]?.outputSchema).toEqual(
      expect.objectContaining({ type: "object" }),
    );
    expect(result.tools[0]).not.toHaveProperty("declaration");
    expect(result.tools[1]).not.toHaveProperty("declaration");
    expect(result.declarationsByServer).toHaveLength(1);
    expect(result.declarationsByServer[0]).toEqual({
      serverName: "fixture",
      jsServerName: "fixture",
      declaration: `declare namespace fixture {
  interface FixtureAddInput {
    a: number;
    b?: number;
    [k: string]: unknown;
  }

  interface FixtureAddOutput {
    sum: number;
    [k: string]: unknown;
  }

  /**
   * Add
   *
   * Add two numbers
   */
  function add(input: FixtureAddInput): Promise<FixtureAddOutput>;

  interface FixtureEchoInput {
    text: string;
    [k: string]: unknown;
  }

  interface FixtureEchoOutput {
    text: string;
    [k: string]: unknown;
  }

  /**
   * Echo
   *
   * Echo text back to the caller
   */
  function echo(input: FixtureEchoInput): Promise<FixtureEchoOutput>;
}
`,
    });
  });

  it("toolSchema returns one declaration bundle for each requested server", async () => {
    const result = await runWithCodeMode(
      Effect.gen(function* () {
        const codeMode = yield* CodeMode;
        return yield* codeMode.toolSchema({
          tools: [
            { jsServerName: "fixture", jsToolName: "add" },
            { jsServerName: "fixture", jsToolName: "echo" },
            { jsServerName: "slack", jsToolName: "send_message" },
          ],
        });
      }),
      [
        fixtureAddTool(),
        fixtureEchoTool(),
        mcpTool({
          serverName: "slack",
          originalToolName: "send-message",
          jsServerName: "slack",
          jsToolName: "send_message",
          title: "Send Message",
          description: "Send a Slack message",
          inputSchema: {
            type: "object",
            properties: {
              channel: { type: "string" },
              text: { type: "string" },
            },
            required: ["channel", "text"],
          },
          outputSchema: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
            },
            required: ["ok"],
          },
        }),
      ],
    );

    expect(result.declarationsByServer.map((item) => item.jsServerName)).toEqual([
      "fixture",
      "slack",
    ]);

    expect(result.declarationsByServer[0]?.declaration).toBe(`declare namespace fixture {
  interface FixtureAddInput {
    a: number;
    b?: number;
    [k: string]: unknown;
  }

  interface FixtureAddOutput {
    sum: number;
    [k: string]: unknown;
  }

  /**
   * Add
   *
   * Add two numbers
   */
  function add(input: FixtureAddInput): Promise<FixtureAddOutput>;

  interface FixtureEchoInput {
    text: string;
    [k: string]: unknown;
  }

  interface FixtureEchoOutput {
    text: string;
    [k: string]: unknown;
  }

  /**
   * Echo
   *
   * Echo text back to the caller
   */
  function echo(input: FixtureEchoInput): Promise<FixtureEchoOutput>;
}
`);
    expect(result.declarationsByServer[1]?.declaration).toBe(`declare namespace slack {
  interface SlackSendMessageInput {
    channel: string;
    text: string;
    [k: string]: unknown;
  }

  interface SlackSendMessageOutput {
    ok: boolean;
    [k: string]: unknown;
  }

  /**
   * Send Message
   *
   * Send a Slack message
   *
   * Original tool: send-message
   */
  function send_message(input: SlackSendMessageInput): Promise<SlackSendMessageOutput>;
}
`);
  });

  it("toolSchema fails the whole batch when any requested tool is unknown", async () => {
    const result = await Effect.runPromise(
      Effect.either(
        runWithCodeModeEffect(
          Effect.gen(function* () {
            const codeMode = yield* CodeMode;
            return yield* codeMode.toolSchema({
              tools: [
                { jsServerName: "fixture", jsToolName: "add" },
                { jsServerName: "fixture", jsToolName: "missing" },
              ],
            });
          }),
          [fixtureAddTool()],
        ),
      ),
    );

    expect(Either.isLeft(result)).toBe(true);

    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(CodeModeInvariantError);
      expect(result.left.message).toBe("Unknown Code Mode tool: fixture.missing");
    }
  });

  it("search carries registry diagnostics in structured context", async () => {
    const diagnostics: ReadonlyArray<McpRegistryDiagnostic> = [
      {
        code: "McpConnectionFailed",
        severity: "error",
        serverName: "missing",
        message: "spawn failed",
      },
    ];
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const codeMode = yield* CodeMode;
        const context = yield* codeMode.search();
        const directDiagnostics = yield* codeMode.diagnostics;

        return { context, directDiagnostics };
      }).pipe(
        Effect.provide(
          makeCodeModeLive().pipe(
            Layer.provide(
              Layer.merge(
                makeRegistryLayer([fixtureEchoTool()], undefined, diagnostics),
                makeExecutorLayer(),
              ),
            ),
          ),
        ),
      ),
    );

    expect(result.context.diagnostics).toEqual(diagnostics);
    expect(result.directDiagnostics).toEqual(diagnostics);
  });

  it("filters by server names, tool names, titles, and descriptions", () => {
    const servers = groupDiscoveredMcpTools([
      fixtureAddTool(),
      fixtureEchoTool(),
    ]);

    expect(
      toToolKeys({ servers: filterCodeModeServers(servers, "numbers") }),
    ).toEqual(["fixture.add"]);
    expect(
      toToolKeys({ servers: filterCodeModeServers(servers, "fixture") }),
    ).toEqual(["fixture.add", "fixture.echo"]);
  });

  it("does not recompile schemas for repeated filtered search calls", async () => {
    const compileCalls: Array<string> = [];
    const schemaCompiler: SchemaCompiler = async (_schema, typeName) => {
      compileCalls.push(typeName);

      return `export interface ${typeName} {
  cached: true;
}`;
    };

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const codeMode = yield* CodeMode;
        const first = yield* codeMode.toolSchema({
          tools: [{ jsServerName: "fixture", jsToolName: "echo" }],
        });
        const second = yield* codeMode.toolSchema({
          tools: [{ jsServerName: "fixture", jsToolName: "echo" }],
        });

        return { first, second };
      }).pipe(
        Effect.provide(
          makeCodeModeLive({ schemaCompiler }).pipe(
            Layer.provide(
              Layer.merge(
                makeRegistryLayer([fixtureAddTool(), fixtureEchoTool()]),
                makeExecutorLayer(),
              ),
            ),
          ),
        ),
      ),
    );

    expect(compileCalls).toEqual([
      "FixtureAddInput",
      "FixtureAddOutput",
      "FixtureEchoInput",
      "FixtureEchoOutput",
    ]);
    expect(result.first.declarationsByServer[0]?.declaration).toBe(
      result.second.declarationsByServer[0]?.declaration,
    );
    expect(result.first.declarationsByServer[0]?.declaration).toContain(
      "interface FixtureEchoInput",
    );
    expect(result.first.declarationsByServer[0]?.declaration).not.toContain(
      "interface FixtureAddInput",
    );
  });
});

describe("TypeScript declaration generation", () => {
  it("generates provider function declarations for every discovered tool", async () => {
    const declarations = await Effect.runPromise(
      generateDeclarations(
        groupDiscoveredMcpTools([fixtureAddTool(), fixtureEchoTool()]),
      ),
    );

    expect(declarations).toContain("interface FixtureAddInput");
    expect(declarations).toContain("interface FixtureAddOutput");
    expect(declarations).toContain("interface FixtureEchoInput");
    expect(declarations).toContain("interface FixtureEchoOutput");
    expectInterfaceFields(declarations, "FixtureAddInput", [
      "a: number;",
      "b?: number;",
    ]);
    expectInterfaceFields(declarations, "FixtureAddOutput", ["sum: number;"]);
    expectInterfaceFields(declarations, "FixtureEchoInput", ["text: string;"]);
    expectInterfaceFields(declarations, "FixtureEchoOutput", ["text: string;"]);
    expect(declarations).toContain("declare namespace fixture");
    expect(declarations).toContain(
      "function add(input: FixtureAddInput): Promise<FixtureAddOutput>;",
    );
    expect(declarations).toContain(
      "function echo(input: FixtureEchoInput): Promise<FixtureEchoOutput>;",
    );
  });

  it("generates input and output declarations through json-schema-to-typescript", async () => {
    const declarations = await Effect.runPromise(
      generateDeclarations(groupDiscoveredMcpTools([fixtureAddTool()])),
    );

    expect(declarations).toContain("interface FixtureAddInput");
    expect(declarations).toContain("a: number;");
    expect(declarations).toContain("b?: number;");
    expect(declarations).toContain("interface FixtureAddOutput");
    expect(declarations).toContain("sum: number;");
    expect(declarations).toContain(
      "function add(input: FixtureAddInput): Promise<FixtureAddOutput>;",
    );
    expect(declarations).not.toContain("CodeModeToolResult");
  });

  it("handles arrays, enums, consts, primitive schemas, and missing outputSchema", async () => {
    const declarations = await Effect.runPromise(
      generateDeclarations(
        groupDiscoveredMcpTools([
          mcpTool({
            originalToolName: "choose",
            jsToolName: "choose",
            inputSchema: {
              type: "object",
              properties: {
                mode: { enum: ["fast", "safe"] },
                ids: { type: "array", items: { type: "string" } },
                answer: { const: 42 },
              },
              required: ["mode"],
            },
          }),
          mcpTool({
            originalToolName: "label",
            jsToolName: "label",
            inputSchema: { type: "string" },
          }),
        ]),
      ),
    );

    expect(declarations).toContain('mode: "fast" | "safe";');
    expect(declarations).toContain("ids?: string[];");
    expect(declarations).toContain("answer?: 42;");
    expect(declarations).toContain("type FixtureLabelInput = string;");
    expect(declarations).toContain(
      "function choose(input: FixtureChooseInput): Promise<unknown>;",
    );
  });

  it("falls back to unknown for malformed, null, and non-object schemas", async () => {
    const declarations = await Effect.runPromise(
      generateDeclarations(
        groupDiscoveredMcpTools([
          mcpTool({
            originalToolName: "broken",
            jsToolName: "broken",
            inputSchema: null,
            outputSchema: "bad",
          }),
          mcpTool({
            originalToolName: "array-schema",
            jsToolName: "array_schema",
            inputSchema: [],
            outputSchema: { type: "object", properties: {} },
          }),
        ]),
      ),
    );

    expect(declarations).toContain(
      "function broken(input: unknown): Promise<unknown>;",
    );
    expect(declarations).toContain(
      "function array_schema(input: unknown): Promise<FixtureArraySchemaOutput>;",
    );
  });

  it("uses unknown for tools whose output schema was marked invalid", async () => {
    const declarations = await Effect.runPromise(
      generateDeclarations(
        groupDiscoveredMcpTools([
          mcpTool({
            originalToolName: "upload_design_md",
            jsToolName: "upload_design_md",
            inputSchema: {
              type: "object",
              properties: {},
            },
            outputSchema: {
              type: "object",
              properties: {
                screen: { $ref: "#/$defs/ScreenInstance" },
              },
            },
            outputSchemaInvalid: true,
          }),
        ]),
      ),
    );

    expect(declarations).toContain(
      "function upload_design_md(input: FixtureUploadDesignMdInput): Promise<unknown>;",
    );
    expect(declarations).not.toContain("interface FixtureUploadDesignMdOutput");
  });

  it("strips top-level export keywords from generated declarations", async () => {
    const declarations = await Effect.runPromise(
      generateDeclarations(groupDiscoveredMcpTools([fixtureEchoTool()])),
    );

    expect(declarations).toContain("interface FixtureEchoInput");
    expect(declarations).not.toContain("export interface FixtureEchoInput");
    expect(declarations).not.toContain("export type");
  });

  it("fails loudly on duplicate generated type names", async () => {
    const result = await Effect.runPromise(
      Effect.either(
        generateDeclarations(
          groupDiscoveredMcpTools([
            mcpTool({
              originalToolName: "foo_bar",
              jsToolName: "foo_bar",
            }),
            mcpTool({
              originalToolName: "fooBar",
              jsToolName: "fooBar",
            }),
          ]),
        ),
      ),
    );

    expect(Either.isLeft(result)).toBe(true);

    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(CodeModeInvariantError);
      expect(result.left.message).toBe(
        "Duplicate generated type name: FixtureFooBarInput",
      );
    }
  });
});

describe("Provider generation and MCP result unwrapping", () => {
  it("dispatches provider calls to the expected registry tool and unwraps structuredContent", async () => {
    const calls: Array<CallToolRequest> = [];
    const providers = buildExecutorProviders(
      groupDiscoveredMcpTools([fixtureAddTool()]),
      {
        callTool: (request) => {
          calls.push(request);

          return Effect.succeed({
            content: [{ type: "text", text: "5" }],
            structuredContent: { sum: 5 },
          });
        },
      },
    );
    const add = providers[0]?.fns.add;

    expect(add).toBeDefined();

    const value = await Effect.runPromise(
      add?.({ a: 2, b: 3 }) ?? Effect.die("missing add"),
    );

    expect(calls).toEqual([
      {
        jsServerName: "fixture",
        jsToolName: "add",
        arguments: { a: 2, b: 3 },
      },
    ]);
    expect(value).toEqual({ sum: 5 });
  });

  it("unwraps text-only MCP content by joining and parsing when possible", () => {
    expect(
      unwrapMcpToolResult({
        content: [{ type: "text", text: '{"ok":true}' }],
      }),
    ).toEqual({ ok: true });
    expect(
      unwrapMcpToolResult({
        content: [
          { type: "text", text: "hello" },
          { type: "text", text: "world" },
        ],
      }),
    ).toBe("hello\nworld");
  });

  it("preserves rich or mixed MCP content as the raw result", () => {
    const imageResult = {
      content: [
        {
          type: "image",
          data: "abc",
          mimeType: "image/png",
        },
      ],
    };
    const mixedResult = {
      content: [
        { type: "text", text: "caption" },
        {
          type: "resource",
          resource: { uri: "file:///tmp/a.txt", text: "body" },
        },
      ],
    };

    expect(unwrapMcpToolResult(imageResult)).toBe(imageResult);
    expect(unwrapMcpToolResult(mixedResult)).toBe(mixedResult);
  });

  it("throws for MCP isError results using text content when available", () => {
    expect(() =>
      unwrapMcpToolResult({
        isError: true,
        content: [{ type: "text", text: "tool failed" }],
      }),
    ).toThrow("tool failed");
  });

  it("surfaces provider dispatch failures as thrown provider errors", async () => {
    const providers = buildExecutorProviders(
      groupDiscoveredMcpTools([fixtureAddTool()]),
      {
        callTool: () =>
          Effect.fail({
            _tag: "ToolNotFound",
          }),
      },
    );
    const add = providers[0]?.fns.add;
    const result = await Effect.runPromise(
      Effect.either(add?.({ a: 2, b: 3 }) ?? Effect.die("missing add")),
    );

    expect(Either.isLeft(result)).toBe(true);

    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(Error);
      expect((result.left as Error).message).toBe(
        "MCP tool not found: fixture.add",
      );
    }
  });
});

const runWithCodeMode = <A, E>(
  effect: Effect.Effect<A, E, CodeMode>,
  tools: ReadonlyArray<DiscoveredMcpTool>,
): Promise<A> =>
  Effect.runPromise(runWithCodeModeEffect(effect, tools));

const runWithCodeModeEffect = <A, E>(
  effect: Effect.Effect<A, E, CodeMode>,
  tools: ReadonlyArray<DiscoveredMcpTool>,
) =>
  effect.pipe(
    Effect.provide(
      makeCodeModeLive().pipe(
        Layer.provide(
          Layer.merge(makeRegistryLayer(tools), makeExecutorLayer()),
        ),
      ),
    ),
  );

const makeRegistryLayer = (
  tools: ReadonlyArray<DiscoveredMcpTool>,
  callTool: (
    request: CallToolRequest,
  ) => Effect.Effect<
    unknown,
    ToolNotFound | InvalidToolArguments | McpCallError
  > = () => Effect.dieMessage("callTool not implemented"),
  diagnostics: ReadonlyArray<McpRegistryDiagnostic> = [],
) =>
  Layer.succeed(McpRegistry, {
    listTools: Effect.succeed(tools),
    diagnostics: Effect.succeed(diagnostics),
    callTool,
  });

const makeExecutorLayer = (
  execute: (
    request: ExecuteRequest,
  ) => Effect.Effect<ExecuteResult, ExecutorError> = (request) =>
    Effect.succeed({
      value: request.providers?.map((provider) => provider.name) ?? [],
      logs: [],
    }),
) =>
  Layer.succeed(CodeExecutor, {
    execute,
  });

const fixtureAddTool = (): DiscoveredMcpTool =>
  mcpTool({
    originalToolName: "add",
    jsToolName: "add",
    title: "Add",
    description: "Add two numbers",
    inputSchema: {
      type: "object",
      properties: {
        a: { type: "number" },
        b: { type: "number" },
      },
      required: ["a"],
    },
    outputSchema: {
      type: "object",
      properties: {
        sum: { type: "number" },
      },
      required: ["sum"],
    },
  });

const fixtureEchoTool = (): DiscoveredMcpTool =>
  mcpTool({
    originalToolName: "echo",
    jsToolName: "echo",
    title: "Echo",
    description: "Echo text back to the caller",
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
        text: { type: "string" },
      },
      required: ["text"],
    },
  });

const mcpTool = (options: {
  readonly serverName?: string;
  readonly originalToolName: string;
  readonly jsServerName?: string;
  readonly jsToolName: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
  readonly outputSchema?: unknown;
  readonly outputSchemaInvalid?: true;
  readonly annotations?: unknown;
}): DiscoveredMcpTool => ({
  serverName: options.serverName ?? "fixture",
  originalToolName: options.originalToolName,
  jsServerName: options.jsServerName ?? "fixture",
  jsToolName: options.jsToolName,
  inputSchema:
    "inputSchema" in options
      ? options.inputSchema
      : {
          type: "object",
          properties: {},
        },
  ...(options.title === undefined ? {} : { title: options.title }),
  ...(options.description === undefined
    ? {}
    : { description: options.description }),
  ...(options.outputSchema === undefined
    ? {}
    : { outputSchema: options.outputSchema }),
  ...(options.outputSchemaInvalid === undefined
    ? {}
    : { outputSchemaInvalid: options.outputSchemaInvalid }),
  ...(options.annotations === undefined
    ? {}
    : { annotations: options.annotations }),
});

const toToolKeys = (context: {
  readonly servers: ReadonlyArray<{
    readonly jsServerName: string;
    readonly tools: ReadonlyArray<{
      readonly jsToolName: string;
    }>;
  }>;
}) =>
  context.servers.flatMap((server) =>
    server.tools.map((tool) => `${server.jsServerName}.${tool.jsToolName}`),
  );

const expectInterfaceFields = (
  declarations: string,
  interfaceName: string,
  fields: ReadonlyArray<string>,
): void => {
  const match = new RegExp(
    `interface\\s+${interfaceName}\\s*\\{([\\s\\S]*?)\\n\\}`,
  ).exec(declarations);

  expect(match, `missing interface ${interfaceName}`).not.toBeNull();

  const body = match?.[1] ?? "";

  for (const field of fields) {
    expect(body).toContain(field);
  }
};
