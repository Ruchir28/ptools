/**
 * Shared Effect HttpApi declaration for the V1 Host HTTP API.
 *
 * This file owns only route names, methods, paths, payload schemas, response
 * schemas, and middleware placement. Platform packages mount these groups and
 * provide middleware plus their `HostInstanceDiscovery` implementation.
 */
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
} from "effect/unstable/httpapi";
import { Schema } from "effect";
import { CodeModeRequest } from "@ptools/code-mode-api/contracts";
import {
  ConfigureHostInput,
  ConfigureHostResponse,
  ConfigureHostSecretsInput,
  ConfigureHostSecretsResponse,
  HostCodeModeResponse,
  HostMcpAuthStatusResponse,
  StartHostMcpAuthResponse,
} from "../../contracts/index.js";
import {
  EmptyHttpPayload,
  HostMcpServerPath,
  HostPath,
  OAuthCallbackPath,
  StartMcpAuthHttpPayload,
} from "../../contracts/hostHttpRoutes.js";
import {
  HostHttpBadRequest,
  HostHttpUnauthorized,
  HostHttpHostUnavailable,
  HostHttpInternalError,
} from "../../contracts/hostHttpErrors.js";
import {
  ProvideHostHttpIngress,
  RequireHostApiAccess,
} from "../../services/hostHttpMiddleware.js";

const HostHttpRouteErrors = [
  HostHttpBadRequest,
  HostHttpUnauthorized,
  HostHttpHostUnavailable,
  HostHttpInternalError,
] as const;

/**
 * Credentialed JSON API routes for normal Host API clients.
 *
 * `ProvideHostHttpIngress` is group-scoped rather than API-scoped so Effect's
 * route machinery has installed the per-request `HttpServerRequest` before the
 * platform middleware derives `HostHttpIngress`.
 */
export class CredentialedHostApiGroup extends HttpApiGroup.make("host.api")
  .add(
    HttpApiEndpoint.post("codeMode", "/hosts/:hostId/code-mode", {
      params: HostPath,
      payload: CodeModeRequest,
      success: HostCodeModeResponse,
      error: HostHttpRouteErrors,
    }),
  )
  .add(
    HttpApiEndpoint.put("configure", "/hosts/:hostId/config", {
      params: HostPath,
      payload: ConfigureHostInput,
      success: ConfigureHostResponse,
      error: HostHttpRouteErrors,
    }),
  )
  .add(
    HttpApiEndpoint.put("configureSecrets", "/hosts/:hostId/secrets", {
      params: HostPath,
      payload: ConfigureHostSecretsInput,
      success: ConfigureHostSecretsResponse,
      error: HostHttpRouteErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("mcpAuthStatus", "/hosts/:hostId/auth/status", {
      params: HostPath,
      payload: EmptyHttpPayload,
      success: HostMcpAuthStatusResponse,
      error: HostHttpRouteErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("startMcpAuth", "/hosts/:hostId/auth/:serverName", {
      params: HostMcpServerPath,
      payload: StartMcpAuthHttpPayload,
      success: StartHostMcpAuthResponse,
      error: HostHttpRouteErrors,
    }),
  )
  .middleware(ProvideHostHttpIngress)
  .middleware(RequireHostApiAccess) {}

/**
 * Browser/OAuth callback routes; these do not use Host API bearer auth.
 *
 * `HostHttpUnauthorized` here is for callback-workflow authorization failures
 * such as invalid/signed OAuth state, not for the Host API bearer-token
 * middleware used by credentialed API routes.
 */
export class OAuthBrowserGroup extends HttpApiGroup.make("host.oauth")
  .add(
    HttpApiEndpoint.get(
      "completeOAuthCallbackGet",
      "/hosts/:hostId/oauth/callback/:provider",
      {
        params: OAuthCallbackPath,
        success: Schema.String.pipe(
          HttpApiSchema.asText({ contentType: "text/html" }),
        ),
        error: HostHttpRouteErrors,
      },
    ),
  )
  .add(
    HttpApiEndpoint.post(
      "completeOAuthCallbackPost",
      "/hosts/:hostId/oauth/callback/:provider",
      {
        params: OAuthCallbackPath,
        success: Schema.String.pipe(
          HttpApiSchema.asText({ contentType: "text/html" }),
        ),
        error: HostHttpRouteErrors,
      },
    ),
  )
  .middleware(ProvideHostHttpIngress) {}

/** Complete shared Host HTTP API declaration. */
export class HostHttpApi extends HttpApi.make("ptools-host")
  .add(CredentialedHostApiGroup)
  .add(OAuthBrowserGroup) {}
