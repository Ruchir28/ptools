/**
 * Shared JSON handlers for the Principal-authenticated browser Host API.
 *
 * React owns browser routes and presentation. These handlers only authorize a
 * typed Host operation, adapt it through `HostHttpOperationAdapter`, and return
 * the existing schema-backed JSON response.
 */
import { HostPolicies } from "@ptools/host-authorization/effect";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { withPrincipalHostAuthorization } from "../../services/hostAuthorizationAdmission.js";
import { HostHttpOperationAdapter } from "../../services/hostHttpOperationAdapter.js";
import { HostHttpApi } from "../api/hostHttpApi.js";
import { toHostAuthorizationHttpError } from "../hostAuthorizationHttpError.js";

/**
 * Browser read handler Layer for authoritative MCP auth status.
 *
 * Platforms mount this shared Layer after supplying request-local browser
 * Principal, ingress, authorization, and operation-adapter capabilities.
 */
export const BrowserHostAuthReadHandlers = HttpApiBuilder.group(
  HostHttpApi,
  "host.browser.auth.read",
  (handlers) =>
    handlers.handle("mcpAuthStatus", (ctx) =>
      withPrincipalHostAuthorization(
        { hostId: ctx.params.hostId, policy: HostPolicies.readAuth },
        () =>
          Effect.flatMap(HostHttpOperationAdapter, (adapter) =>
            adapter.mcpAuthStatus({ params: ctx.params }),
          ),
      ).pipe(Effect.mapError(toHostAuthorizationHttpError)),
    ),
);

/**
 * Browser mutation handler Layer for starting or restarting MCP auth.
 *
 * Browser middleware has already proved browser identity; this handler owns
 * Host policy admission and typed operation adaptation only.
 */
export const BrowserHostAuthMutationHandlers = HttpApiBuilder.group(
  HostHttpApi,
  "host.browser.auth.mutation",
  (handlers) =>
    handlers.handle("startMcpAuth", (ctx) =>
      withPrincipalHostAuthorization(
        { hostId: ctx.params.hostId, policy: HostPolicies.manageAuth },
        () =>
          Effect.flatMap(HostHttpOperationAdapter, (adapter) =>
            adapter.startMcpAuth(ctx),
          ),
      ).pipe(Effect.mapError(toHostAuthorizationHttpError)),
    ),
);
