import { Effect, Layer } from "effect";
import { closeClients, connectConfiguredMcpClients } from "./connect.js";
import { discoverAllTools } from "./discovery.js";
import { dispatchToolCall } from "./dispatch.js";
import { McpRegistry } from "./registry.js";
import type { UpstreamMcpServers } from "./types.js";

export const makeMcpRegistryLive = (upstreams: UpstreamMcpServers) =>
  Layer.scoped(
    McpRegistry,
    Effect.gen(function* () {
      const clients = yield* connectConfiguredMcpClients(upstreams);

      yield* Effect.addFinalizer(() => closeClients(clients));

      const tools = yield* discoverAllTools(clients);

      return {
        listTools: Effect.succeed(tools),
        callTool: (request) => dispatchToolCall(clients, tools, request),
      };
    }),
  );
