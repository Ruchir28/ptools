import {
  AuthCoordinator,
  AuthCoordinatorCore,
  AuthError,
  McpOAuthCredentialStore,
} from "@ptools/auth";
import { Effect, Layer } from "effect";
import { NodeMcpAuthFlow } from "./oauthFlow.js";
import { NodeOAuthFlowLayer } from "./oauthFlowLayer.js";
import { NodeAuthPolicyLayer } from "./policy.js";
import { NodeAuthProviderFactoryLayer } from "./providerFactory.js";
import { NodeHostIdentity, NodeHostSettings } from "../platform/index.js";

/**
 * Node MCP auth composition layer.
 *
 * This is the Node analogue of Cloudflare's auth layer graph: provider factory
 * and URL policy feed AuthCoordinatorCore.Default; AuthCoordinator.Default
 * exposes the shared facade; and NodeOAuthFlowLayer exposes browser-facing
 * OAuth methods for Host API operations.
 */
export const NodeAuthCoordinatorLive = (): Layer.Layer<
  AuthCoordinator | NodeMcpAuthFlow,
  AuthError,
  McpOAuthCredentialStore | NodeHostIdentity | NodeHostSettings
> =>
  Layer.unwrapEffect(
    Effect.gen(function* () {
      const identity = yield* NodeHostIdentity;
      const coreLayer = AuthCoordinatorCore.Default.pipe(
        Layer.provide(
          Layer.mergeAll(NodeAuthProviderFactoryLayer, NodeAuthPolicyLayer),
        ),
      );

      return Layer.merge(AuthCoordinator.Default, NodeOAuthFlowLayer).pipe(
        Layer.provide(coreLayer),
        Layer.mapError(
          (cause) =>
            new AuthError({
              message: `Failed to start ptools auth coordinator for ${identity.hostId}.`,
              cause,
            }),
        ),
      );
    }),
  );
