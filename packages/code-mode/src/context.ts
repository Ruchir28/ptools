import type {
  ExecutorProvider,
  ExecutorProviderHandler,
  ExecutorProviders,
} from "@ptools/executor";
import type { CallToolRequest, DiscoveredMcpTool } from "@ptools/mcp-registry";
import { Effect } from "effect";
import {
  buildDeclarationIndex,
  renderDeclarations,
  type DeclarationIndex,
  type SchemaCompiler,
} from "./declarations.js";
import { CodeModeInvariantError } from "./errors.js";
import type {
  CodeModeContext,
  CodeModeServerMetadata,
  CodeModeToolMetadata,
} from "./types.js";
import { unwrapMcpToolResult } from "./unwrap.js";

interface McpCallToolService {
  readonly callTool: (
    request: CallToolRequest,
  ) => Effect.Effect<unknown, unknown>;
}

export interface CodeModeRuntime {
  readonly servers: ReadonlyArray<CodeModeServerMetadata>;
  readonly providers: ExecutorProviders;
  readonly declarationIndex: DeclarationIndex;
  readonly fullContext: CodeModeContext;
}

export interface BuildCodeModeRuntimeOptions {
  readonly schemaCompiler?: SchemaCompiler;
}

/**
 * Converts discovered MCP tools into the runtime shape Code Mode needs.
 *
 * @param tools Flat tool list returned by `McpRegistry.listTools`.
 * @param registry Registry service used by generated provider handlers.
 * @param options Optional test seams for runtime construction.
 * @returns Grouped Code Mode metadata plus executor providers.
 */
export const buildCodeModeRuntime = (
  tools: ReadonlyArray<DiscoveredMcpTool>,
  registry: McpCallToolService,
  options: BuildCodeModeRuntimeOptions = {},
): Effect.Effect<CodeModeRuntime, CodeModeInvariantError> =>
  Effect.gen(function* () {
    const { servers, providers } = yield* Effect.try({
      try: () => {
        const servers = groupDiscoveredMcpTools(tools);

        return {
          servers,
          providers: buildExecutorProviders(servers, registry),
        };
      },
      catch: normalizeInvariantError,
    });
    const declarationIndex = yield* buildDeclarationIndex(
      servers,
      options.schemaCompiler,
    );
    const fullContext = yield* makeCodeModeContext(servers, declarationIndex);

    return {
      servers,
      providers,
      declarationIndex,
      fullContext,
    };
  });

/**
 * Builds a model-facing Code Mode context from cached declarations.
 *
 * @param servers Grouped server/tool metadata.
 * @param declarationIndex Startup-built declaration fragment cache.
 * @returns Metadata plus generated TypeScript declarations for that surface.
 */
export const makeCodeModeContext = (
  servers: ReadonlyArray<CodeModeServerMetadata>,
  declarationIndex: DeclarationIndex,
): Effect.Effect<CodeModeContext, CodeModeInvariantError> =>
  Effect.try({
    try: () => ({
      servers,
      declarations: renderDeclarations(servers, declarationIndex),
    }),
    catch: normalizeInvariantError,
  });

/**
 * Filters grouped server metadata for `search({ query })`.
 *
 * @param servers Full or already-filtered server metadata.
 * @param query Optional whitespace-separated query string.
 * @returns Matching servers with only matching tools; returns the same array
 * reference when the query is absent or blank.
 */
export const filterCodeModeServers = (
  servers: ReadonlyArray<CodeModeServerMetadata>,
  query?: string,
): ReadonlyArray<CodeModeServerMetadata> => {
  const tokens = query
    ?.trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length > 0);

  if (tokens === undefined || tokens.length === 0) {
    return servers;
  }

  return servers
    .map((server) => ({
      ...server,
      tools: server.tools.filter((tool) => matchesTool(server, tool, tokens)),
    }))
    .filter((server) => server.tools.length > 0);
};

/**
 * Groups the registry's flat discovered-tool list by sanitized JS server name.
 *
 * @param tools Flat discovered MCP tools from the registry.
 * @returns Server metadata preserving discovery order.
 */
export const groupDiscoveredMcpTools = (
  tools: ReadonlyArray<DiscoveredMcpTool>,
): ReadonlyArray<CodeModeServerMetadata> => {
  const servers = new Map<string, CodeModeServerMetadata>();
  const seenToolKeys = new Set<string>();

  for (const tool of tools) {
    const existingServer = servers.get(tool.jsServerName);

    if (
      existingServer !== undefined &&
      existingServer.serverName !== tool.serverName
    ) {
      throw new CodeModeInvariantError({
        message: `Duplicate JS server name: ${tool.jsServerName}`,
        cause: {
          originals: [existingServer.serverName, tool.serverName],
        },
      });
    }

    const toolKey = `${tool.jsServerName}.${tool.jsToolName}`;

    if (seenToolKeys.has(toolKey)) {
      throw new CodeModeInvariantError({
        message: `Duplicate JS tool name: ${toolKey}`,
      });
    }

    seenToolKeys.add(toolKey);

    const server =
      existingServer ??
      ({
        serverName: tool.serverName,
        jsServerName: tool.jsServerName,
        tools: [],
      } satisfies CodeModeServerMetadata);
    const nextTool = toCodeModeToolMetadata(tool);

    servers.set(tool.jsServerName, {
      ...server,
      tools: [...server.tools, nextTool],
    });
  }

  return [...servers.values()];
};

/**
 * Creates executor provider namespaces backed by MCP registry dispatch.
 *
 * @param servers Grouped Code Mode metadata.
 * @param registry Registry service used to call original upstream MCP tools.
 * @returns Executor providers exposed to sandbox code as globals.
 */
export const buildExecutorProviders = (
  servers: ReadonlyArray<CodeModeServerMetadata>,
  registry: McpCallToolService,
): ExecutorProviders =>
  servers.map(
    (server): ExecutorProvider => ({
      name: server.jsServerName,
      fns: Object.fromEntries(
        server.tools.map((tool) => [
          tool.jsToolName,
          makeToolHandler(server, tool, registry),
        ]),
      ) as Readonly<Record<string, ExecutorProviderHandler>>,
    }),
  );

/**
 * Creates one sandbox-visible provider function for a discovered MCP tool.
 *
 * @param server Server metadata owning the tool.
 * @param tool Tool metadata to dispatch.
 * @param registry Registry service used for the real MCP `callTool`.
 * @returns Executor handler that accepts sandbox input and returns an unwrapped
 * MCP result.
 */
const makeToolHandler =
  (
    server: CodeModeServerMetadata,
    tool: CodeModeToolMetadata,
    registry: McpCallToolService,
  ): ExecutorProviderHandler =>
  (input) =>
    registry
      .callTool({
        jsServerName: server.jsServerName,
        jsToolName: tool.jsToolName,
        arguments: input,
      })
      .pipe(
        Effect.mapError((cause) =>
          normalizeProviderFailure(server, tool, cause),
        ),
        Effect.flatMap((result) =>
          Effect.try({
            try: () => unwrapMcpToolResult(result),
            catch: (cause) => normalizeProviderFailure(server, tool, cause),
          }),
        ),
      );

/**
 * Copies registry metadata into the smaller public Code Mode tool shape.
 *
 * @param tool Discovered registry tool.
 * @returns Code Mode tool metadata with optional fields omitted when absent.
 */
const toCodeModeToolMetadata = (
  tool: DiscoveredMcpTool,
): CodeModeToolMetadata => ({
  originalToolName: tool.originalToolName,
  jsToolName: tool.jsToolName,
  inputSchema: tool.inputSchema,
  ...(tool.title === undefined ? {} : { title: tool.title }),
  ...(tool.description === undefined ? {} : { description: tool.description }),
  ...(tool.outputSchema === undefined
    ? {}
    : { outputSchema: tool.outputSchema }),
  ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
});

/**
 * Checks whether a tool should be included for a tokenized search query.
 *
 * @param server Server metadata used for searchable server names.
 * @param tool Tool metadata used for searchable tool names/title/description.
 * @param tokens Lowercase query tokens.
 * @returns `true` when any token appears in the combined searchable text.
 */
const matchesTool = (
  server: CodeModeServerMetadata,
  tool: CodeModeToolMetadata,
  tokens: ReadonlyArray<string>,
): boolean => {
  const searchable = [
    server.serverName,
    server.jsServerName,
    tool.originalToolName,
    tool.jsToolName,
    tool.title,
    tool.description,
  ]
    .filter((value): value is string => value !== undefined)
    .join(" ")
    .toLowerCase();

  return tokens.some((token) => searchable.includes(token));
};

/**
 * Normalizes registry or unwrapping failures into plain Errors for sandbox RPC.
 *
 * @param server Server metadata for the failing provider.
 * @param tool Tool metadata for the failing provider.
 * @param cause Original Effect failure or thrown value.
 * @returns Error surfaced to generated sandbox code.
 */
const normalizeProviderFailure = (
  server: CodeModeServerMetadata,
  tool: CodeModeToolMetadata,
  cause: unknown,
): Error => {
  if (cause instanceof Error && cause.message.length > 0) {
    return cause;
  }

  return new Error(formatProviderFailure(server, tool, cause));
};

/**
 * Creates a stable human-readable provider failure message.
 *
 * @param server Server metadata for the failed call.
 * @param tool Tool metadata for the failed call.
 * @param cause Registry failure value.
 * @returns Message used in the sandbox-visible Error.
 */
const formatProviderFailure = (
  server: CodeModeServerMetadata,
  tool: CodeModeToolMetadata,
  cause: unknown,
): string => {
  const tag = getErrorTag(cause);
  const toolKey = `${server.jsServerName}.${tool.jsToolName}`;

  if (tag === "ToolNotFound") {
    return `MCP tool not found: ${toolKey}`;
  }

  if (tag === "InvalidToolArguments") {
    return `Invalid arguments for MCP tool: ${toolKey}`;
  }

  if (tag === "McpCallError") {
    return `MCP tool call failed: ${toolKey}`;
  }

  return `MCP provider call failed: ${toolKey}`;
};

/**
 * Reads an Effect/Data tagged-error name from an unknown failure value.
 *
 * @param cause Unknown failure from the registry layer.
 * @returns `_tag` string when present.
 */
const getErrorTag = (cause: unknown): string | undefined =>
  typeof cause === "object" &&
  cause !== null &&
  "_tag" in cause &&
  typeof cause._tag === "string"
    ? cause._tag
    : undefined;

/**
 * Converts thrown invariant-building failures into the package error type.
 *
 * @param cause Unknown thrown value while building Code Mode runtime metadata.
 * @returns Code Mode invariant error.
 */
const normalizeInvariantError = (cause: unknown): CodeModeInvariantError =>
  cause instanceof CodeModeInvariantError
    ? cause
    : new CodeModeInvariantError({
        message: "Failed to build Code Mode runtime",
        cause,
      });
