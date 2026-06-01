import { Context, Effect, Layer, Scope } from "effect";
import { McpConnectionError } from "./errors.js";
import type { ConnectedMcpClient, UpstreamMcpConfig } from "./types.js";

export interface ConnectMcpInput {
  readonly serverName: string;
  readonly jsServerName: string;
  readonly config: UpstreamMcpConfig;
}

export class McpConnector extends Context.Tag("@ptools/McpConnector")<
  McpConnector,
  {
    readonly connect: (
      input: ConnectMcpInput,
    ) => Effect.Effect<ConnectedMcpClient, McpConnectionError, Scope.Scope>;
  }
>() {}

export class StdioMcpConnector extends Context.Tag("@ptools/StdioMcpConnector")<
  StdioMcpConnector,
  {
    readonly connect: (
      input: ConnectMcpInput,
    ) => Effect.Effect<ConnectedMcpClient, McpConnectionError, Scope.Scope>;
  }
>() {}

export class HttpMcpConnector extends Context.Tag("@ptools/HttpMcpConnector")<
  HttpMcpConnector,
  {
    readonly connect: (
      input: ConnectMcpInput,
    ) => Effect.Effect<ConnectedMcpClient, McpConnectionError, Scope.Scope>;
  }
>() {}

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
