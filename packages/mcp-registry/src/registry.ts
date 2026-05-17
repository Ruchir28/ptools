import { Context, Effect } from "effect";
import type {
  InvalidToolArguments,
  McpCallError,
  ToolNotFound,
} from "./errors.js";
import type {
  CallToolRequest,
  DiscoveredMcpTool,
  McpRegistryDiagnostic,
} from "./types.js";

export class McpRegistry extends Context.Tag("@ptools/McpRegistry")<
  McpRegistry,
  {
    readonly listTools: Effect.Effect<ReadonlyArray<DiscoveredMcpTool>>;
    readonly diagnostics: Effect.Effect<ReadonlyArray<McpRegistryDiagnostic>>;
    readonly callTool: (
      request: CallToolRequest,
    ) => Effect.Effect<
      unknown,
      ToolNotFound | InvalidToolArguments | McpCallError
    >;
  }
>() {}
