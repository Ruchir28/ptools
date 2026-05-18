import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  makeCodeModeLive,
  CodeMode,
  type CodeModeSearchResult,
  type CodeModeToolSchemaResult,
} from "@ptools/code-mode";
import { loadPtoolsConfig, resolveConfigPath } from "@ptools/core";
import { makeLocalSandboxExecutorLive } from "@ptools/executor";
import { makeMcpRegistryLive } from "@ptools/mcp-registry";
import { Context, Effect, Either, Layer, Scope } from "effect";
import { z } from "zod";

const SearchInputSchema = {
  query: z.string().optional(),
};

const SearchOutputSchema = {
  servers: z.array(z.unknown()),
  diagnostics: z.array(z.unknown()),
};

const ToolSchemaInputSchema = {
  tools: z
    .array(
      z.object({
        jsServerName: z.string().trim().min(1),
        jsToolName: z.string().trim().min(1),
      }),
    )
    .describe(
      "Selected tools from search() whose full JSON schemas and TypeScript declaration snippets are needed.",
    ),
};

const ToolSchemaOutputSchema = {
  tools: z.array(z.unknown()),
  declarationsByServer: z.array(z.unknown()),
  diagnostics: z.array(z.unknown()),
};

const EXECUTE_CODE_CONTRACT = [
  "code must be a JavaScript function expression that the executor can call.",
  "Use async arrow functions for provider calls: async () => { const r = await exa.web_search_exa({ query: \"...\" }); return r; }",
  "Do not send a script body, top-level await, top-level return, or a function declaration.",
  "First use search to find candidate provider APIs, then get_tool_schema for tools you plan to call, then execute.",
  "Provider namespaces returned by search, such as exa, are injected as globals inside that function.",
].join(" ");

const EXECUTE_CODE_EXAMPLE = `async () => {
  const result = await exa.web_search_exa({
    query: "OpenCode MCP local server config",
    numResults: 3
  });

  return result;
}`;

const ExecuteInputSchema = {
  code: z
    .string()
    .describe(`${EXECUTE_CODE_CONTRACT} Example:\n${EXECUTE_CODE_EXAMPLE}`),
  timeoutMs: z
    .number()
    .optional()
    .describe("Optional per-run timeout override in milliseconds."),
};

const ExecuteOutputSchema = {
  value: z.unknown(),
  logs: z.array(z.unknown()),
};

/**
 * Starts the combined ptools MCP server over stdio.
 *
 * @param argv Command-line args after the executable and script path.
 * @param env Environment map used for config path and explicit secret refs.
 * @param cwd Directory used to resolve relative config paths.
 * @returns An Effect that stays alive until stdio closes or the process exits.
 */
export const runServer = (
  argv: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
  cwd: string,
): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    const configPath = yield* resolveConfigPath(argv, env, cwd);
    const config = yield* loadPtoolsConfig(configPath, env);
    const live = makeCodeModeLive().pipe(
      Layer.provide(
        Layer.merge(
          makeMcpRegistryLive(config.mcpServers),
          makeLocalSandboxExecutorLive(config.executor),
        ),
      ),
    );

    yield* runMcpServer.pipe(Effect.provide(live));
  }).pipe(Effect.scoped);

const runMcpServer: Effect.Effect<void, never, CodeMode | Scope.Scope> = Effect.gen(
  function* () {
    const codeMode = yield* CodeMode;
    const server = new McpServer({
      name: "ptools-code-mode",
      version: "0.0.0",
    });

    yield* writeStartupDiagnostics(codeMode);

    registerCodeModeTools(server, codeMode);

    yield* Effect.acquireRelease(
      Effect.promise(() => server.connect(new StdioServerTransport())),
      () => Effect.promise(() => server.close()).pipe(Effect.ignore),
    );

    yield* waitForProcessClose;
  },
);

/**
 * Registers the public model-facing Code Mode tools on the MCP server.
 *
 * @param server MCP server instance that owns the public stdio transport.
 * @param codeMode Host-side Code Mode service used by tool callbacks.
 * @returns Nothing; tools are registered as a side effect on the MCP server.
 */
export const registerCodeModeTools = (
  server: McpServer,
  codeMode: Context.Tag.Service<typeof CodeMode>,
): void => {
  server.registerTool(
    "search",
    {
      title: "Search Code Mode APIs",
      description:
        "Discover schema-free MCP-backed provider API summaries. Use get_tool_schema for selected tools before execute.",
      inputSchema: SearchInputSchema,
      outputSchema: SearchOutputSchema,
    },
    async ({ query }) => {
      const request = query === undefined ? {} : { query };
      const result = await Effect.runPromise(
        codeMode.search(request).pipe(Effect.either),
      );

      if (Either.isLeft(result)) {
        return toToolError(result.left);
      }

      return {
        content: [{ type: "text" as const, text: formatSearchText(result.right) }],
        structuredContent: toStructuredContent(result.right),
      };
    },
  );

  server.registerTool(
    "get_tool_schema",
    {
      title: "Get Code Mode Tool Schemas",
      description:
        "Fetch full JSON schemas and self-contained TypeScript declarations for one or more tools selected from search. Fails the whole request if any requested tool is unknown.",
      inputSchema: ToolSchemaInputSchema,
      outputSchema: ToolSchemaOutputSchema,
    },
    async ({ tools }) => {
      const result = await Effect.runPromise(
        codeMode.toolSchema({ tools }).pipe(Effect.either),
      );

      if (Either.isLeft(result)) {
        return toToolError(result.left);
      }

      return {
        content: [
          {
            type: "text" as const,
            text: formatToolSchemaText(result.right),
          },
        ],
        structuredContent: toStructuredContent(result.right),
      };
    },
  );

  server.registerTool(
    "execute",
    {
      title: "Execute Code Mode JavaScript",
      description: `Run generated JavaScript against MCP-backed provider APIs discovered through search. ${EXECUTE_CODE_CONTRACT}`,
      inputSchema: ExecuteInputSchema,
      outputSchema: ExecuteOutputSchema,
    },
    async ({ code, timeoutMs }) => {
      const request =
        timeoutMs === undefined ? { code } : { code, timeoutMs };
      const result = await Effect.runPromise(
        codeMode.execute(request).pipe(Effect.either),
      );

      if (Either.isLeft(result)) {
        return toToolError(result.left);
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result.right, null, 2),
          },
        ],
        structuredContent: toStructuredContent(result.right),
      };
    },
  );
};

const toStructuredContent = (value: object): Record<string, unknown> =>
  value as Record<string, unknown>;

const waitForProcessClose: Effect.Effect<void> = Effect.async<void>((resume) => {
  const done = (): void => {
    process.stdin.off("close", done);
    process.stdin.off("end", done);
    process.off("SIGINT", done);
    process.off("SIGTERM", done);
    resume(Effect.void);
  };

  process.stdin.once("close", done);
  process.stdin.once("end", done);
  process.once("SIGINT", done);
  process.once("SIGTERM", done);

  return Effect.sync(() => {
    process.stdin.off("close", done);
    process.stdin.off("end", done);
    process.off("SIGINT", done);
    process.off("SIGTERM", done);
  });
});

const formatSearchText = (context: CodeModeSearchResult): string =>
  maybeAppendDiagnostics([
    "Discovery result:",
    "These are schema-free API summaries. Call get_tool_schema with one or more { jsServerName, jsToolName } entries before writing execute.code.",
    "",
    "Execution contract:",
    EXECUTE_CODE_CONTRACT,
    "",
    "Example execute.code:",
    EXECUTE_CODE_EXAMPLE,
    "",
    "Metadata:",
    JSON.stringify({ servers: context.servers }, null, 2),
  ], context).join("\n");

const formatToolSchemaText = (result: CodeModeToolSchemaResult): string =>
  maybeAppendDiagnostics([
    "Selected tool schemas and declarations:",
    JSON.stringify(
      {
        tools: result.tools,
        declarationsByServer: result.declarationsByServer,
      },
      null,
      2,
    ),
  ], result).join("\n");

const writeStartupDiagnostics = (
  codeMode: Context.Tag.Service<typeof CodeMode>,
): Effect.Effect<void> =>
  codeMode.diagnostics.pipe(
    Effect.flatMap((diagnostics) =>
      diagnostics.length === 0
        ? Effect.void
        : Effect.sync(() => {
            process.stderr.write(
              `[ptools] MCP registry diagnostics:\n${JSON.stringify(
                diagnostics,
                null,
                2,
              )}\n`,
            );
          }),
    ),
  );

const maybeAppendDiagnostics = (
  lines: ReadonlyArray<string>,
  context: {
    readonly diagnostics: ReadonlyArray<unknown>;
  },
): ReadonlyArray<string> =>
  context.diagnostics.length === 0
    ? lines
    : [
        ...lines,
        "",
        "Diagnostics:",
        JSON.stringify(context.diagnostics, null, 2),
      ];

const toToolError = (cause: unknown): {
  readonly isError: true;
  readonly content: Array<{ readonly type: "text"; readonly text: string }>;
} => ({
  isError: true,
  content: [{ type: "text", text: safeErrorMessage(cause) }],
});

const safeErrorMessage = (cause: unknown): string => {
  if (
    typeof cause === "object" &&
    cause !== null &&
    "message" in cause &&
    typeof cause.message === "string"
  ) {
    return cause.message;
  }

  if (
    typeof cause === "object" &&
    cause !== null &&
    "_tag" in cause &&
    typeof cause._tag === "string"
  ) {
    return cause._tag;
  }

  return String(cause);
};

const main = async (): Promise<void> => {
  await Effect.runPromise(runServer(process.argv.slice(2), process.env, process.cwd()));
};

main().catch((cause: unknown) => {
  process.stderr.write(`${safeErrorMessage(cause)}\n`);
  process.exitCode = 1;
});
