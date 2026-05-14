import { Effect } from "effect";
import {
  McpDiscoveryError,
  NameCollisionError,
} from "./errors.js";
import { buildNameMap, getMappedName } from "./names.js";
import type { Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import type {
  ConnectedMcpClient,
  DiscoveredMcpTool,
} from "./types.js";

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

const discoverClientTools = (
  connected: ConnectedMcpClient,
): Effect.Effect<
  ReadonlyArray<DiscoveredMcpTool>,
  McpDiscoveryError | NameCollisionError
> =>
  Effect.gen(function* () {
    const tools = yield* Effect.tryPromise({
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

const toDiscoveredTool = (
  connected: ConnectedMcpClient,
  tool: McpTool,
  jsToolName: string,
): DiscoveredMcpTool => ({
  serverName: connected.serverName,
  originalToolName: tool.name,
  jsServerName: connected.jsServerName,
  jsToolName,
  inputSchema: tool.inputSchema,
  ...optionalProp("title", tool.title),
  ...optionalProp("description", tool.description),
  ...optionalProp("outputSchema", tool.outputSchema),
  ...optionalProp("annotations", tool.annotations),
});

const optionalProp = <Key extends string, Value>(
  key: Key,
  value: Value | undefined,
): {} | { readonly [Property in Key]: Value } =>
  value === undefined
    ? {}
    : ({ [key]: value } as { readonly [Property in Key]: Value });
