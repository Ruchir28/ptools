import { Context, Effect } from "effect";
import type {
  InvalidToolArguments,
  McpCallError,
  NameCollisionError,
  ToolNotFound,
  UpstreamAuthRequired,
} from "./errors.js";
import type {
  CallToolRequest,
  DiscoveredMcpTool,
  McpAuthStatus,
  McpRegistryDiagnostic,
} from "./types.js";

export class McpRegistry extends Context.Tag("@ptools/McpRegistry")<
  McpRegistry,
  {
    readonly listTools: Effect.Effect<ReadonlyArray<DiscoveredMcpTool>>;
    readonly diagnostics: Effect.Effect<ReadonlyArray<McpRegistryDiagnostic>>;
    readonly authStatus: Effect.Effect<McpAuthStatus>;
    readonly refresh: Effect.Effect<void, NameCollisionError>;
    readonly callTool: (
      request: CallToolRequest,
    ) => Effect.Effect<
      unknown,
      ToolNotFound | InvalidToolArguments | McpCallError | UpstreamAuthRequired
    >;
  }
>() {}
