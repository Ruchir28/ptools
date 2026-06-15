import { AuthError, CredentialError } from "@ptools/auth";
import { Context, Effect } from "effect";

/**
 * Cloudflare-only OAuth route service.
 *
 * This is intentionally separate from the shared AuthCoordinator service. Worker
 * routes use this service to start or finish browser authorization, while MCP
 * registry/connector code consumes AuthCoordinator.
 */
export class CloudflareOAuthFlow extends Context.Tag(
  "@ptools/host-cloudflare/CloudflareOAuthFlow",
)<
  CloudflareOAuthFlow,
  {
    readonly beginAuthorization: (input: {
      readonly serverName: string;
      readonly force: boolean;
    }) => Effect.Effect<string, AuthError | CredentialError>;
    readonly finishAuthorization: (input: {
      readonly serverName: string;
      readonly code: string;
    }) => Effect.Effect<void, AuthError | CredentialError>;
  }
>() {}
