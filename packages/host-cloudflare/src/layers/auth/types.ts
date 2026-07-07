import type {
  McpOAuthCredentialStoreService,
  McpOAuthStateStoreService,
} from "@ptools/auth";

export interface CloudflareOAuthPlatform {
  readonly oauthCredentials: McpOAuthCredentialStoreService;
  readonly oauthStateStore: McpOAuthStateStoreService;
  readonly hostId: string;
  readonly origin: string;
}
