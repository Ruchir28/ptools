import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  makeCodeModeLive,
  CodeMode,
  type CodeModeSearchProvidersResult,
  type CodeModeSearchResult,
  type CodeModeToolSchemaResult,
} from "@ptools/code-mode";
import { loadPtoolsConfig, resolveConfigPath } from "@ptools/core";
import { makeLocalSandboxExecutorLive } from "@ptools/executor";
import { makeMcpRegistryLive } from "@ptools/mcp-registry";
import { Context, Effect, Either, Layer, Scope } from "effect";
import { z } from "zod";

const SearchProvidersInputSchema = {
  query: z.string().optional(),
  limit: z.number().int().positive().optional(),
};

const SearchProvidersOutputSchema = {
  providers: z.array(z.unknown()),
  diagnostics: z.array(z.unknown()),
};

const SearchInputSchema = {
  query: z.string().trim().min(1),
  provider: z.string().trim().min(1).optional(),
  limit: z.number().int().positive().optional(),
};

const SearchOutputSchema = {
  actions: z.array(z.unknown()),
  diagnostics: z.array(z.unknown()),
};

const ToolSchemaInputSchema = {
  toolIds: z
    .array(z.string().trim().min(1))
    .optional()
    .describe(
      "Preferred copy-safe tool IDs returned by search, such as github.create_issue.",
    ),
  tools: z
    .array(
      z.object({
        jsServerName: z.string().trim().min(1),
        jsToolName: z.string().trim().min(1),
      }),
    )
    .optional()
    .describe(
      "Compatibility selector for selected tools when toolIds are not used.",
    ),
};

const ToolSchemaOutputSchema = {
  tools: z.array(z.unknown()),
  declarationsByServer: z.array(z.unknown()),
  diagnostics: z.array(z.unknown()),
};

const EXECUTE_CODE_CONTRACT = [
  "code must be a JavaScript function expression that the executor can call.",
  'Use async arrow functions for provider calls: async () => { const r = await exa.web_search_exa({ query: "..." }); return r; }',
  "Do not send a script body, top-level await, top-level return, or a function declaration.",
  "First use search to find candidate actions, then get_tool_schema with returned toolIds, then execute.",
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

const runMcpServer: Effect.Effect<void, never, CodeMode | Scope.Scope> =
  Effect.gen(function* () {
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
  });

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
    "search_providers",
    {
      title: "Search Code Mode Providers",
      description:
        'Find configured MCP provider namespaces. Call with {} to list all providers, or with { query: "..." } to find providers by name or capability. Use a returned provider value to narrow search when helpful.',
      inputSchema: SearchProvidersInputSchema,
      outputSchema: SearchProvidersOutputSchema,
    },
    async ({ query, limit }) => {
      const request = {
        ...(query === undefined ? {} : { query }),
        ...(limit === undefined ? {} : { limit }),
      };
      const result = await Effect.runPromise(
        codeMode.searchProviders(request).pipe(Effect.either),
      );

      if (Either.isLeft(result)) {
        return toToolError(result.left);
      }

      return {
        content: [
          {
            type: "text" as const,
            text: formatSearchProvidersText(result.right),
          },
        ],
        structuredContent: toStructuredContent(result.right),
      };
    },
  );

  server.registerTool(
    "search",
    {
      title: "Search Code Mode Actions",
      description:
        'Find MCP-backed actions for a task. Call with { query: "..." }, optionally with { provider: "..." } to narrow. Use returned action.toolId values with get_tool_schema before execute.',
      inputSchema: SearchInputSchema,
      outputSchema: SearchOutputSchema,
    },
    async ({ query, provider, limit }) => {
      const request = {
        query,
        ...(provider === undefined ? {} : { provider }),
        ...(limit === undefined ? {} : { limit }),
      };
      const result = await Effect.runPromise(
        codeMode.search(request).pipe(Effect.either),
      );

      if (Either.isLeft(result)) {
        return toToolError(result.left);
      }

      return {
        content: [
          { type: "text" as const, text: formatSearchText(result.right) },
        ],
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
    async ({ toolIds, tools }) => {
      const request = {
        ...(toolIds === undefined ? {} : { toolIds }),
        ...(tools === undefined ? {} : { tools }),
      };
      const result = await Effect.runPromise(
        codeMode.toolSchema(request).pipe(Effect.either),
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
      const request = timeoutMs === undefined ? { code } : { code, timeoutMs };
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

const waitForProcessClose: Effect.Effect<void> = Effect.async<void>(
  (resume) => {
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
  },
);

const formatSearchProvidersText = (
  context: CodeModeSearchProvidersResult,
): string =>
  maybeAppendDiagnostics(
    [
      "Provider discovery result:",
      "Use a provider value to narrow search when helpful, or call search with a task query to find actions.",
      "",
      "Providers:",
      JSON.stringify(context.providers, null, 2),
    ],
    context,
  ).join("\n");

const formatSearchText = (context: CodeModeSearchResult): string =>
  maybeAppendDiagnostics(
    [
      "Action discovery result:",
      "These are schema-free action candidates. Call get_tool_schema with one or more returned toolIds before writing execute.code.",
      "",
      "Execution contract:",
      EXECUTE_CODE_CONTRACT,
      "",
      "Example execute.code:",
      EXECUTE_CODE_EXAMPLE,
      "",
      "Actions:",
      JSON.stringify(context.actions, null, 2),
    ],
    context,
  ).join("\n");

const formatToolSchemaText = (result: CodeModeToolSchemaResult): string =>
  maybeAppendDiagnostics(
    [
      "Selected tool schemas and declarations:",
      JSON.stringify(
        {
          tools: result.tools,
          declarationsByServer: result.declarationsByServer,
        },
        null,
        2,
      ),
    ],
    result,
  ).join("\n");

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

const toToolError = (
  cause: unknown,
): {
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
  await Effect.runPromise(
    runServer(process.argv.slice(2), process.env, process.cwd()),
  );
};

main().catch((cause: unknown) => {
  process.stderr.write(`${safeErrorMessage(cause)}\n`);
  process.exitCode = 1;
});
