import {
  ClaimInitialAdministratorInput,
  ControlPlaneClaimStatus,
  CreateRegisteredHostInput,
  CreatedOwnedHost,
  HostToken,
  IssuedHostToken,
  PrincipalControlPlaneAccess,
  RegisteredHost,
} from "@ptools/host-authorization/contracts";
import { Schema } from "effect";
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
} from "effect/unstable/httpapi";
import {
  ControlPlanePrincipalPath,
  HostCredentialPath,
  IssueHostTokenHttpPayload,
  ReplaceControlPlaneRolesHttpPayload,
} from "../../contracts/controlPlaneHttp.js";
import { HostPath } from "../../contracts/hostHttpRoutes.js";
import {
  HostHttpBadRequest,
  HostHttpConflict,
  HostHttpForbidden,
  HostHttpInternalError,
  HostHttpNotFound,
  HostHttpUnauthorized,
} from "../../contracts/hostHttpErrors.js";
import { RequireAuthenticatedHostCaller } from "../../services/hostHttpMiddleware.js";

const errors = [
  HostHttpBadRequest,
  HostHttpUnauthorized,
  HostHttpForbidden,
  HostHttpConflict,
  HostHttpNotFound,
  HostHttpInternalError,
] as const;

/** Public setup-state inspection; it discloses no setup digest or identity data. */
export class ControlPlaneClaimStatusGroup extends HttpApiGroup.make(
  "control-plane.claim-status",
).add(
  HttpApiEndpoint.get("getClaimStatus", "/control-plane/claim-status", {
    success: ControlPlaneClaimStatus,
    error: errors,
  }),
) {}

/** Principal-caller Control Plane administration routes. */
export class ControlPlaneAdministrationGroup extends HttpApiGroup.make(
  "control-plane.administration",
)
  .add(
    HttpApiEndpoint.post("claimInitialAdministrator", "/control-plane/claim", {
      payload: ClaimInitialAdministratorInput,
      success: PrincipalControlPlaneAccess,
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.post("createHost", "/hosts", {
      payload: CreateRegisteredHostInput,
      success: CreatedOwnedHost,
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.get("listHosts", "/hosts", {
      success: Schema.Array(RegisteredHost),
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.get(
      "listAllHostTokens",
      "/control-plane/credentials",
      {
        success: Schema.Array(HostToken),
        error: errors,
      },
    ),
  )
  .add(
    HttpApiEndpoint.put(
      "replaceControlPlaneRoles",
      "/control-plane/principals/:principalId/roles",
      {
        params: ControlPlanePrincipalPath,
        payload: ReplaceControlPlaneRolesHttpPayload,
        success: PrincipalControlPlaneAccess,
        error: errors,
      },
    ),
  )
  .middleware(RequireAuthenticatedHostCaller) {}

/** Principal-caller management of Host-bound credentials. */
export class HostCredentialAdministrationGroup extends HttpApiGroup.make(
  "host.credentials",
)
  .add(
    HttpApiEndpoint.post("issueHostToken", "/hosts/:hostId/credentials", {
      params: HostPath,
      payload: IssueHostTokenHttpPayload,
      success: IssuedHostToken,
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.get("listHostTokens", "/hosts/:hostId/credentials", {
      params: HostPath,
      success: Schema.Array(HostToken),
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.delete(
      "revokeHostToken",
      "/hosts/:hostId/credentials/:credentialId",
      {
        params: HostCredentialPath,
        success: HostToken,
        error: errors,
      },
    ),
  )
  .middleware(RequireAuthenticatedHostCaller) {}

/** Shared declaration composed by Node and Cloudflare in their later slices. */
export class ControlPlaneHttpApi extends HttpApi.make("ptools-control-plane")
  .add(ControlPlaneClaimStatusGroup)
  .add(ControlPlaneAdministrationGroup)
  .add(HostCredentialAdministrationGroup) {}
