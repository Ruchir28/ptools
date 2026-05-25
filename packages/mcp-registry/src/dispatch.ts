import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Effect } from "effect";
import {
  InvalidToolArguments,
  McpCallError,
  ToolNotFound,
  UpstreamAuthRequired,
} from "./errors.js";
import type {
  CallToolRequest,
  ConnectedMcpClient,
  DiscoveredMcpTool,
  McpAuthStatus,
} from "./types.js";

export const dispatchToolCall = (
  clients: ReadonlyArray<ConnectedMcpClient>,
  tools: ReadonlyArray<DiscoveredMcpTool>,
  request: CallToolRequest,
  authStatus?: McpAuthStatus,
): Effect.Effect<
  unknown,
  ToolNotFound | InvalidToolArguments | McpCallError | UpstreamAuthRequired
> =>
  Effect.gen(function* () {
    const tool = tools.find(
      (candidate) =>
        candidate.jsServerName === request.jsServerName &&
        candidate.jsToolName === request.jsToolName,
    );

    if (tool === undefined) {
      return yield* Effect.fail(
        new ToolNotFound({
          serverName: request.jsServerName,
          toolName: request.jsToolName,
        }),
      );
    }

    const toolArguments = request.arguments;

    if (!isRecord(toolArguments)) {
      return yield* Effect.fail(
        new InvalidToolArguments({
          serverName: tool.serverName,
          toolName: tool.originalToolName,
          value: toolArguments,
        }),
      );
    }

    const connected = clients.find(
      (client) => client.jsServerName === tool.jsServerName,
    );

    if (connected === undefined) {
      return yield* Effect.fail(
        new ToolNotFound({
          serverName: tool.serverName,
          toolName: tool.originalToolName,
        }),
      );
    }

    return yield* Effect.tryPromise({
      try: () =>
        connected.client.callTool({
          name: tool.originalToolName,
          arguments: toolArguments,
        }),
      catch: (cause) => {
        if (cause instanceof UnauthorizedError) {
          const serverAuth = authStatus?.servers.find(
            (server) => server.serverName === tool.serverName,
          );

          return new UpstreamAuthRequired({
            serverName: tool.serverName,
            toolName: tool.originalToolName,
            ...(authStatus?.authUrl === undefined
              ? {}
              : { authUrl: authStatus.authUrl }),
            ...(serverAuth?.authorizeUrl === undefined
              ? {}
              : { authorizeUrl: serverAuth.authorizeUrl }),
          });
        }

        return new McpCallError({
          serverName: tool.serverName,
          toolName: tool.originalToolName,
          cause,
        });
      },
    });
  });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
