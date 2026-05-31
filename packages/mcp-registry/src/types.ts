import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
export type {
  McpAuthServerStatus,
  McpAuthStatus,
  McpAuthStatusValue,
  UpstreamHttpAuthConfig,
  UpstreamMcpConfig,
  UpstreamMcpServers,
} from "@ptools/auth";

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
  readonly outputSchemaInvalid?: true;
  readonly annotations?: unknown;
}

export interface CallToolRequest {
  readonly jsServerName: string;
  readonly jsToolName: string;
  readonly arguments: unknown;
}

export type McpRegistryDiagnostic =
  | {
      readonly code: "McpConnectionFailed";
      readonly severity: "error";
      readonly serverName: string;
      readonly message: string;
    }
  | {
      readonly code: "UpstreamAuthRequired";
      readonly severity: "warning";
      readonly serverName: string;
      readonly message: string;
      readonly authUrl: string;
      readonly authorizeUrl?: string;
    }
  | {
      readonly code: "UpstreamAuthNeedsConfig";
      readonly severity: "warning";
      readonly serverName: string;
      readonly message: string;
      readonly authUrl: string;
      readonly setupUrl?: string;
    }
  | {
      readonly code: "McpDiscoveryFailed";
      readonly severity: "error";
      readonly serverName: string;
      readonly message: string;
    }
  | {
      readonly code: "InvalidInputSchema";
      readonly severity: "error";
      readonly serverName: string;
      readonly toolName: string;
      readonly message: string;
    }
  | {
      readonly code: "InvalidOutputSchema";
      readonly severity: "warning";
      readonly serverName: string;
      readonly toolName: string;
      readonly message: string;
    };
