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
 */
import {
  HttpApiMiddleware,
  HttpApiSchema,
  HttpApiSecurity,
} from "@effect/platform";
import { Context, Schema } from "effect";
import type { HostApiCaller } from "./hostOperationDispatcher.js";

/**
 * Caller identity produced after Host API bearer-token verification.
 *
 * Platform `RequireHostApiAccess` implementations provide this service only
 * for the lifetime of the current HTTP request. Shared handlers consume the
 * normalized caller without knowing where the token came from or how it was
 * checked.
 */
export class VerifiedHostApiCaller extends Context.Tag(
  "@ptools/VerifiedHostApiCaller",
)<
  VerifiedHostApiCaller,
  {
    readonly caller: HostApiCaller;
  }
>() {}

/** HTTP 401 failure for credentialed Host API routes. */
export class HostApiUnauthorized extends Schema.TaggedError<HostApiUnauthorized>()(
  "HostApiUnauthorized",
  { message: Schema.String },
  HttpApiSchema.annotations({ status: 401 }),
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
export class RequireHostApiAccess extends HttpApiMiddleware.Tag<RequireHostApiAccess>()(
  "@ptools/RequireHostApiAccess",
  {
    failure: HostApiUnauthorized,
    provides: VerifiedHostApiCaller,
    security: {
      bearer: HttpApiSecurity.bearer,
    },
  },
) {}

/**
 * Request ingress facts needed by shared Host HTTP handlers.
 *
 * This is also request-scoped. Platform or HTTP middleware should provide the
 * public origin for the current request according to that host's policy. Shared
 * operation adapters use it for auth links and OAuth `redirect_uri` values, but
 * they do not infer it from Cloudflare/Node request objects themselves.
 */
export class HostHttpIngress extends Context.Tag("@ptools/HostHttpIngress")<
  HostHttpIngress,
  {
    /** Public base URL used for auth links and OAuth redirect_uri values. */
    readonly publicOrigin: string;
  }
>() {}
