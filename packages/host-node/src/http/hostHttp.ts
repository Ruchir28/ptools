import {
  HttpApiBuilder,
} from "@effect/platform";
import { CodeModeClient } from "@ptools/code-mode-api/effect";
import type { ServerConfigError } from "@ptools/config";
import {
  CredentialedHostApiHandlers,
  HostHttpApi,
  OAuthBrowserHandlers,
} from "@ptools/host-api/http";
import {
  CodeModeClientFromHostHttpClientLive,
  HostHttpClient,
  HostHttpClientFetchLive,
  HostHttpIngress,
  HostHttpOperationAdapterLive,
  HostOperationDispatcher,
  ProvideHostHttpIngress,
  RequireHostApiAccess,
} from "@ptools/host-api/effect";
import { Effect, Layer } from "effect";
import { NodeHostOperationDispatcherLiveWithPlatform } from "../layers/hostOperationDispatcher.js";
import {
  NodeHostPlatformLive,
  NodeHostSettings,
  type NodeHostProcessPlatform,
} from "../layers/platform/index.js";
import { NodeLocalHostHttpServerLive } from "./nodeLocalHostHttpServer.js";
import {
  DEFAULT_HOST_ID,
  DEFAULT_NODE_PUBLIC_ORIGIN,
  NODE_INTERNAL_ACCESS_TOKEN,
  type NodeCodeModeHostOptions,
} from "../options.js";

/**
 * Node Host HTTP assembly.
 *
 * Keep the server/client split explicit:
 *
 * ```txt
 * NodeHostHttpServerLive
 *   owns this process's HTTP listener and shared HostHttpApi server graph
 *
 * HostHttpClientFetchLive              (@ptools/host-api/effect)
 *   owns generic network client behavior for a caller-supplied baseUrl/token
 *
 * NodeLocalHostHttpClientLive
 *   convenience composition for SDK handles that intentionally want this same
 *   process to start a server and create a client pointed at it
 * ```
 *
 * Generic clients running on another machine should not import Node server
 * layers. They should use the shared `HostHttpClientFetchLive({ baseUrl, ... })`
 * directly. The local convenience layer exists only for embedded/local SDK
 * ergonomics.
 *
 * Local runtime flow for one call, e.g. `CodeModeClient.call(...)`:
 *
 * ```txt
 * HostHttpClient.codeMode (typed request)
 *   -> Effect HttpClient.execute via shared HostHttpClientFetchLive
 *   -> Fetch to Node local listener                    (nodeLocalHostHttpServer.ts)
 *   -> shared HostHttpApi server layer                 (HttpApiBuilder.serve)
 *   -> CredentialedHostApiHandlers "codeMode" route    (@ptools/host-api/http)
 *   -> HostHttpOperationAdapter.codeMode               (@ptools/host-api/effect)
 *   -> HostOperationDispatcher.dispatch                (platform seam)
 *   -> NodeHostOperationDispatcherLive.dispatch        (hostOperationDispatcher.ts)
 *   -> CodeModeServer.handle(...)                      (codeModeRuntime.ts)
 * ```
 */

/**
 * Server-only layer for the local Node Host API listener.
 *
 * Build this when the current process should be the Host API server. It starts
 * `@effect/platform-node/NodeHttpServer`, mounts the shared Host HttpApi route
 * graph, and releases the listener when the surrounding runtime/layer scope is
 * disposed.
 *
 * It intentionally provides no client and no custom server-info service. The
 * public origin is config/default-based (`options.publicOrigin` or
 * `DEFAULT_NODE_PUBLIC_ORIGIN`), so callers already know where the server lives
 * before the listener starts.
 */
export const NodeHostHttpServerLive = (
  configPath?: string,
  options: NodeCodeModeHostOptions = {},
): Layer.Layer<never, never, never> => {
  const platformLayer = NodeHostPlatformLive(options);

  return makeNodeHostHttpServerLiveWithPlatform({
    configPath,
    options,
    platformLayer,
  });
};

const makeNodeHostHttpServerLiveWithPlatform = (input: {
  readonly configPath: string | undefined;
  readonly options: NodeCodeModeHostOptions;
  readonly platformLayer: Layer.Layer<NodeHostProcessPlatform>;
}): Layer.Layer<never, never, never> =>
  Layer.unwrapEffect(
    Effect.gen(function* () {
      const settings = yield* NodeHostSettings;

      return NodeLocalHostHttpServerLive({
        publicOrigin: settings.publicOrigin,
        apiLayer: makeNodeHostHttpApiLayer({
          configPath: input.configPath,
          options: input.options,
          platformLayer: input.platformLayer,
        }).pipe(Layer.provide(input.platformLayer)),
      }).pipe(Layer.orDie);
    }),
  ).pipe(Layer.provide(input.platformLayer));

/**
 * Local SDK convenience layer: server plus client in the same runtime.
 *
 * Use this only for embedded/local constructors such as `createNodeHostClient`
 * and `createNodeCodeModeClient`, where the caller explicitly wants this process
 * to own both lifetimes. This layer starts `NodeHostHttpServerLive(...)` and also
 * provides a `HostHttpClient` pointed at the configured local origin.
 *
 * Do not use this for normal client/server deployments. A client running on a VM
 * or another process should use shared `HostHttpClientFetchLive` with an explicit
 * remote `baseUrl`, `hostId`, and `accessToken` instead.
 */
export const NodeLocalHostHttpClientLive = (
  configPath?: string,
  options: NodeCodeModeHostOptions = {},
): Layer.Layer<HostHttpClient, never, never> => {
  const platformLayer = NodeHostPlatformLive(options);
  const clientLayer = Layer.unwrapEffect(
    Effect.gen(function* () {
      const settings = yield* NodeHostSettings;

      return HostHttpClientFetchLive(resolveHostHttpClientOptions({
        hostId: options.hostId,
        publicOrigin: settings.publicOrigin,
      }));
    }),
  ).pipe(Layer.provide(platformLayer));

  return Layer.mergeAll(
    makeNodeHostHttpServerLiveWithPlatform({
      configPath,
      options,
      platformLayer,
    }),
    clientLayer,
  );
};

/** Focused CodeModeClient backed by Node's configured Host HttpApi wiring. */
export const NodeCodeModeClientLive = (
  configPath?: string,
  options: NodeCodeModeHostOptions = {},
): Layer.Layer<CodeModeClient, never, never> =>
  CodeModeClientFromHostHttpClientLive.pipe(
    Layer.provide(NodeLocalHostHttpClientLive(configPath, options)),
  );

/**
 * Adds a `CodeModeClient` derived from an already-built `HostHttpClient`
 * layer, without re-resolving config or rebuilding the underlying handler.
 * Use this when a caller already constructed `hostLayer` (e.g. to share one
 * local host across multiple consumers) and just needs the focused
 * Code Mode surface alongside it.
 */
export const makeNodeHostHttpClientWithCodeModeLive = (
  hostLayer: Layer.Layer<HostHttpClient, never, never>,
): Layer.Layer<HostHttpClient | CodeModeClient, never, never> =>
  Layer.merge(
    hostLayer,
    CodeModeClientFromHostHttpClientLive.pipe(Layer.provide(hostLayer)),
  );

/**
 * Builds connection options for the shared fetch-backed Host client.
 *
 * These are just client connection facts: where to call (`baseUrl`), which host
 * id to address, and which bearer token to send. They do not start a server.
 */
const resolveHostHttpClientOptions = (options: {
  readonly hostId?: string | undefined;
  readonly publicOrigin?: string | undefined;
}) => ({
  baseUrl: options.publicOrigin ?? DEFAULT_NODE_PUBLIC_ORIGIN,
  hostId: options.hostId ?? DEFAULT_HOST_ID,
  accessToken: NODE_INTERNAL_ACCESS_TOKEN,
});

/**
 * Resolves the configured public origin before server startup.
 *
 * Because the origin is config/default-based rather than discovered from a
 * random port, the Host HttpApi layer can be built once with the final OAuth
 * callback/base URL and the server can start in a normal single layer graph.
 */
/**
 * Satisfies the shared HttpApi's auth middleware (`RequireHostApiAccess`) for
 * local Node mode, where the caller is trusted by construction rather than
 * by a verifiable bearer token.
 *
 * The shared route still requires *a* bearer token on the wire (so the same
 * middleware works for real deployed hosts), but here the "verification" step
 * always succeeds: reaching this code at all already proves the caller is
 * this same Node process, since no network socket is involved.
 */
const NodeEmbeddedRequireHostApiAccessLive: Layer.Layer<
  RequireHostApiAccess
> = Layer.succeed(
  RequireHostApiAccess,
  RequireHostApiAccess.of({
    bearer: () =>
      Effect.succeed({ caller: { kind: "HostApiTokenCaller" as const } }),
  }),
);

/**
 * Supplies the per-request `HostHttpIngress` (public origin) that route
 * handlers use to build absolute auth/OAuth redirect URLs. Node has no real
 * incoming request to read an origin header from, so it always reports the
 * configured `publicOrigin` instead.
 */
const NodeProvideHostHttpIngressLive: Layer.Layer<
  ProvideHostHttpIngress,
  never,
  NodeHostSettings
> = Layer.unwrapEffect(
  Effect.gen(function* () {
    const settings = yield* NodeHostSettings;

    return Layer.succeed(
      ProvideHostHttpIngress,
      Effect.succeed(HostHttpIngress.of({ publicOrigin: settings.publicOrigin })),
    );
  }),
);

/**
 * Builds the server-side Host HttpApi layer served by the Node loopback server.
 *
 * Ownership boundary:
 * - this function assembles the Node platform services for the shared HTTP API;
 * - `nodeLocalHostHttpServer.ts` owns the Effect-native Node HTTP server
 *   lifecycle.
 */
const makeNodeHostHttpApiLayer = (input: {
  readonly configPath: string | undefined;
  readonly options: NodeCodeModeHostOptions;
  readonly platformLayer: Layer.Layer<NodeHostProcessPlatform>;
}) =>
  makeNodeHostHttpApiLayerFromPlatformLayers({
    // This is the platform seam: it decides how a decoded "code_mode" (etc.)
    // operation actually runs. Node's implementation forwards to the local
    // CodeModeServer/sandbox; other platforms could dispatch elsewhere.
    dispatcherLayer: NodeHostOperationDispatcherLiveWithPlatform({
      configPath: input.configPath,
      options: input.options,
      processPlatformLayer: input.platformLayer,
    }),
  });

/**
 * Assembles the shared `HostHttpApi` route graph, bottom-up, into a single
 * Web-standard handler. Each layer below provides what the layer above it
 * needs, mirroring how a real deployed host would compose the same pieces:
 *
 * ```txt
 * platformServicesLayer   (auth verification + operation dispatch)
 *        |
 * adapterLayer            (typed endpoint input -> HostOperationDispatcher)
 *        |
 * handlersLayer           (HostHttpApi route implementations)
 *        |
 * apiLayer                (HostHttpApi wired to HttpApiBuilder)
 *        |
 * HttpApiBuilder.serve(...) -> served by @effect/platform-node
 * ```
 */
const makeNodeHostHttpApiLayerFromPlatformLayers = (input: {
  readonly dispatcherLayer: Layer.Layer<
    HostOperationDispatcher,
    unknown | ServerConfigError,
    never
  >;
}) => {
  // Stable platform services for this local Node host. They are below the
  // shared Host HTTP handlers so route parsing/schema decoding remains shared.
  const platformServicesLayer = Layer.mergeAll(
    NodeEmbeddedRequireHostApiAccessLive,
    input.dispatcherLayer,
  );

  // Shared adapter turns typed endpoint input into HostOperationDispatcher calls.
  const adapterLayer = HostHttpOperationAdapterLive.pipe(
    Layer.provideMerge(platformServicesLayer),
  );

  // Shared route handlers plus Node's request-origin provider.
  const handlersLayer = Layer.mergeAll(
    CredentialedHostApiHandlers,
    OAuthBrowserHandlers,
  ).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        adapterLayer,
        NodeProvideHostHttpIngressLive,
      ),
    ),
  );

  return HttpApiBuilder.api(HostHttpApi).pipe(
    Layer.provideMerge(Layer.mergeAll(handlersLayer, platformServicesLayer)),
  );
};

