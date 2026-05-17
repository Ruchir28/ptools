import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { makeCodeModeLive, CodeMode, type CodeModeContext } from "@ptools/code-mode";
import { makeLocalSandboxExecutorLive } from "@ptools/executor";
import { makeMcpRegistryLive } from "@ptools/mcp-registry";
import { Context, Effect, Either, Layer, Scope } from "effect";
import { z } from "zod";
import { loadPtoolsConfig, resolveConfigPath } from "./config.js";

const SearchInputSchema = {
  query: z.string().optional(),
};

const SearchOutputSchema = {
  servers: z.array(z.unknown()),
  declarations: z.string(),
};

const EXECUTE_CODE_CONTRACT = [
  "code must be a JavaScript function expression that the executor can call.",
  "Use async arrow functions for provider calls: async () => { const r = await exa.web_search_exa({ query: \"...\" }); return r; }",
  "Do not send a script body, top-level await, top-level return, or a function declaration.",
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
        "Discover available MCP-backed provider APIs and TypeScript declarations for generated code.",
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

const formatSearchText = (context: CodeModeContext): string =>
  [
    "Execution contract:",
    EXECUTE_CODE_CONTRACT,
    "",
    "Example execute.code:",
    EXECUTE_CODE_EXAMPLE,
    "",
    "TypeScript declarations:",
    context.declarations.trimEnd(),
    "",
    "Metadata:",
    JSON.stringify({ servers: context.servers }, null, 2),
  ].join("\n");

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
