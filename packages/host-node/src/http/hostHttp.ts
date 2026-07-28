/**
 * Embedded Node Host HTTP assembly.
 *
 * The listener is public ingress only. Every host operation crosses the shared
 * HTTP adapter, daemon discovery, private RPC, and authoritative daemon actor.
 * No authored config or ambient configured secrets are read in this process.
 */
import { HttpApiBuilder } from "@effect/platform";
import {
  CredentialedHostApiHandlers,
  HostHttpApi,
  OAuthBrowserHandlers,
} from "@ptools/host-api/http";
import {
  HostApiUnauthorized,
  HostHttpClient,
  HostHttpClientFetchLive,
  HostHttpIngress,
  HostHttpOperationAdapterLive,
  HostInstanceDiscovery,
  ProvideHostHttpIngress,
  RequireHostApiAccess,
} from "@ptools/host-api/effect";
import { Effect, Layer, Redacted } from "effect";
import type { NodeHostActorRuntimeOptions } from "../hostActorDaemon/actorRuntime/contracts/nodeHostActorRuntimeOptions.js";
import {
  resolveNodeHostActorRuntimeOptions,
  type NodeHostActorStateNamespaceOverrides,
} from "../hostActorDaemon/daemonProcess/nodeHostActorStateNamespace.js";
import { NodeDaemonHostInstanceDiscoveryLive } from "../nodeDaemonHostInstanceDiscovery.js";
import {
  DEFAULT_NODE_PUBLIC_ORIGIN,
  HostNodeError,
  NODE_INTERNAL_ACCESS_TOKEN,
  type NodeHostOptions,
} from "../options.js";
import { NodeLocalHostHttpServerLive } from "./nodeLocalHostHttpServer.js";

interface ResolvedNodeHostOptions {
  readonly hostId: string;
  readonly publicOrigin: string;
  readonly daemon: NodeHostActorRuntimeOptions;
}

/** Server-only embedded Node ingress backed by daemon discovery. */
export const NodeHostHttpServerLive = (
  options: NodeHostOptions,
): Layer.Layer<never, HostNodeError, never> =>
  Layer.unwrapEffect(
    resolveNodeHostOptions(options).pipe(
      Effect.map((resolved) => makeNodeHostHttpServerLive(resolved)),
    ),
  ).pipe(Layer.mapError(toHostNodeError));

/**
 * One scoped embedded listener plus a shared HTTP client pointed at it.
 * Although only HostHttpClient is exposed, closing this layer also closes the
 * listener and releases its scope-owned daemon lease.
 */
export const NodeEmbeddedHostHttpStackLive = (
  options: NodeHostOptions,
): Layer.Layer<HostHttpClient, HostNodeError, never> =>
  Layer.unwrapEffect(
    resolveNodeHostOptions(options).pipe(
      Effect.map((resolved) =>
        Layer.merge(
          makeNodeHostHttpServerLive(resolved),
          HostHttpClientFetchLive({
            baseUrl: resolved.publicOrigin,
            hostId: resolved.hostId,
            accessToken: NODE_INTERNAL_ACCESS_TOKEN,
          }),
        ),
      ),
    ),
  ).pipe(Layer.mapError(toHostNodeError));

const resolveNodeHostOptions = (
  options: NodeHostOptions,
): Effect.Effect<ResolvedNodeHostOptions, HostNodeError> =>
  Effect.gen(function* () {
    if (options.hostId.trim() === "") {
      return yield* new HostNodeError({
        message: "Node hostId must not be empty.",
      });
    }

    const publicOrigin = yield* resolveNodePublicOrigin(
      options.publicOrigin ?? DEFAULT_NODE_PUBLIC_ORIGIN,
    );
    const daemonOverrides: NodeHostActorStateNamespaceOverrides = {
      ...(options.internalStateDirectory === undefined
        ? {}
        : { internalStateDirectory: options.internalStateDirectory }),
      ...(options.denoExecutable === undefined
        ? {}
        : { denoExecutable: options.denoExecutable }),
    };
    const daemon = yield* resolveNodeHostActorRuntimeOptions(
      daemonOverrides,
    ).pipe(Effect.mapError(toHostNodeError));

    return { hostId: options.hostId, publicOrigin, daemon };
  });

const resolveNodePublicOrigin = (
  input: string,
): Effect.Effect<string, HostNodeError> =>
  Effect.gen(function* () {
    const url = yield* Effect.try({
      try: () => new URL(input),
      catch: (cause) =>
        new HostNodeError({
          message: "Node publicOrigin must be a valid absolute URL.",
          cause,
        }),
    });

    if (url.protocol !== "http:") {
      return yield* new HostNodeError({
        message: "Node embedded Host HTTP publicOrigin must use http:.",
      });
    }
    if (url.port === "") {
      return yield* new HostNodeError({
        message: "Node embedded Host HTTP publicOrigin must include a port.",
      });
    }
    if (!isLoopbackHostname(url.hostname)) {
      return yield* new HostNodeError({
        message:
          "Embedded Node Host HTTP ingress must bind to a loopback hostname.",
      });
    }
    if (
      url.username !== "" ||
      url.password !== "" ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      return yield* new HostNodeError({
        message:
          "Node publicOrigin must be an origin without credentials, path, query, or fragment.",
      });
    }

    return url.origin;
  });

const makeNodeHostHttpServerLive = (
  options: ResolvedNodeHostOptions,
): Layer.Layer<never, unknown, never> =>
  NodeLocalHostHttpServerLive({
    publicOrigin: options.publicOrigin,
    apiLayer: makeNodeHostHttpApiLayer(options),
  });

const makeNodeHostHttpApiLayer = (options: ResolvedNodeHostOptions) =>
  makeNodeHostHttpApiLayerFromPlatformLayers({
    discoveryLayer: NodeDaemonHostInstanceDiscoveryLive(options.daemon).pipe(
      Layer.mapError(toHostNodeError),
    ),
    publicOrigin: options.publicOrigin,
  });

/** Local embedded bearer verification; this credential is never daemon RPC auth. */
const NodeEmbeddedRequireHostApiAccessLive: Layer.Layer<RequireHostApiAccess> =
  Layer.succeed(
    RequireHostApiAccess,
    RequireHostApiAccess.of({
      bearer: (token) =>
        Redacted.value(token) === NODE_INTERNAL_ACCESS_TOKEN
          ? Effect.succeed({ caller: { kind: "HostApiTokenCaller" as const } })
          : Effect.fail(new HostApiUnauthorized({ message: "Unauthorized" })),
    }),
  );

const NodeProvideHostHttpIngressLive = (
  publicOrigin: string,
): Layer.Layer<ProvideHostHttpIngress> =>
  Layer.succeed(
    ProvideHostHttpIngress,
    Effect.succeed(HostHttpIngress.of({ publicOrigin })),
  );

/** Assemble shared route handlers over a platform-selected discovery layer. */
const makeNodeHostHttpApiLayerFromPlatformLayers = (input: {
  readonly discoveryLayer: Layer.Layer<
    HostInstanceDiscovery,
    HostNodeError,
    never
  >;
  readonly publicOrigin: string;
}) => {
  const platformServicesLayer = Layer.mergeAll(
    NodeEmbeddedRequireHostApiAccessLive,
    input.discoveryLayer,
  );
  const adapterLayer = HostHttpOperationAdapterLive.pipe(
    Layer.provideMerge(platformServicesLayer),
  );
  const handlersLayer = Layer.mergeAll(
    CredentialedHostApiHandlers,
    OAuthBrowserHandlers,
  ).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        adapterLayer,
        NodeProvideHostHttpIngressLive(input.publicOrigin),
      ),
    ),
  );

  return HttpApiBuilder.api(HostHttpApi).pipe(
    Layer.provideMerge(Layer.mergeAll(handlersLayer, platformServicesLayer)),
  );
};

const isLoopbackHostname = (hostname: string): boolean =>
  hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";

const toHostNodeError = (cause: unknown): HostNodeError =>
  cause instanceof HostNodeError
    ? cause
    : new HostNodeError({
        message:
          typeof cause === "object" &&
          cause !== null &&
          "message" in cause &&
          typeof cause.message === "string"
            ? cause.message
            : "Failed to construct embedded Node Host HTTP services.",
        cause,
      });
