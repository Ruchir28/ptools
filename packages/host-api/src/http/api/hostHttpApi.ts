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
} from "@effect/platform";
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

/**
 * Credentialed JSON API routes for normal Host API clients.
 *
 * `ProvideHostHttpIngress` is group-scoped rather than API-scoped so Effect's
 * route machinery has installed the per-request `HttpServerRequest` before the
 * platform middleware derives `HostHttpIngress`.
 */
export class CredentialedHostApiGroup extends HttpApiGroup.make("host.api")
  .middleware(ProvideHostHttpIngress)
  .middleware(RequireHostApiAccess)
  .add(
    HttpApiEndpoint.post("codeMode", "/hosts/:hostId/code-mode")
      .setPath(HostPath)
      .setPayload(CodeModeRequest)
      .addSuccess(HostCodeModeResponse)
      .addError(HostHttpBadRequest)
      .addError(HostHttpUnauthorized)
      .addError(HostHttpHostUnavailable)
      .addError(HostHttpInternalError),
  )
  .add(
    HttpApiEndpoint.put("configure", "/hosts/:hostId/config")
      .setPath(HostPath)
      .setPayload(ConfigureHostInput)
      .addSuccess(ConfigureHostResponse)
      .addError(HostHttpBadRequest)
      .addError(HostHttpUnauthorized)
      .addError(HostHttpHostUnavailable)
      .addError(HostHttpInternalError),
  )
  .add(
    HttpApiEndpoint.put("configureSecrets", "/hosts/:hostId/secrets")
      .setPath(HostPath)
      .setPayload(ConfigureHostSecretsInput)
      .addSuccess(ConfigureHostSecretsResponse)
      .addError(HostHttpBadRequest)
      .addError(HostHttpUnauthorized)
      .addError(HostHttpHostUnavailable)
      .addError(HostHttpInternalError),
  )
  .add(
    HttpApiEndpoint.post("mcpAuthStatus", "/hosts/:hostId/auth/status")
      .setPath(HostPath)
      .setPayload(EmptyHttpPayload)
      .addSuccess(HostMcpAuthStatusResponse)
      .addError(HostHttpBadRequest)
      .addError(HostHttpUnauthorized)
      .addError(HostHttpHostUnavailable)
      .addError(HostHttpInternalError),
  )
  .add(
    HttpApiEndpoint.post("startMcpAuth", "/hosts/:hostId/auth/:serverName")
      .setPath(HostMcpServerPath)
      .setPayload(StartMcpAuthHttpPayload)
      .addSuccess(StartHostMcpAuthResponse)
      .addError(HostHttpBadRequest)
      .addError(HostHttpUnauthorized)
      .addError(HostHttpHostUnavailable)
      .addError(HostHttpInternalError),
  ) {}

/**
 * Browser/OAuth callback routes; these do not use Host API bearer auth.
 *
 * `HostHttpUnauthorized` here is for callback-workflow authorization failures
 * such as invalid/signed OAuth state, not for the Host API bearer-token
 * middleware used by credentialed API routes.
 */
export class OAuthBrowserGroup extends HttpApiGroup.make("host.oauth")
  .middleware(ProvideHostHttpIngress)
  .add(
    HttpApiEndpoint.get(
      "completeOAuthCallbackGet",
      "/hosts/:hostId/oauth/callback/:provider",
    )
      .setPath(OAuthCallbackPath)
      .addSuccess(HttpApiSchema.Text({ contentType: "text/html" }))
      .addError(HostHttpBadRequest)
      .addError(HostHttpUnauthorized)
      .addError(HostHttpHostUnavailable)
      .addError(HostHttpInternalError),
  )
  .add(
    HttpApiEndpoint.post(
      "completeOAuthCallbackPost",
      "/hosts/:hostId/oauth/callback/:provider",
    )
      .setPath(OAuthCallbackPath)
      .addSuccess(HttpApiSchema.Text({ contentType: "text/html" }))
      .addError(HostHttpBadRequest)
      .addError(HostHttpUnauthorized)
      .addError(HostHttpHostUnavailable)
      .addError(HostHttpInternalError),
  ) {}

/** Complete shared Host HTTP API declaration. */
export class HostHttpApi extends HttpApi.make("ptools-host")
  .add(CredentialedHostApiGroup)
  .add(OAuthBrowserGroup) {}
