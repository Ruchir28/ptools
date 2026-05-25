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
      readonly auth?: UpstreamHttpAuthConfig;
    };

export interface UpstreamHttpAuthConfig {
  readonly type: "oauth";
  readonly scope?: string;
  readonly resourceMetadataUrl?: string;
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly clientMetadataUrl?: string;
  readonly redirectUri?: string;
}

export type UpstreamMcpServers = Readonly<Record<string, UpstreamMcpConfig>>;

export interface ConnectedMcpClient {
  readonly serverName: string;
  readonly jsServerName: string;
  readonly client: Client;
}

export type McpAuthStatusValue =
  | "connected"
  | "requires_auth"
  | "auth_in_progress"
  | "auth_failed"
  | "needs_config"
  | "static_credentials"
  | "unsupported_auth"
  | "disabled";

export interface McpAuthServerStatus {
  readonly serverName: string;
  readonly jsServerName: string;
  readonly transport: UpstreamMcpConfig["transport"];
  readonly status: McpAuthStatusValue;
  readonly authUrl?: string;
  readonly authorizeUrl?: string;
  readonly setupUrl?: string;
  readonly message?: string;
  readonly lastError?: string;
}

export interface McpAuthStatus {
  readonly authUrl: string;
  readonly servers: ReadonlyArray<McpAuthServerStatus>;
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
