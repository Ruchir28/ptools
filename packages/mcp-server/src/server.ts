import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CodeModeClient,
  CodeModeExecuteRequest,
  CodeModeSearchProvidersRequest,
  CodeModeSearchRequest,
  CodeModeToolSchemaRequest,
  type CodeModeSearchProvidersResult,
  type CodeModeSearchResult,
  type CodeModeAuthStatusResult,
  type CodeModeToolSchemaResult,
  type CodeModeClientHandle,
  type CodeModeRequest,
  type CodeModeResponse,
} from "@ptools/code-mode-api";
import { Effect, Option, Scope } from "effect";
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
    .describe(
      "Preferred copy-safe tool IDs returned by search, such as github.create_issue.",
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
  "A good pattern is to use search to find candidate actions, get_tool_schema with returned toolIds, then execute.",
  "Provider namespaces returned by search, such as exa, are injected as globals inside that function.",
  "Use execute to keep intermediate provider results, filtering, joins, pagination, aggregation, and field extraction inside the code run; return only the compact result needed for the user.",
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

const AuthStatusOutputSchema = {
  authUrl: z.string(),
  servers: z.array(z.unknown()),
};

const RefreshOutputSchema = {
  refreshed: z.boolean(),
};

type CodeModeClientCaller = Pick<CodeModeClientHandle, "call">;

type ClientCallResult<Operation extends CodeModeResponse["operation"]> =
  | {
      readonly ok: true;
      readonly output: Extract<
        CodeModeResponse,
        { readonly operation: Operation }
      >["output"];
    }
  | { readonly ok: false; readonly cause: unknown };

export const serveMcpWithCodeModeClient = (
  client: CodeModeClientHandle,
): Effect.Effect<void, never> =>
  runMcpServer(client).pipe(
    Effect.ensuring(Effect.promise(() => client.close()).pipe(Effect.ignore)),
    Effect.scoped,
  );

export const serveMcpWithCodeModeClientService: Effect.Effect<
  void,
  never,
  CodeModeClient | Scope.Scope
> = Effect.gen(function* () {
  const client = yield* CodeModeClient;

  yield* runMcpServer({
    call: (request) => Effect.runPromise(client.call(request)),
  });
});

const runMcpServer = (
  client: CodeModeClientCaller,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    const server = new McpServer({
      name: "ptools-code-mode",
      version: "0.0.0",
    });

    yield* writeStartupDiagnostics(client).pipe(Effect.ignore);

    registerCodeModeTools(server, client);

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
  client: CodeModeClientCaller,
): void => {
  server.registerTool(
    "auth_status",
    {
      title: "Get Upstream MCP Auth Status",
      description:
        "Show the ptools auth center URL and current auth state for every configured upstream MCP server. If a provider requires auth, ask the user to open authUrl and authorize it, then call search again.",
      inputSchema: {},
      outputSchema: AuthStatusOutputSchema,
    },
    async () => {
      const result = await callClient(client, { operation: "auth_status" });

      return result.ok
        ? {
            content: [
              {
                type: "text" as const,
                text: formatAuthStatusText(result.output),
              },
            ],
            structuredContent: toStructuredContent(result.output),
          }
        : toToolError(result.cause);
    },
  );

  server.registerTool(
    "refresh",
    {
      title: "Refresh Upstream MCP Registry",
      description:
        "Reconnect and rediscover configured upstream MCP servers after the user authorizes a provider in the ptools auth center.",
      inputSchema: {},
      outputSchema: RefreshOutputSchema,
    },
    async () => {
      const result = await callClient(client, { operation: "refresh" });

      return result.ok
        ? {
            content: [
              {
                type: "text" as const,
                text: "Refreshed upstream MCP registry.",
              },
            ],
            structuredContent: toStructuredContent(result.output),
          }
        : toToolError(result.cause);
    },
  );

  server.registerTool(
    "search_providers",
    {
      title: "Search Code Mode Providers",
      description:
        'Find configured upstream MCP provider namespaces behind this single ptools server. Call with {} to see available providers, or with { query: "..." } when the task mentions a source or capability and you are unsure which provider owns it. Use a returned provider value to narrow search when helpful.',
      inputSchema: SearchProvidersInputSchema,
      outputSchema: SearchProvidersOutputSchema,
    },
    async ({ query, limit }) => {
      const request = CodeModeSearchProvidersRequest.make({
        query: Option.fromNullable(query),
        limit: Option.fromNullable(limit),
      });
      const result = await callClient(client, {
        operation: "search_providers",
        input: request,
      });

      return result.ok
        ? {
            content: [
              {
                type: "text" as const,
                text: formatSearchProvidersText(result.output),
              },
            ],
            structuredContent: toStructuredContent(result.output),
          }
        : toToolError(result.cause);
    },
  );

  server.registerTool(
    "search",
    {
      title: "Search Code Mode Actions",
      description:
        'Find MCP-backed actions for a task. This is action discovery; use search_providers first when you need to discover which upstream providers are available. Call with { query: "..." }, optionally with { provider: "..." } to narrow. A good next step is get_tool_schema for selected action.toolId values before execute.',
      inputSchema: SearchInputSchema,
      outputSchema: SearchOutputSchema,
    },
    async ({ query, provider, limit }) => {
      const request = CodeModeSearchRequest.make({
        query,
        provider: Option.fromNullable(provider),
        limit: Option.fromNullable(limit),
      });
      const result = await callClient(client, {
        operation: "search",
        input: request,
      });

      return result.ok
        ? {
            content: [
              { type: "text" as const, text: formatSearchText(result.output) },
            ],
            structuredContent: toStructuredContent(result.output),
          }
        : toToolError(result.cause);
    },
  );

  server.registerTool(
    "get_tool_schema",
    {
      title: "Get Code Mode Tool Schemas",
      description:
        "Fetch full JSON schemas and self-contained TypeScript declarations for one or more tools selected from search. Prefer a small set of toolIds you actually plan to call, then use execute to combine tool calls and reduce intermediate results. Fails the whole request if any requested tool is unknown.",
      inputSchema: ToolSchemaInputSchema,
      outputSchema: ToolSchemaOutputSchema,
    },
    async ({ toolIds }) => {
      const request = CodeModeToolSchemaRequest.make({ toolIds });
      const result = await callClient(client, {
        operation: "get_tool_schema",
        input: request,
      });

      return result.ok
        ? {
            content: [
              {
                type: "text" as const,
                text: formatToolSchemaText(result.output),
              },
            ],
            structuredContent: toStructuredContent(result.output),
          }
        : toToolError(result.cause);
    },
  );

  server.registerTool(
    "execute",
    {
      title: "Execute Code Mode JavaScript",
      description: `Run generated JavaScript against MCP-backed provider APIs discovered through search. This is the best place for multi-step provider calls, result inspection, filtering, aggregation, joins, and extracting the few fields needed for the final answer. ${EXECUTE_CODE_CONTRACT}`,
      inputSchema: ExecuteInputSchema,
      outputSchema: ExecuteOutputSchema,
    },
    async ({ code, timeoutMs }) => {
      const request = CodeModeExecuteRequest.make({
        code,
        timeoutMs: Option.fromNullable(timeoutMs),
      });
      const result = await callClient(client, {
        operation: "execute",
        input: request,
      });

      return result.ok
        ? {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(result.output, null, 2),
              },
            ],
            structuredContent: toStructuredContent(result.output),
          }
        : toToolError(result.cause);
    },
  );
};

const toStructuredContent = (value: object): Record<string, unknown> =>
  value as Record<string, unknown>;

const callClient = async <Operation extends CodeModeRequest["operation"]>(
  client: CodeModeClientCaller,
  request: Extract<CodeModeRequest, { readonly operation: Operation }>,
): Promise<ClientCallResult<Operation>> => {
  try {
    const response = await client.call(request);

    if (response.operation !== request.operation) {
      throw new Error(
        `Code Mode client returned ${response.operation} for ${request.operation}`,
      );
    }

    return {
      ok: true,
      output: (
        response as Extract<CodeModeResponse, { readonly operation: Operation }>
      ).output,
    } as ClientCallResult<Operation>;
  } catch (cause) {
    return { ok: false, cause };
  }
};

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
      "These are schema-free action candidates. A good next step is get_tool_schema for the selected toolIds, then execute.code to call providers and reduce intermediate results before returning a compact answer.",
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

const formatAuthStatusText = (result: CodeModeAuthStatusResult): string =>
  [
    "Upstream MCP auth status:",
    `Auth center: ${result.authUrl}`,
    "",
    "If a server status is requires_auth, ask the user to open the auth center and authorize that server. If a server is connected but tool calls still fail auth, ask the user to open reauthorizeUrl for that server. Then call refresh or search again.",
    "",
    "Servers:",
    JSON.stringify(result.servers, null, 2),
  ].join("\n");

const writeStartupDiagnostics = (
  client: CodeModeClientCaller,
): Effect.Effect<void, never> =>
  Effect.promise(() =>
    callClient(client, { operation: "search_providers" }),
  ).pipe(
    Effect.flatMap((result) =>
      result.ok && result.output.diagnostics.length > 0
        ? Effect.sync(() => {
            process.stderr.write(
              `[ptools] MCP registry diagnostics:\n${JSON.stringify(
                result.output.diagnostics,
                null,
                2,
              )}\n`,
            );
          })
        : Effect.void,
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
