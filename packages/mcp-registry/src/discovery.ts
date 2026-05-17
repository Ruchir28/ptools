import type { Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import { Effect } from "effect";
import { McpDiscoveryError, NameCollisionError } from "./errors.js";
import { buildNameMap, getMappedName } from "./names.js";
import {
  safeErrorMessage,
  validateInputSchema,
  validateOutputSchema,
} from "./schema.js";
import type {
  ConnectedMcpClient,
  DiscoveredMcpTool,
  McpRegistryDiagnostic,
} from "./types.js";

export interface DiscoverAllToolsResult {
  readonly clients: ReadonlyArray<ConnectedMcpClient>;
  readonly tools: ReadonlyArray<DiscoveredMcpTool>;
  readonly diagnostics: ReadonlyArray<McpRegistryDiagnostic>;
}

export const discoverAllTools = (
  clients: ReadonlyArray<ConnectedMcpClient>,
): Effect.Effect<
  ReadonlyArray<DiscoveredMcpTool>,
  McpDiscoveryError | NameCollisionError
> =>
  Effect.gen(function* () {
    const allTools: Array<DiscoveredMcpTool> = [];

    for (const connected of clients) {
      allTools.push(...(yield* discoverClientTools(connected)));
    }

    return allTools;
  });

export const discoverAllToolsDegraded = (
  clients: ReadonlyArray<ConnectedMcpClient>,
): Effect.Effect<DiscoverAllToolsResult, NameCollisionError> =>
  Effect.gen(function* () {
    const healthyClients: Array<ConnectedMcpClient> = [];
    const allTools: Array<DiscoveredMcpTool> = [];
    const diagnostics: Array<McpRegistryDiagnostic> = [];

    for (const connected of clients) {
      const result = yield* discoverClientToolsDegraded(connected).pipe(
        Effect.either,
      );

      if (result._tag === "Left") {
        if (result.left instanceof NameCollisionError) {
          return yield* Effect.fail(result.left);
        }

        diagnostics.push(toDiscoveryDiagnostic(result.left));
        yield* closeClient(connected);
      } else if (result.right.excludeServer) {
        diagnostics.push(...result.right.diagnostics);
        yield* closeClient(connected);
      } else {
        healthyClients.push(connected);
        allTools.push(...result.right.tools);
        diagnostics.push(...result.right.diagnostics);
      }
    }

    return { clients: healthyClients, tools: allTools, diagnostics };
  });

interface DiscoverClientToolsResult {
  readonly tools: ReadonlyArray<DiscoveredMcpTool>;
  readonly diagnostics: ReadonlyArray<McpRegistryDiagnostic>;
  readonly excludeServer: boolean;
}

const discoverClientTools = (
  connected: ConnectedMcpClient,
): Effect.Effect<
  ReadonlyArray<DiscoveredMcpTool>,
  McpDiscoveryError | NameCollisionError
> =>
  Effect.gen(function* () {
    const tools = yield* listClientTools(connected);
    const toolNameMap = yield* buildNameMap(
      tools.map((tool) => tool.name),
      `tools for ${connected.serverName}`,
    );
    const discoveredTools: Array<DiscoveredMcpTool> = [];

    for (const tool of tools) {
      const jsToolName = yield* getMappedName(
        toolNameMap,
        tool.name,
        `tools for ${connected.serverName}`,
      );

      discoveredTools.push(toDiscoveredTool(connected, tool, jsToolName));
    }

    return discoveredTools;
  });

const discoverClientToolsDegraded = (
  connected: ConnectedMcpClient,
): Effect.Effect<
  DiscoverClientToolsResult,
  McpDiscoveryError | NameCollisionError
> =>
  Effect.gen(function* () {
    const tools = yield* listClientTools(connected);
    const toolNameMap = yield* buildNameMap(
      tools.map((tool) => tool.name),
      `tools for ${connected.serverName}`,
    );
    const invalidInputDiagnostics = validateInputSchemas(connected, tools);

    if (invalidInputDiagnostics.length > 0) {
      return {
        tools: [],
        diagnostics: [
          ...invalidInputDiagnostics,
          {
            code: "McpDiscoveryFailed",
            severity: "error",
            serverName: connected.serverName,
            message: "Invalid input schema in advertised tool metadata",
          },
        ],
        excludeServer: true,
      };
    }

    const diagnostics = validateOutputSchemas(connected, tools);
    const discoveredTools: Array<DiscoveredMcpTool> = [];

    for (const tool of tools) {
      const jsToolName = yield* getMappedName(
        toolNameMap,
        tool.name,
        `tools for ${connected.serverName}`,
      );
      const outputSchemaInvalid = diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "InvalidOutputSchema" &&
          diagnostic.toolName === tool.name,
      );

      discoveredTools.push(
        toDiscoveredTool(connected, tool, jsToolName, outputSchemaInvalid),
      );
    }

    return {
      tools: discoveredTools,
      diagnostics,
      excludeServer: false,
    };
  });

const listClientTools = (
  connected: ConnectedMcpClient,
): Effect.Effect<ReadonlyArray<McpTool>, McpDiscoveryError> =>
  Effect.tryPromise({
    try: async () => {
      const discovered: Array<McpTool> = [];
      let cursor: string | undefined;

      do {
        const page = await connected.client.listTools(
          cursor === undefined ? undefined : { cursor },
        );

        discovered.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor !== undefined);

      return discovered;
    },
    catch: (cause) =>
      new McpDiscoveryError({
        serverName: connected.serverName,
        cause,
      }),
  });

const toDiscoveredTool = (
  connected: ConnectedMcpClient,
  tool: McpTool,
  jsToolName: string,
  outputSchemaInvalid = false,
): DiscoveredMcpTool => ({
  serverName: connected.serverName,
  originalToolName: tool.name,
  jsServerName: connected.jsServerName,
  jsToolName,
  inputSchema: tool.inputSchema,
  ...optionalProp("title", tool.title),
  ...optionalProp("description", tool.description),
  ...optionalProp("outputSchema", tool.outputSchema),
  ...(outputSchemaInvalid ? { outputSchemaInvalid: true as const } : {}),
  ...optionalProp("annotations", tool.annotations),
});

const optionalProp = <Key extends string, Value>(
  key: Key,
  value: Value | undefined,
): {} | { readonly [Property in Key]: Value } =>
  value === undefined
    ? {}
    : ({ [key]: value } as { readonly [Property in Key]: Value });

const validateInputSchemas = (
  connected: ConnectedMcpClient,
  tools: ReadonlyArray<McpTool>,
): ReadonlyArray<McpRegistryDiagnostic> => {
  const diagnostics: Array<McpRegistryDiagnostic> = [];

  for (const tool of tools) {
    const inputError = validateInputSchema(tool.inputSchema);

    if (inputError !== undefined) {
      diagnostics.push({
        code: "InvalidInputSchema",
        severity: "error",
        serverName: connected.serverName,
        toolName: tool.name,
        message: inputError,
      });
    }
  }

  return diagnostics;
};

const validateOutputSchemas = (
  connected: ConnectedMcpClient,
  tools: ReadonlyArray<McpTool>,
): ReadonlyArray<McpRegistryDiagnostic> => {
  const diagnostics: Array<McpRegistryDiagnostic> = [];

  for (const tool of tools) {
    if (tool.outputSchema === undefined) {
      continue;
    }

    const outputError = validateOutputSchema(tool.outputSchema);

    if (outputError !== undefined) {
      diagnostics.push({
        code: "InvalidOutputSchema",
        severity: "warning",
        serverName: connected.serverName,
        toolName: tool.name,
        message: outputError,
      });
    }
  }

  return diagnostics;
};

const toDiscoveryDiagnostic = (
  error: McpDiscoveryError,
): McpRegistryDiagnostic => ({
  code: "McpDiscoveryFailed",
  severity: "error",
  serverName: error.serverName,
  message: safeErrorMessage(error.cause),
});

const closeClient = (connected: ConnectedMcpClient): Effect.Effect<void> =>
  Effect.tryPromise({
    try: () => connected.client.close(),
    catch: () => undefined,
  }).pipe(Effect.ignore);
