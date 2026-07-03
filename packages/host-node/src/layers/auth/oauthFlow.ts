import { AuthError } from "@ptools/auth";
import type {
  CompleteHostMcpOAuthCallbackInput,
  HostMcpOAuthCallbackBrowserResponse,
} from "@ptools/host-api";
import { Context, Effect } from "effect";

/**
 * Node-owned MCP OAuth operations used by shared Host API routes.
 *
 * The shared AuthCoordinator models host-neutral MCP auth state. This service
 * owns Node's browser-facing OAuth behavior: opening provider authorization
 * URLs and rendering callback completion HTML after Host HttpApi routes decode
 * the callback carrier.
 */
export class NodeMcpAuthFlow extends Context.Tag("@ptools/NodeMcpAuthFlow")<
  NodeMcpAuthFlow,
  {
    readonly beginAuthorization: (input: {
      readonly serverName: string;
      readonly force: boolean;
    }) => Effect.Effect<{ readonly authorizeUrl: string }, AuthError>;
    readonly completeCallback: (
      input: CompleteHostMcpOAuthCallbackInput,
    ) => Effect.Effect<HostMcpOAuthCallbackBrowserResponse, AuthError>;
  }
>() {}
