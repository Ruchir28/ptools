/**
 * Shared HTTP middleware declarations for the Host API.
 *
 * This file owns request-context contracts, not credential verification or
 * public-origin derivation. Platforms prove a Principal credential or Host
 * token and provide `AuthenticatedHostCallerContext`; shared handlers then own
 * Host-scoped authorization. Platforms likewise derive `HostHttpIngress` from
 * their trusted request/configuration boundary.
 */
import { HttpApiMiddleware } from "effect/unstable/httpapi";
import { AuthenticatedHostCallerContext } from "./hostAuthorizationAdmission.js";
import { Context, Schema } from "effect";

/** HTTP 401 failure for credentialed Host API routes. */
export class HostApiUnauthorized extends Schema.TaggedErrorClass<HostApiUnauthorized>()(
  "HostApiUnauthorized",
  { message: Schema.String },
  { httpApiStatus: 401 },
) {}

/**
 * Platform authentication contract for Principal and Host-token credentials.
 *
 * A successful Principal verifier first ensures the durable Principal exists;
 * a successful Host-token verifier retains its verified frozen grants. The
 * implementation provides only the normalized request-local caller context.
 * It must never synthesize a Principal or accept an unverified credential.
 * Shared Host handlers perform authorization after this middleware succeeds.
 */
export class RequireAuthenticatedHostCaller extends HttpApiMiddleware.Service<
  RequireAuthenticatedHostCaller,
  { provides: AuthenticatedHostCallerContext }
>()("@ptools/RequireAuthenticatedHostCaller", {
  error: HostApiUnauthorized,
}) {}

/**
 * Request ingress facts needed by shared Host HTTP handlers.
 *
 * This is request-scoped. Platforms provide the public origin according to
 * their ingress policy; operation adapters use it for auth links and OAuth
 * redirect URIs without inspecting a platform request directly.
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
 * Keeping this value request-scoped prevents a dynamic request origin from
 * being captured in the long-lived application Layer.
 */
export class ProvideHostHttpIngress extends HttpApiMiddleware.Service<
  ProvideHostHttpIngress,
  { provides: HostHttpIngress }
>()("@ptools/ProvideHostHttpIngress") {}
