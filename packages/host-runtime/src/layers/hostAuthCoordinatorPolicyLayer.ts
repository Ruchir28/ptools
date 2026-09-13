/**
 * @file Shared Host API URL/message policy for MCP auth.
 *
 * OAuth mechanics belong to `@ptools/auth`. This file owns the host-facing
 * `/hosts/:hostId/...` URL convention that combines stable `HostIdentity` with
 * configured-context `HostPublicOrigin`.
 *
 * Keeping the policy here prevents `@ptools/auth` from depending on Host API
 * route shape and prevents Cloudflare/Node from duplicating the same URLs.
 */
import { AuthCoordinatorPolicy } from "@ptools/auth";
import { HostIdentity, HostPublicOrigin } from "@ptools/host-context";
import { Effect, Layer } from "effect";

/**
 * Shared Host API auth URL and message policy for one configured Context.
 *
 * Provides: `AuthCoordinatorPolicy` (OAuth callback URLs, human-facing Auth
 * Center navigation URLs, and user-facing auth messages). Status
 * `authorizeUrl`/`reauthorizeUrl`/`setupUrl` values all remain safe GET links;
 * the browser page they open requires a separate POST before provider work.
 *
 * Requires:
 * - stable host binding: `HostIdentity` (host ID is fixed for the runtime)
 * - this Context's binding: `HostPublicOrigin` (origin can change per request)
 *
 * Built with each configured host Context because public origin can change
 * between requests. This is host-runtime policy, not OAuth storage or provider
 * behavior — those stay in `@ptools/auth`.
 */
export const HostAuthCoordinatorPolicyLayer: Layer.Layer<
  AuthCoordinatorPolicy,
  never,
  HostIdentity | HostPublicOrigin
> = Layer.effect(
  AuthCoordinatorPolicy,
  Effect.gen(function* () {
    const identity = yield* HostIdentity;
    const publicOrigin = yield* HostPublicOrigin;
    const encodedHostId = encodeURIComponent(identity.hostId);
    const authUrl = `${publicOrigin.origin}/hosts/${encodedHostId}/auth`;

    const authCenterSelectionUrl = (
      serverName: string,
      intent: "authorize" | "reauthorize" | "setup",
    ) => `${authUrl}?server=${encodeURIComponent(serverName)}&intent=${intent}`;

    return AuthCoordinatorPolicy.of({
      origin: publicOrigin.origin,
      authUrl,
      callbackUrl: (serverName) =>
        `${publicOrigin.origin}/hosts/${encodedHostId}/oauth/callback/${encodeURIComponent(serverName)}`,
      setupUrl: (serverName) => authCenterSelectionUrl(serverName, "setup"),
      authorizeUrl: (serverName) =>
        authCenterSelectionUrl(serverName, "authorize"),
      reauthorizeUrl: (serverName) =>
        authCenterSelectionUrl(serverName, "reauthorize"),
      authRequiredMessage: (serverName) =>
        `Authorize ${serverName} from the ptools host auth route.`,
      dynamicClientRegistrationUnsupportedMessage: (serverName) =>
        `${serverName} does not support dynamic OAuth client registration. ` +
        `Add auth.clientId, and auth.clientSecret if required, or use another auth method for this server.`,
    });
  }),
);
