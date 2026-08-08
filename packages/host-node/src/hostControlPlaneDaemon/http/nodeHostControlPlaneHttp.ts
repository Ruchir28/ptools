/**
 * @file Final shared Host HTTP assembly for the foreground Node process.
 *
 * This file supplies Node implementations for shared Host API authentication,
 * trusted ingress origin, actor-daemon discovery, and the fixed loopback server.
 * It exposes no Node process-lifecycle protocol: clients neither probe nor
 * control the foreground command through HTTP.
 */
import { createServer } from "node:http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import {
  CredentialedHostApiHandlers,
  HostHttpApi,
  OAuthBrowserHandlers,
} from "@ptools/host-api/http";
import {
  HostApiUnauthorized,
  HostHttpIngress,
  HostHttpOperationAdapterLive,
  ProvideHostHttpIngress,
  RequireHostApiAccess,
  VerifiedHostApiCaller,
} from "@ptools/host-api/effect";
import { Effect, Layer, Redacted } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { DEFAULT_NODE_HOST_KEYRING_SERVICE_NAME } from "../../hostActorDaemon/daemonProcess/nodeHostActorStateNamespace.js";
import type { NodeLocalDeploymentDescriptor } from "../../localDeployments/contracts/nodeLocalDeploymentDescriptor.js";
import { nodeControlPlanePublicOrigin } from "../../localDeployments/contracts/nodeLocalDeploymentDescriptor.js";
import { NodeDaemonHostInstanceDiscoveryLive } from "../../nodeDaemonHostInstanceDiscovery.js";
import { HostNodeError, NODE_INTERNAL_ACCESS_TOKEN } from "../../options.js";

/** Stable deployment settings established before the foreground listener binds. */
export interface NodeHostControlPlaneHttpOptions {
  readonly descriptor: NodeLocalDeploymentDescriptor;
}

/**
 * Builds one scoped listener and one private actor-daemon connection/lease.
 * The foreground command's outer scope is the only owner of this layer.
 *
 * Assembly order (bottom capabilities first, listener last):
 *
 * 1. auth + actor-daemon discovery services
 * 2. shared HTTP operation adapter (needs those services)
 * 3. route handler groups (need adapter + ingress middleware)
 * 4. full HostHttpApi mount
 * 5. loopback Node HTTP server that serves the API
 *
 * The same lower layers appear more than once because different Effect HTTP
 * pieces require them at different boundaries (adapter construction, handler
 * wiring, API middleware, and serve). That is one dependency graph attached at
 * each consumer, not multiple independent discoveries/auth stacks.
 */
export const NodeHostControlPlaneHttpLive = (
  options: NodeHostControlPlaneHttpOptions,
): Layer.Layer<never, HostNodeError, never> => {
  // Host-owned public base URL from the bound control-plane port. Handlers use
  // this for auth links / OAuth redirect_uri; clients do not get to assert it.
  const publicOrigin = nodeControlPlanePublicOrigin(
    options.descriptor.controlPlanePort,
  );

  // How this control plane finds/leases the Node actor daemon that owns real
  // host-instance work.
  const discoveryLayer = NodeDaemonHostInstanceDiscoveryLive({
    internalStateDirectory: options.descriptor.stateDirectory,
    keyringServiceName: DEFAULT_NODE_HOST_KEYRING_SERVICE_NAME,
    ...(options.descriptor.denoExecutableOverride._tag === "Some"
      ? { denoExecutable: options.descriptor.denoExecutableOverride.value }
      : {}),
  }).pipe(mapLayerHostNodeError);

  // Independent platform services placed side-by-side in one env:
  // bearer-auth middleware impl + actor-daemon discovery.
  const nodeHostApiServicesLayer = Layer.mergeAll(
    NodeRequireHostApiAccessLive,
    discoveryLayer,
  );

  // Shared adapter turns authenticated HTTP operations into host-instance
  // dispatch. provideMerge both satisfies its requirements and keeps auth +
  // discovery available in the resulting layer output.
  const hostOperationAdapterLayer = HostHttpOperationAdapterLive.pipe(
    Layer.provideMerge(nodeHostApiServicesLayer),
  );

  // Concrete endpoint implementations for the two HostHttpApi groups:
  // credentialed JSON routes + browser OAuth callbacks. Handlers only call
  // HostHttpOperationAdapter; Layer.provide injects that adapter and the
  // request-scoped ingress middleware underneath them.
  const sharedHostApiHandlersLayer = Layer.mergeAll(
    CredentialedHostApiHandlers,
    OAuthBrowserHandlers,
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        hostOperationAdapterLayer,
        provideIngress(publicOrigin),
      ),
    ),
  );

  // Bind handler groups into the shared API declaration and satisfy API-level
  // middleware requirements (auth still needed at the HttpApi boundary).
  const sharedHostApiLayer = HttpApiBuilder.layer(HostHttpApi).pipe(
    Layer.provideMerge(
      Layer.mergeAll(sharedHostApiHandlersLayer, nodeHostApiServicesLayer),
    ),
    Layer.provide(NodeHttpServer.layerHttpServices),
  );

  // Serve the API on the fixed loopback listener. provideMerge keeps the live
  // server resource in the composed layer so the outer command scope owns
  // acquire/release. Final type exposes no service tags outward.
  return HttpRouter.serve(sharedHostApiLayer).pipe(
    Layer.provide(hostOperationAdapterLayer),
    Layer.provideMerge(
      NodeHttpServer.layer(() => createServer(), {
        host: "127.0.0.1",
        port: options.descriptor.controlPlanePort,
      }),
    ),
    mapLayerHostNodeError,
  );
};

/**
 * Node live layer for the shared RequireHostApiAccess middleware contract.
 *
 * Layer.succeed installs a finished implementation into the env map:
 *   RequireHostApiAccess -> { bearer: (effect, { credential }) => ... }
 *
 * That object is the service value. Effect HTTP later calls `bearer` per
 * credentialed request with:
 * - effect: the rest of the request pipeline (inner middleware + handler)
 * - credential: the presented bearer token
 *
 * On success we do not return caller data directly; we re-run `effect` with
 * VerifiedHostApiCaller provided into its environment so downstream handlers
 * can `yield* VerifiedHostApiCaller`. On failure the request fails 401.
 * Temporary pre-identity token check only; never used for process control.
 */
const NodeRequireHostApiAccessLive: Layer.Layer<RequireHostApiAccess> =
  Layer.succeed(
    RequireHostApiAccess,
    RequireHostApiAccess.of({
      bearer: (effect, { credential }) =>
        Redacted.value(credential) === NODE_INTERNAL_ACCESS_TOKEN
          ? Effect.provideService(effect, VerifiedHostApiCaller, {
              caller: { kind: "HostApiTokenCaller" as const },
            })
          : Effect.fail(new HostApiUnauthorized({ message: "Unauthorized" })),
    }),
  );

/**
 * Node live layer for the shared ProvideHostHttpIngress middleware contract.
 *
 * Two different services are involved:
 * - ProvideHostHttpIngress: middleware hook installed once in the layer graph
 * - HostHttpIngress: per-request data (`{ publicOrigin }`) handlers actually read
 *
 * Layer.succeed(Tag, value) means "if asked for Tag, return this value." Here
 * the value is itself a function `(effect) => wrappedEffect`. That function is
 * the ProvideHostHttpIngress service value; it is not called at layer-build
 * time. Effect HTTP retrieves it later and calls it around each request with
 * "the rest of the request" as `effect`.
 *
 * The function body then uses Effect.provideService to run that request with
 * HostHttpIngress available. Origin is closed over from control-plane config
 * (trusted host-owned fact), not derived from client-controlled headers.
 */
const provideIngress = (
  publicOrigin: string,
): Layer.Layer<ProvideHostHttpIngress> =>
  Layer.succeed(ProvideHostHttpIngress, (effect) =>
    Effect.provideService(
      effect,
      HostHttpIngress,
      HostHttpIngress.of({ publicOrigin }),
    ),
  );

const toHostNodeError = (cause: unknown): HostNodeError =>
  cause instanceof HostNodeError
    ? cause
    : new HostNodeError({
        message:
          typeof cause === "object" &&
          cause !== null &&
          "message" in cause &&
          typeof cause.message === "string" &&
          cause.message.trim() !== ""
            ? cause.message
            : "Failed to construct the Node Host HTTP services (the configured listener address may already be in use).",
        cause,
      });

const mapLayerHostNodeError = <A, E, R>(
  layer: Layer.Layer<A, E, R>,
): Layer.Layer<A, HostNodeError, R> =>
  layer.pipe(
    Layer.catch(
      (error): Layer.Layer<A, HostNodeError> =>
        Layer.unwrap(Effect.fail(toHostNodeError(error))) as Layer.Layer<
          A,
          HostNodeError
        >,
    ),
  );
