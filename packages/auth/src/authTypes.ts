import type {
  ResolvedHttpMcpAuthConfig,
  ResolvedHttpMcpConfig,
  ResolvedMcpConfig,
  ResolvedMcpServers,
} from "@ptools/config";

export type UpstreamHttpAuthConfig = ResolvedHttpMcpAuthConfig;
export type UpstreamMcpConfig = ResolvedMcpConfig;
export type UpstreamMcpServers = ResolvedMcpServers;
export type HttpMcpConfig = ResolvedHttpMcpConfig;

export interface OAuthStatePayload {
  readonly runtimeId: string;
  readonly serverName: string;
  readonly jsServerName: string;
  readonly nonce: string;
  readonly redirectAfterAuth?: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}
