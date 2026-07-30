/**
 * Shared HTTP middleware declarations for the Host API.
 *
 * This file deliberately owns only middleware contracts and request-context
 * service tags. It does not provide live middleware layers because verification
 * policy is platform/config specific:
 *
 * - Cloudflare reads the expected bearer token from Worker env/secrets.
 * - Node localhost mode reads it from explicit server construction config.
 * - Embedded/in-memory mode may choose an explicit internal/test auth layer.
 *
 * Keeping implementations out of `@ptools/host-api` prevents shared API code
 * from importing Worker bindings, Node server config, or an accidental
 * `TrustedLocal` credential that external clients could spoof.
 *
 * Public-origin derivation is also platform-owned. The shared API declares
 * `ProvideHostHttpIngress` so route handlers receive `HostHttpIngress` per
 * request, but Cloudflare/Node decide whether that origin comes from the
 * incoming request URL or explicit host configuration.
 */
import {
  HttpApiMiddleware,
  HttpApiSchema,
  HttpApiSecurity,
} from "effect/unstable/httpapi";
import type { HostApiCaller } from "../contracts/hostOperationDispatch.js";
import { Context, Schema } from "effect";

/**
 * Caller identity produced after Host API bearer-token verification.
 *
 * Platform `RequireHostApiAccess` implementations provide this service only
 * for the lifetime of the current HTTP request. Shared handlers consume the
 * normalized caller without knowing where the token came from or how it was
 * checked.
 */
export class VerifiedHostApiCaller extends Context.Service<
  VerifiedHostApiCaller,
  {
    readonly caller: HostApiCaller;
  }
>()("@ptools/VerifiedHostApiCaller") {}

/** HTTP 401 failure for credentialed Host API routes. */
export class HostApiUnauthorized extends Schema.TaggedErrorClass<HostApiUnauthorized>()(
  "HostApiUnauthorized",
  { message: Schema.String },
  { httpApiStatus: 401 },
) {}

/**
 * Middleware contract for routes that require Host API access.
 *
 * The shared contract declares the HTTP-facing shape: bearer auth is required,
 * failures encode as `HostApiUnauthorized`, and successful verification
 * provides `VerifiedHostApiCaller` to the downstream route handler.
 *
 * The live layer is intentionally platform-owned. Cloudflare, Node localhost,
 * and embedded/test modes differ in where their trusted token/config comes
 * from, so this package must not implement a generic token verifier or read any
 * platform-specific env/config values.
 */
export class RequireHostApiAccess extends HttpApiMiddleware.Service<
  RequireHostApiAccess,
  { provides: VerifiedHostApiCaller }
>()("@ptools/RequireHostApiAccess", {
  error: HostApiUnauthorized,
  security: {
    bearer: HttpApiSecurity.bearer,
  },
}) {}

/**
 * Request ingress facts needed by shared Host HTTP handlers.
 *
 * This is also request-scoped. Platform or HTTP middleware should provide the
 * public origin for the current request according to that host's policy. Shared
 * operation adapters use it for auth links and OAuth `redirect_uri` values, but
 * they do not infer it from Cloudflare/Node request objects themselves.
 */
export class HostHttpIngress extends Context.Service<
  HostHttpIngress,
  {
    /** Public base URL used for auth links and OAuth redirect_uri values. */
    readonly publicOrigin: string;
  }
>()("@ptools/HostHttpIngress") {}

/**
 * Middleware contract that provides normalized HTTP ingress facts per request.
 *
 * This keeps request-derived values such as public origin out of the cached
 * application runtime. Platform live layers read their carrier request
 * (`HttpServerRequest` for Web/Node handlers, or an explicit configured origin)
 * and provide `HostHttpIngress` only to the current handler fiber.
 */
export class ProvideHostHttpIngress extends HttpApiMiddleware.Service<
  ProvideHostHttpIngress,
  { provides: HostHttpIngress }
>()("@ptools/ProvideHostHttpIngress") {}
