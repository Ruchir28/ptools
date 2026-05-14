import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

export type UpstreamMcpConfig =
  | {
      readonly transport: "stdio";
      readonly command: string;
      readonly args?: ReadonlyArray<string>;
      readonly env?: Record<string, string>;
      readonly cwd?: string;
    }
  | {
      readonly transport: "http";
      readonly url: string;
      readonly headers?: Record<string, string>;
    };

export type UpstreamMcpServers = Readonly<Record<string, UpstreamMcpConfig>>;

export interface ConnectedMcpClient {
  readonly serverName: string;
  readonly jsServerName: string;
  readonly client: Client;
}

export interface DiscoveredMcpTool {
  readonly serverName: string;
  readonly originalToolName: string;
  readonly jsServerName: string;
  readonly jsToolName: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema: unknown;
  readonly outputSchema?: unknown;
  readonly annotations?: unknown;
}

export interface CallToolRequest {
  readonly jsServerName: string;
  readonly jsToolName: string;
  readonly arguments: unknown;
}
