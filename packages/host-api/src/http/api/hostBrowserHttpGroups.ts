/**
 * Host HTTP groups consumed by Principal-authenticated browser clients.
 *
 * These groups are the JSON boundary for the React Control Center. They own
 * route schemas and carrier-neutral middleware placement, while React owns
 * presentation and platforms own browser credential verification.
 */
import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import {
  HostMcpAuthStatusResponse,
  StartHostMcpAuthResponse,
} from "../../contracts/hostMcpAuth.js";
import {
  HostMcpServerPath,
  HostPath,
  StartMcpAuthHttpPayload,
} from "../../contracts/hostHttpRoutes.js";
import {
  HostHttpBadRequest,
  HostHttpForbidden,
  HostHttpHostUnavailable,
  HostHttpInternalError,
  HostHttpUnauthorized,
} from "../../contracts/hostHttpErrors.js";
import { RequireAuthenticatedBrowserPrincipal } from "../../services/hostBrowserMiddleware.js";
import { ProvideHostHttpIngress } from "../../services/hostHttpMiddleware.js";

const BrowserHostRouteErrors = [
  HostHttpBadRequest,
  HostHttpUnauthorized,
  HostHttpForbidden,
  HostHttpHostUnavailable,
  HostHttpInternalError,
] as const;

/**
 * Safe browser reads authenticated as a durable Principal.
 *
 * The React application owns page/query selection. This group returns the full
 * authoritative MCP auth status and accepts no presentation parameters.
 */
export class BrowserHostAuthReadGroup extends HttpApiGroup.make(
  "host.browser.auth.read",
)
  .add(
    HttpApiEndpoint.get(
      "mcpAuthStatus",
      "/api/browser/hosts/:hostId/mcp-auth",
      {
        params: HostPath,
        success: HostMcpAuthStatusResponse,
        error: BrowserHostRouteErrors,
      },
    ),
  )
  .middleware(ProvideHostHttpIngress)
  .middleware(RequireAuthenticatedBrowserPrincipal) {}

/** Browser mutations authenticated as a durable Principal. */
export class BrowserHostAuthMutationGroup extends HttpApiGroup.make(
  "host.browser.auth.mutation",
)
  .add(
    HttpApiEndpoint.post(
      "startMcpAuth",
      "/api/browser/hosts/:hostId/mcp-auth/:serverName/start",
      {
        params: HostMcpServerPath,
        payload: StartMcpAuthHttpPayload,
        success: StartHostMcpAuthResponse,
        error: BrowserHostRouteErrors,
      },
    ),
  )
  .middleware(ProvideHostHttpIngress)
  .middleware(RequireAuthenticatedBrowserPrincipal) {}
