import type {
  ExecutorProvider,
  ExecutorProviderHandler,
  ExecutorProviders,
} from "@ptools/executor";
import type {
  CallToolRequest,
  DiscoveredMcpTool,
  McpRegistryDiagnostic,
} from "@ptools/mcp-registry";
import { Effect, Option } from "effect";
import {
  buildDeclarationIndex,
  renderServerDeclaration,
  type DeclarationIndex,
  type SchemaCompiler,
} from "./declarations.js";
import { CodeModeInvariantError } from "./errors.js";
import { CodeModeSearchProvidersRequest } from "@ptools/code-mode-api";
import type {
  CodeModeActionCandidate,
  CodeModeProviderSummary,
  CodeModeSearchProvidersResult,
  CodeModeSearchResult,
  CodeModeServerMetadata,
  CodeModeToolSchemaRequest,
  CodeModeToolSchemaResult,
  CodeModeToolSchema,
  CodeModeToolMetadata,
  CodeModeSearchRequest,
} from "@ptools/code-mode-api";
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
  readonly fullProviderSearchResult: CodeModeSearchProvidersResult;
  readonly diagnostics: ReadonlyArray<McpRegistryDiagnostic>;
}

export interface BuildCodeModeRuntimeOptions {
  readonly schemaCompiler?: SchemaCompiler;
  readonly diagnostics?: ReadonlyArray<McpRegistryDiagnostic>;
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
    const diagnostics = options.diagnostics ?? [];
    const declarationIndex = yield* buildDeclarationIndex(
      servers,
      options.schemaCompiler,
    );
    const fullProviderSearchResult = makeCodeModeSearchProvidersResult(
      servers,
      diagnostics,
    );

    return {
      servers,
      providers,
      declarationIndex,
      fullProviderSearchResult,
      diagnostics,
    };
  });

/**
 * Builds a schema-free model-facing provider search result.
 *
 * @param servers Grouped server/tool metadata.
 * @param diagnostics Registry diagnostics to carry alongside search results.
 * @param request Optional provider-search request.
 * @returns Compact provider summaries without raw schemas or declaration bundles.
 */
export const makeCodeModeSearchProvidersResult = (
  servers: ReadonlyArray<CodeModeServerMetadata>,
  diagnostics: ReadonlyArray<McpRegistryDiagnostic> = [],
  request: CodeModeSearchProvidersRequest = CodeModeSearchProvidersRequest.make({
    query: Option.none(),
    limit: Option.none(),
  }),
): CodeModeSearchProvidersResult => ({
  providers: limitRows(
    rankProviders(
      servers,
      tokenize(Option.getOrUndefined(request.query)),
    ).map(toCodeModeProviderSummary),
    Option.getOrUndefined(request.limit),
  ),
  diagnostics,
});

/**
 * Builds a schema-free model-facing action search result.
 *
 * @param servers Grouped server/tool metadata.
 * @param diagnostics Registry diagnostics to carry alongside search results.
 * @param request Required action-search request.
 * @returns Flat action candidates without raw schemas or declaration bundles.
 */
export const makeCodeModeSearchResult = (
  servers: ReadonlyArray<CodeModeServerMetadata>,
  diagnostics: ReadonlyArray<McpRegistryDiagnostic>,
  request: CodeModeSearchRequest,
): Effect.Effect<CodeModeSearchResult, CodeModeInvariantError> =>
  Effect.try({
    try: () => ({
      actions: limitRows(
        searchActions(servers, request),
        Option.getOrUndefined(request.limit),
      ),
      diagnostics,
    }),
    catch: normalizeInvariantError,
  });

/**
 * Looks up full schema/declaration details for selected tools.
 *
 * The lookup is all-or-nothing: any unknown server/tool key fails the whole
 * request instead of returning partial results.
 */
export const makeCodeModeToolSchemaResult = (
  servers: ReadonlyArray<CodeModeServerMetadata>,
  declarationIndex: DeclarationIndex,
  request: CodeModeToolSchemaRequest,
  diagnostics: ReadonlyArray<McpRegistryDiagnostic> = [],
): Effect.Effect<CodeModeToolSchemaResult, CodeModeInvariantError> =>
  Effect.try({
    try: () => {
      const grouped = new Map<
        string,
        {
          readonly server: CodeModeServerMetadata;
          readonly tools: Array<CodeModeToolMetadata>;
        }
      >();
      const selectedTools = normalizeToolSchemaSelectors(request);
      const tools: Array<CodeModeToolSchema> = selectedTools.map(
        (requested) => {
          const resolved = resolveCodeModeTool(servers, requested);
          const group = grouped.get(resolved.server.jsServerName);

          if (group === undefined) {
            grouped.set(resolved.server.jsServerName, {
              server: resolved.server,
              tools: [resolved.tool],
            });
          } else {
            group.tools.push(resolved.tool);
          }

          return {
            serverName: resolved.server.serverName,
            jsServerName: resolved.server.jsServerName,
            originalToolName: resolved.tool.originalToolName,
            jsToolName: resolved.tool.jsToolName,
            ...(resolved.tool.title === undefined
              ? {}
              : { title: resolved.tool.title }),
            ...(resolved.tool.description === undefined
              ? {}
              : { description: resolved.tool.description }),
            inputSchema: resolved.tool.inputSchema,
            ...(resolved.tool.outputSchema === undefined
              ? {}
              : { outputSchema: resolved.tool.outputSchema }),
            ...(resolved.tool.outputSchemaInvalid === undefined
              ? {}
              : { outputSchemaInvalid: resolved.tool.outputSchemaInvalid }),
            ...(resolved.tool.annotations === undefined
              ? {}
              : { annotations: resolved.tool.annotations }),
          };
        },
      );

      return {
        tools,
        declarationsByServer: [...grouped.values()].map((group) => ({
          serverName: group.server.serverName,
          jsServerName: group.server.jsServerName,
          declaration: renderServerDeclaration(
            group.server,
            group.tools,
            declarationIndex,
          ),
        })),
        diagnostics,
      };
    },
    catch: normalizeInvariantError,
  });

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
            catch: (cause) =>
              new CodeModeInvariantError({
                message: normalizeProviderFailure(server, tool, cause).message,
                cause,
              }),
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
  ...(tool.outputSchemaInvalid === undefined
    ? {}
    : { outputSchemaInvalid: tool.outputSchemaInvalid }),
  ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
});

const resolveCodeModeTool = (
  servers: ReadonlyArray<CodeModeServerMetadata>,
  requested: {
    readonly jsServerName: string;
    readonly jsToolName: string;
  },
): {
  readonly server: CodeModeServerMetadata;
  readonly tool: CodeModeToolMetadata;
} => {
  const server = servers.find(
    (candidate) => candidate.jsServerName === requested.jsServerName,
  );

  if (server === undefined) {
    throw new CodeModeInvariantError({
      message: `Unknown Code Mode server: ${requested.jsServerName}`,
    });
  }

  const tool = server.tools.find(
    (candidate) => candidate.jsToolName === requested.jsToolName,
  );

  if (tool === undefined) {
    throw new CodeModeInvariantError({
      message: `Unknown Code Mode tool: ${requested.jsServerName}.${requested.jsToolName}`,
    });
  }

  return { server, tool };
};

const normalizeToolSchemaSelectors = (
  request: CodeModeToolSchemaRequest,
): ReadonlyArray<{
  readonly jsServerName: string;
  readonly jsToolName: string;
}> => {
  if (!Array.isArray(request.toolIds)) {
    throw new CodeModeInvariantError({
      message: "get_tool_schema.toolIds must be an array",
    });
  }

  const selected = request.toolIds.map((toolId) => {
    const separator = toolId.indexOf(".");

    if (separator <= 0 || separator === toolId.length - 1) {
      throw new CodeModeInvariantError({
        message: `Invalid Code Mode toolId: ${toolId}`,
      });
    }

    return {
      jsServerName: toolId.slice(0, separator),
      jsToolName: toolId.slice(separator + 1),
    };
  });

  if (selected.length === 0) {
    throw new CodeModeInvariantError({
      message: "get_tool_schema requires at least one toolId",
    });
  }

  return selected;
};

const searchActions = (
  servers: ReadonlyArray<CodeModeServerMetadata>,
  request: CodeModeSearchRequest,
): ReadonlyArray<CodeModeActionCandidate> => {
  const queryTokens = tokenize(request.query);

  if (queryTokens.length === 0) {
    throw new CodeModeInvariantError({
      message: "search.query must be a non-blank string",
    });
  }

  const requestedProvider = Option.getOrUndefined(request.provider);
  const scopedServers =
    requestedProvider === undefined
      ? servers
      : [resolveProvider(servers, requestedProvider)];

  return scopedServers
    .flatMap((server) =>
      server.tools
        .map((tool, index) => ({
          candidate: toCodeModeActionCandidate(server, tool),
          score: scoreAction(server, tool, queryTokens, requestedProvider),
          order: index,
        }))
        .filter((match) => match.score > 0)
        .map((match) => ({
          ...match,
          providerOrder: servers.findIndex(
            (serverMetadata) =>
              serverMetadata.jsServerName === server.jsServerName,
          ),
        })),
    )
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.providerOrder - right.providerOrder ||
        left.order - right.order,
    )
    .map((match) => match.candidate);
};

const resolveProvider = (
  servers: ReadonlyArray<CodeModeServerMetadata>,
  provider: string,
): CodeModeServerMetadata => {
  const server = servers.find(
    (candidate) => candidate.jsServerName === provider,
  );

  if (server === undefined) {
    throw new CodeModeInvariantError({
      message: `Unknown Code Mode provider: ${provider}`,
    });
  }

  return server;
};

const rankProviders = (
  servers: ReadonlyArray<CodeModeServerMetadata>,
  tokens: ReadonlyArray<string>,
): ReadonlyArray<CodeModeServerMetadata> => {
  if (tokens.length === 0) {
    return servers;
  }

  return servers
    .map((server, index) => ({
      server,
      index,
      score: scoreProvider(server, tokens),
    }))
    .filter((match) => match.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((match) => match.server);
};

const toCodeModeProviderSummary = (
  server: CodeModeServerMetadata,
): CodeModeProviderSummary => {
  const exampleQueries = server.tools
    .slice(0, 3)
    .map((tool) => humanizeIdentifier(tool.title ?? tool.jsToolName));

  return {
    provider: server.jsServerName,
    displayName: server.serverName,
    toolCount: server.tools.length,
    exampleQueries,
  };
};

const toCodeModeActionCandidate = (
  server: CodeModeServerMetadata,
  tool: CodeModeToolMetadata,
): CodeModeActionCandidate => ({
  toolId: `${server.jsServerName}.${tool.jsToolName}`,
  provider: server.jsServerName,
  action: tool.jsToolName,
  call: `${server.jsServerName}.${tool.jsToolName}({ ... })`,
  ...(tool.title === undefined ? {} : { title: tool.title }),
  ...(tool.description === undefined ? {} : { description: tool.description }),
  inputFields: extractInputFields(tool.inputSchema),
});

const scoreProvider = (
  server: CodeModeServerMetadata,
  tokens: ReadonlyArray<string>,
): number => {
  const ownText = [
    server.jsServerName,
    server.serverName,
    ...server.tools
      .slice(0, 3)
      .map((tool) => humanizeIdentifier(tool.jsToolName)),
  ].join(" ");
  const capabilityText = server.tools
    .map((tool) =>
      [
        tool.originalToolName,
        tool.jsToolName,
        tool.title,
        tool.description,
        ...extractInputFields(tool.inputSchema),
      ]
        .filter((value): value is string => value !== undefined)
        .join(" "),
    )
    .join(" ");

  return tokens.reduce((score, token) => {
    if (containsToken(ownText, token)) {
      return score + 10;
    }

    if (containsToken(capabilityText, token)) {
      return score + 2;
    }

    return score;
  }, 0);
};

const scoreAction = (
  server: CodeModeServerMetadata,
  tool: CodeModeToolMetadata,
  tokens: ReadonlyArray<string>,
  scopedProvider: string | undefined,
): number => {
  const providerTokens = new Set([
    server.jsServerName.toLowerCase(),
    server.serverName.toLowerCase(),
  ]);
  const actionText = [
    tool.originalToolName,
    tool.jsToolName,
    tool.title,
    tool.description,
    ...extractInputFields(tool.inputSchema),
  ]
    .filter((value): value is string => value !== undefined)
    .join(" ");
  // Provider words narrow/boost the provider; remaining words must describe
  // the action. A provider-only action query is not enough intent to list
  // every action under that provider.
  const actionTokens = tokens.filter((token) => !providerTokens.has(token));

  if (actionTokens.length === 0) {
    return 0;
  }

  const matchedActionTokens = actionTokens.filter((token) =>
    containsToken(actionText, token),
  );

  if (actionTokens.length > 0 && matchedActionTokens.length === 0) {
    return 0;
  }

  const providerScore = tokens.some((token) =>
    containsToken(`${server.jsServerName} ${server.serverName}`, token),
  )
    ? 5
    : 0;
  const exactNameScore = tokens.some(
    (token) =>
      tool.jsToolName.toLowerCase() === token ||
      tool.originalToolName.toLowerCase() === token,
  )
    ? 20
    : 0;

  return providerScore + exactNameScore + matchedActionTokens.length * 10;
};

const limitRows = <T>(
  rows: ReadonlyArray<T>,
  limit: number | undefined,
): ReadonlyArray<T> => {
  if (limit === undefined) {
    return rows;
  }

  if (!Number.isInteger(limit) || limit < 1) {
    throw new CodeModeInvariantError({
      message: "search.limit must be a positive integer when provided",
    });
  }

  return rows.slice(0, limit);
};

const tokenize = (query: string | undefined): ReadonlyArray<string> =>
  query
    ?.trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length > 0) ?? [];

const containsToken = (text: string, token: string): boolean =>
  text.toLowerCase().includes(token);

const humanizeIdentifier = (identifier: string): string =>
  identifier.replaceAll("_", " ").replaceAll("-", " ");

const extractInputFields = (schema: unknown): ReadonlyArray<string> => {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    return [];
  }

  const properties = (schema as { readonly properties?: unknown }).properties;

  if (
    properties === null ||
    typeof properties !== "object" ||
    Array.isArray(properties)
  ) {
    return [];
  }

  return Object.keys(properties);
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

  if (tag === "UpstreamAuthRequired") {
    return formatUpstreamAuthRequired(server, tool, cause);
  }

  return `MCP provider call failed: ${toolKey}`;
};

const formatUpstreamAuthRequired = (
  server: CodeModeServerMetadata,
  tool: CodeModeToolMetadata,
  cause: unknown,
): string => {
  const authUrl = readStringField(cause, "authUrl");
  const authorizeUrl = readStringField(cause, "authorizeUrl");
  const url = authorizeUrl ?? authUrl;

  return [
    `UPSTREAM_AUTH_REQUIRED: ${server.serverName}.${tool.originalToolName} requires authorization before this tool can run.`,
    url === undefined
      ? "Ask the user to open the ptools auth center, authorize the server, then retry."
      : `Ask the user to open ${url}, authorize ${server.serverName}, then retry.`,
  ].join(" ");
};

const readStringField = (value: unknown, field: string): string | undefined =>
  typeof value === "object" &&
  value !== null &&
  field in value &&
  typeof value[field as keyof typeof value] === "string" &&
  (value[field as keyof typeof value] as string).trim().length > 0
    ? (value[field as keyof typeof value] as string)
    : undefined;

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
