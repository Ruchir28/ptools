import { AuthCoordinatorPolicy } from "@ptools/auth";
import { Effect, Layer } from "effect";
import { NodeHostIdentity, NodeHostSettings } from "../platform/index.js";

export interface NodeAuthRouteOptions {
  readonly origin: string;
  readonly hostId: string;
}

export const authStatusUrl = (options: NodeAuthRouteOptions): string =>
  `${options.origin}/hosts/${encodeURIComponent(options.hostId)}/auth/status`;

export const setupUrl = (
  options: NodeAuthRouteOptions & { readonly serverName: string },
): string =>
  `${options.origin}/hosts/${encodeURIComponent(options.hostId)}/auth/${encodeURIComponent(options.serverName)}`;

export const oauthCallbackUrl = (
  options: NodeAuthRouteOptions & { readonly serverName: string },
): string =>
  `${options.origin}/hosts/${encodeURIComponent(options.hostId)}/oauth/callback/${encodeURIComponent(options.serverName)}`;

/** Host-specific auth URL projection for Node's shared Host API routes. */
export const NodeAuthPolicyLayer: Layer.Layer<
  AuthCoordinatorPolicy,
  never,
  NodeHostIdentity | NodeHostSettings
> = Layer.effect(
  AuthCoordinatorPolicy,
  Effect.gen(function* () {
    const identity = yield* NodeHostIdentity;
    const settings = yield* NodeHostSettings;
    const options = {
      origin: settings.publicOrigin,
      hostId: identity.hostId,
    };

    return AuthCoordinatorPolicy.of({
      origin: options.origin,
      authUrl: authStatusUrl(options),
      callbackUrl: (serverName) => oauthCallbackUrl({ ...options, serverName }),
      setupUrl: (serverName) => setupUrl({ ...options, serverName }),
      authorizeUrl: (serverName) => setupUrl({ ...options, serverName }),
      reauthorizeUrl: (serverName) =>
        `${setupUrl({ ...options, serverName })}?force=1`,
      authRequiredMessage: (serverName) =>
        `Authorize ${serverName} through the ptools Host API auth route.`,
      dynamicClientRegistrationUnsupportedMessage: (serverName) =>
        `${serverName} does not support dynamic OAuth client registration. ` +
        `Add auth.clientId, and auth.clientSecret if required, or use another auth method for this server.`,
    });
  }),
);
