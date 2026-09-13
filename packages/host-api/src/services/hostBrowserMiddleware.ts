/**
 * Shared browser-admission contracts for Control Center JSON APIs.
 *
 * Platforms own cookie/session extraction, credential verification, and login
 * challenges. This middleware publishes only the verified Principal context
 * consumed by shared handlers; it does not standardize a browser credential.
 */
import { HttpApiMiddleware } from "effect/unstable/httpapi";
import { AuthenticatedHostCallerContext } from "./hostAuthorizationAdmission.js";
import { HostApiUnauthorized } from "./hostHttpMiddleware.js";

/**
 * Platform browser-authentication output required by Control Center reads.
 *
 * A successful implementation provides `AuthenticatedHostCallerContext` in its
 * Principal variant. It must never turn a Host token into a Principal or infer
 * identity from route/query values. Shared admission resolves current Host
 * authority after this middleware succeeds.
 */
export class RequireAuthenticatedBrowserPrincipal extends HttpApiMiddleware.Service<
  RequireAuthenticatedBrowserPrincipal,
  { provides: AuthenticatedHostCallerContext }
>()("@ptools/RequireAuthenticatedBrowserPrincipal", {
  error: HostApiUnauthorized,
}) {}

