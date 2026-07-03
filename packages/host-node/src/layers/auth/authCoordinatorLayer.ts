import {
  AuthCoordinator,
  AuthCoordinatorCore,
  AuthCoordinatorCoreLayer,
  AuthError,
  CredentialsStore,
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
 * and URL policy feed the shared AuthCoordinatorCoreLayer; a thin facade exposes
 * AuthCoordinator; and NodeOAuthFlowLayer exposes browser-facing OAuth methods
 * for Host API operations.
 */
export const NodeAuthCoordinatorLive = (): Layer.Layer<
  AuthCoordinator | NodeMcpAuthFlow,
  AuthError,
  CredentialsStore | NodeHostIdentity | NodeHostSettings
> =>
  Layer.unwrapEffect(
    Effect.gen(function* () {
      const identity = yield* NodeHostIdentity;
      const coreLayer = AuthCoordinatorCoreLayer.pipe(
        Layer.provide(
          Layer.mergeAll(NodeAuthProviderFactoryLayer, NodeAuthPolicyLayer),
        ),
      );

      return Layer.merge(
        NodeAuthCoordinatorFacadeLayer,
        NodeOAuthFlowLayer,
      ).pipe(
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

const NodeAuthCoordinatorFacadeLayer: Layer.Layer<
  AuthCoordinator,
  never,
  AuthCoordinatorCore
> = Layer.effect(
  AuthCoordinator,
  Effect.gen(function* () {
    const core = yield* AuthCoordinatorCore;

    return AuthCoordinator.of({
      origin: core.origin,
      callbackUrl: core.callbackUrl,
      noteConfigured: core.noteConfigured,
      noteConnected: core.noteConnected,
      noteConnectionError: core.noteConnectionError,
      shouldAttachAuthProvider: core.shouldAttachAuthProvider,
      hasStoredCredentials: core.hasStoredCredentials,
      providerFor: core.providerFor,
      status: core.status,
      setAuthorizedHandler: core.setAuthorizedHandler,
      setRefreshHandler: core.setRefreshHandler,
    });
  }),
);
