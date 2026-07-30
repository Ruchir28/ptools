import { AuthCoordinator } from "@ptools/auth";
import { Context, Effect, Layer, Scope } from "effect";
import { McpConnectionError } from "./errors.js";
import type { ConnectedMcpClient, UpstreamMcpConfig } from "./types.js";

export interface ConnectMcpInput {
  readonly serverName: string;
  readonly jsServerName: string;
  readonly config: UpstreamMcpConfig;
}

/** Platform-selected connector; HTTP connections consume configured auth state. */
export class McpConnector extends Context.Service<
  McpConnector,
  {
    readonly connect: (
      input: ConnectMcpInput,
    ) => Effect.Effect<
      ConnectedMcpClient,
      McpConnectionError,
      Scope.Scope | AuthCoordinator
    >;
  }
>()("@ptools/McpConnector") {}

/** Platform stdio transport primitive. It does not require auth services. */
export class StdioMcpConnector extends Context.Service<
  StdioMcpConnector,
  {
    readonly connect: (
      input: ConnectMcpInput,
    ) => Effect.Effect<ConnectedMcpClient, McpConnectionError, Scope.Scope>;
  }
>()("@ptools/StdioMcpConnector") {}

/** Platform HTTP transport primitive that receives configured auth at call time. */
export class HttpMcpConnector extends Context.Service<
  HttpMcpConnector,
  {
    readonly connect: (
      input: ConnectMcpInput,
    ) => Effect.Effect<
      ConnectedMcpClient,
      McpConnectionError,
      Scope.Scope | AuthCoordinator
    >;
  }
>()("@ptools/HttpMcpConnector") {}

export const BaseMcpConnectorLive: Layer.Layer<
  McpConnector,
  never,
  StdioMcpConnector | HttpMcpConnector
> = Layer.effect(
  McpConnector,
  Effect.gen(function* () {
    const stdio = yield* StdioMcpConnector;
    const http = yield* HttpMcpConnector;

    return {
      connect: (input: ConnectMcpInput) => {
        switch (input.config.transport) {
          case "stdio":
            return stdio.connect(input);
          case "http":
            return http.connect(input);
        }
      },
    };
  }),
);
