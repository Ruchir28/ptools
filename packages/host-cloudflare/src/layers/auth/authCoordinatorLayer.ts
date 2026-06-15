import { AuthCoordinator, AuthCoordinatorCore } from "@ptools/auth";
import { Effect, Layer } from "effect";

/**
 * AuthCoordinator facade consumed by shared MCP registry/connector code.
 *
 * It intentionally owns no separate state; all behavior delegates to
 * AuthCoordinatorCore.
 *
 * Requires:
 * - AuthCoordinatorCore
 *
 * Provides:
 * - AuthCoordinator
 */
export const AuthCoordinatorLayer: Layer.Layer<
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
