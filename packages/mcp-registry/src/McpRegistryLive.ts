import { Effect, Layer } from "effect";
import { closeClients, connectConfiguredMcpClientsDegraded } from "./connect.js";
import { discoverAllToolsDegraded } from "./discovery.js";
import { dispatchToolCall } from "./dispatch.js";
import { McpRegistry } from "./registry.js";
import type { UpstreamMcpServers } from "./types.js";

export const makeMcpRegistryLive = (upstreams: UpstreamMcpServers) =>
  Layer.scoped(
    McpRegistry,
    Effect.gen(function* () {
      const connected = yield* connectConfiguredMcpClientsDegraded(upstreams);

      yield* Effect.addFinalizer(() => closeClients(connected.clients));

      const discovered = yield* discoverAllToolsDegraded(connected.clients);

      return {
        listTools: Effect.succeed(discovered.tools),
        diagnostics: Effect.succeed([
          ...connected.diagnostics,
          ...discovered.diagnostics,
        ]),
        callTool: (request) =>
          dispatchToolCall(discovered.clients, discovered.tools, request),
      };
    }),
  );
