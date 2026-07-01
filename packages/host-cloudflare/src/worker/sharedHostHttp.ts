/**
 * Cloudflare Worker assembly for the shared @ptools/host-api HttpApi router.
 *
 * This module is the platform seam: shared Host HTTP route declarations and
 * handlers come from @ptools/host-api, while Cloudflare supplies Worker env,
 * bearer-token verification, request-origin derivation, and Durable Object RPC dispatch.
 */
import {
  HttpApiBuilder,
  HttpServer,
  HttpServerRequest,
} from "@effect/platform";
import {
  CredentialedHostApiHandlers,
  HostHttpApi,
  OAuthBrowserHandlers,
} from "@ptools/host-api/http";
import {
  HostApiUnauthorized,
  HostHttpOperationAdapterLive,
  HostOperationDispatchError,
  HostOperationDispatcher,
  ProvideHostHttpIngress,
  RequireHostApiAccess,
} from "@ptools/host-api/effect";
import { Context, Effect, Layer, Redacted } from "effect";
import type { PtoolsWorkerEnv } from "./ingress.js";
import { handleCloudflareHostRequest } from "./hostServer.js";
import { verifyBearerToken } from "./publicAuth.js";

/** Request/platform context supplied by the Worker entrypoint per fetch call. */
export class WorkerIngressEnv extends Context.Tag(
  "@ptools/host-cloudflare/WorkerIngressEnv",
)<WorkerIngressEnv, PtoolsWorkerEnv>() {}

const PUBLIC_ORIGIN_HEADER = "x-ptools-public-origin";

/**
 * Cloudflare implementation of the shared Host API bearer middleware.
 *
 * The shared middleware contract only says that a bearer token is required and
 * that successful verification provides `VerifiedHostApiCaller`. This layer is
 * where Cloudflare chooses the trusted expected token source: the Worker env
 * binding `PTOOLS_PUBLIC_ACCESS_TOKEN`.
 */
export const CloudflareRequireHostApiAccessLive: Layer.Layer<
  RequireHostApiAccess,
  never,
  WorkerIngressEnv
> = Layer.effect(
  RequireHostApiAccess,
  Effect.gen(function* () {
    const env = yield* WorkerIngressEnv;

    return RequireHostApiAccess.of({
      bearer: (token) =>
        verifyBearerToken({
          token: Redacted.value(token),
          accessToken: env.PTOOLS_PUBLIC_ACCESS_TOKEN,
        }).pipe(
          Effect.as({ caller: { kind: "HostApiTokenCaller" as const } }),
          Effect.mapError(
            () => new HostApiUnauthorized({ message: "Unauthorized" }),
          ),
        ),
    });
  }),
);

/**
 * Cloudflare middleware that derives Host HTTP ingress facts per request.
 *
 * This middleware runs inside the request handler fiber, so `publicOrigin` is
 * not baked into the cached Worker HttpApi runtime. Requests reaching the same
 * Worker through different public hostnames each receive their own origin.
 *
 * The Worker wrapper below overwrites `x-ptools-public-origin` from the original
 * `Request.url` before handing the request to Effect's Web handler. We do not
 * trust a client-supplied header; this is an internal carrier for the platform
 * adapter because `HttpServerRequest.url` is path-only in the workerd test/runtime
 * adapter.
 */
export const CloudflareProvideHostHttpIngressLive: Layer.Layer<
  ProvideHostHttpIngress
> = Layer.succeed(
  ProvideHostHttpIngress,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const publicOrigin = request.headers[PUBLIC_ORIGIN_HEADER];

    if (publicOrigin === undefined || publicOrigin.trim() === "") {
      throw new Error("Cloudflare Host HTTP ingress request is missing public origin.");
    }

    return {
      publicOrigin,
    };
  }),
);

const withPublicOriginHeader = (request: Request): Request => {
  const headers = new Headers(request.headers);
  headers.set(PUBLIC_ORIGIN_HEADER, new URL(request.url).origin);
  return new Request(request, { headers });
};

/**
 * Cloudflare dispatcher from decoded host operations to per-host Durable Object
 * RPC calls.
 *
 * Host selection and public origin come from the shared HTTP adapter's
 * `HostOperationDispatchInput`, not from route parsing in this layer. The only
 * Cloudflare-specific capability captured here is the Durable Object namespace.
 */
export const CloudflareHostOperationDispatcherLive: Layer.Layer<
  HostOperationDispatcher,
  never,
  WorkerIngressEnv
> = Layer.effect(
  HostOperationDispatcher,
  Effect.gen(function* () {
    const env = yield* WorkerIngressEnv;

    return {
      dispatch: (input) =>
        handleCloudflareHostRequest(
          {
            namespace: env.PTOOLS_CODE_MODE,
            hostId: input.hostId,
            origin: input.publicOrigin,
          },
          input.request,
        ).pipe(
          Effect.mapError(
            (cause) =>
              new HostOperationDispatchError({
                message: "Cloudflare host operation dispatch failed.",
                cause,
              }),
          ),
        ),
    };
  }),
);

/**
 * Build a Web-standard handler for one Worker environment.
 *
 * This function constructs the stable Effect application wiring: shared route
 * declarations, shared handlers, Cloudflare auth/dispatcher layers, and
 * `HttpServer.layerContext`. It should run once per cached Worker env, not once
 * per request.
 *
 * `HttpApiBuilder.toWebHandler(...)` delegates to Effect Platform's
 * `toWebHandlerLayerWith(...)`, whose returned object has an internal lazy cache
 * for the runtime/request handler it builds from the layer. That cache is not
 * global magic: if callers recreate this returned object every request, the
 * internal cache is recreated empty every request too. `entry.ts` keeps this
 * object alive in Worker module memory so both layers of caching can work.
 *
 * Cloudflare `env` is captured once for this Worker environment, while request
 * origin is provided later by `CloudflareProvideHostHttpIngressLive` for each
 * handler fiber.
 */
export const makeCloudflareHostHttpHandler = (env: PtoolsWorkerEnv) => {
  /**
   * Stable Worker bindings for this cached handler instance.
   *
   * This layer captures the Cloudflare `env` object once. Request-specific facts
   * such as URL/origin and bearer token are intentionally not stored here.
   */
  const workerEnvBindingLayer = Layer.succeed(WorkerIngressEnv, env);

  /**
   * Cloudflare-owned platform services used by shared Host HTTP code.
   *
   * These are stable for the lifetime of the cached handler: bearer verification
   * reads the Worker env token, and dispatch knows how to reach the Durable
   * Object namespace. Neither service parses HTTP routes or request bodies.
   */
  const cloudflarePlatformServicesLayer = Layer.mergeAll(
    CloudflareRequireHostApiAccessLive,
    CloudflareHostOperationDispatcherLive,
  ).pipe(Layer.provideMerge(workerEnvBindingLayer));

  /**
   * Shared adapter from decoded HttpApi endpoint contexts to Host operations.
   *
   * The adapter depends on `HostOperationDispatcher`, provided above by
   * Cloudflare, but remains platform-neutral: it builds host operation inputs
   * and delegates dispatch instead of calling Durable Objects directly.
   */
  const sharedHostHttpOperationAdapterLayer = HostHttpOperationAdapterLive.pipe(
    Layer.provideMerge(cloudflarePlatformServicesLayer),
  );

  /**
   * Shared endpoint handlers plus request-scoped ingress middleware.
   *
   * `CloudflareProvideHostHttpIngressLive` is provided with the handlers because
   * handlers need `HostHttpIngress` while they are running for a specific
   * request. Keeping it here prevents request-derived origin from being baked
   * into the stable Worker/env layer graph.
   */
  const sharedHostHttpHandlersLayer = Layer.mergeAll(
    CredentialedHostApiHandlers,
    OAuthBrowserHandlers,
  ).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        sharedHostHttpOperationAdapterLayer,
        CloudflareProvideHostHttpIngressLive,
      ),
    ),
  );

  /** Complete dependency set required to materialize the shared Host HttpApi. */
  const hostHttpApiDependenciesLayer = Layer.mergeAll(
    sharedHostHttpHandlersLayer,
    cloudflarePlatformServicesLayer,
  );

  /** Shared route table/router layer after Cloudflare has supplied dependencies. */
  const hostHttpApiRouterLayer = HttpApiBuilder.api(HostHttpApi).pipe(
    Layer.provideMerge(hostHttpApiDependenciesLayer),
  );

  /**
   * Final Effect Web-app layer.
   *
   * `HttpServer.layerContext` teaches the app how to read a Web `Request` as an
   * Effect `HttpServerRequest` and encode an Effect response back to Web
   * `Response`. This is still a layer graph, not a running request.
   */
  const cloudflareHostHttpWebAppLayer = Layer.mergeAll(
    hostHttpApiRouterLayer,
    HttpServer.layerContext,
  );

  // Converts the Effect layer graph into a Web Fetch-style handler object:
  // `{ handler: (Request) => Promise<Response>, dispose: () => Promise<void> }`.
  // The object lazily builds/caches its runtime on first use, but only for this
  // object instance. Keeping this `effectWebHandler` instance alive is what makes
  // that internal cache useful across requests.
  const effectWebHandler = HttpApiBuilder.toWebHandler(
    cloudflareHostHttpWebAppLayer,
  );

  return {
    ...effectWebHandler,
    // Per-request work stays intentionally small: derive a trusted internal
    // origin carrier from the incoming Request, then call the already-built Web
    // handler. This does not rebuild routes, layers, or the Effect runtime.
    handler: (request: Request) =>
      effectWebHandler.handler(withPublicOriginHeader(request)),
  };
};
