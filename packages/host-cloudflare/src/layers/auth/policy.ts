import { AuthCoordinatorPolicy } from "@ptools/auth";
import { Effect, Layer } from "effect";
import {
  CodeModeObjectIdentity,
  CodeModeObjectRequestOrigin,
} from "../platform.js";

/**
 * Cloudflare-specific projection policy for shared HTTP auth status.
 *
 * This layer is pure URL/message construction. It owns no runtime auth state
 * and performs no Durable Object storage operations.
 *
 * Requires:
 * - CodeModeObjectIdentity
 * - CodeModeObjectRequestOrigin
 *
 * Provides:
 * - AuthCoordinatorPolicy
 */
export const CloudflareAuthPolicyLayer: Layer.Layer<
  AuthCoordinatorPolicy,
  never,
  CodeModeObjectIdentity | CodeModeObjectRequestOrigin
> = Layer.effect(
  AuthCoordinatorPolicy,
  Effect.gen(function* () {
    const identity = yield* CodeModeObjectIdentity;
    const requestOrigin = yield* CodeModeObjectRequestOrigin;
    const authUrl = `${requestOrigin.origin}/hosts/${encodeURIComponent(identity.hostId)}/auth`;

    return AuthCoordinatorPolicy.of({
      origin: requestOrigin.origin,
      authUrl,
      callbackUrl: (serverName) =>
        `${requestOrigin.origin}/hosts/${encodeURIComponent(identity.hostId)}/oauth/callback/${encodeURIComponent(serverName)}`,
      setupUrl: (serverName) =>
        `${authUrl}/${encodeURIComponent(serverName)}/setup`,
      authorizeUrl: (serverName) =>
        `${authUrl}/${encodeURIComponent(serverName)}`,
      reauthorizeUrl: (serverName) =>
        `${authUrl}/${encodeURIComponent(serverName)}?force=1`,
      authRequiredMessage: (serverName) =>
        `Authorize ${serverName} from the Cloudflare ptools auth route.`,
      dynamicClientRegistrationUnsupportedMessage: (serverName) =>
        `${serverName} does not support dynamic OAuth client registration. ` +
        `Add auth.clientId, and auth.clientSecret if required, or use another auth method for this server.`,
    });
  }),
);
