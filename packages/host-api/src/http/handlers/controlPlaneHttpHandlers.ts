/** Shared handlers for bootstrap and global Control Plane administration. */
import {
  ControlPlanePermissions,
  IssueHostTokenInput,
  ListAllHostTokensInput,
  ListHostTokensInput,
  ReplaceControlPlaneRolesInput,
  RevokeHostTokenInput,
} from "@ptools/host-authorization/contracts";
import {
  ControlPlaneAdministration,
  ControlPlaneBootstrap,
  HostPolicies,
  HostTokenPolicies,
  HostTokenService,
} from "@ptools/host-authorization/effect";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import {
  HostHttpConflict,
  HostHttpForbidden,
  HostHttpInternalError,
  HostHttpNotFound,
} from "../../contracts/hostHttpErrors.js";
import { ControlPlaneHttpApi } from "../api/controlPlaneHttpApi.js";
import {
  withControlPlaneAuthorization,
  withPrincipalCaller,
  withPrincipalHostAuthorization,
} from "../../services/hostAuthorizationAdmission.js";

export const ControlPlaneClaimStatusHandlers = HttpApiBuilder.group(
  ControlPlaneHttpApi,
  "control-plane.claim-status",
  (handlers) =>
    handlers.handle("getClaimStatus", () =>
      Effect.gen(function* () {
        const bootstrap = yield* ControlPlaneBootstrap;
        return yield* bootstrap.getClaimStatus();
      }).pipe(Effect.mapError(toControlPlaneHttpError)),
    ),
);

export const ControlPlaneAdministrationHandlers = HttpApiBuilder.group(
  ControlPlaneHttpApi,
  "control-plane.administration",
  (handlers) =>
    handlers
      .handle("claimInitialAdministrator", (ctx) =>
        withPrincipalCaller((caller) =>
          Effect.gen(function* () {
            const bootstrap = yield* ControlPlaneBootstrap;
            return yield* bootstrap.claimInitialAdministrator(
              ctx.payload,
              caller,
            );
          }),
        ).pipe(Effect.mapError(toControlPlaneHttpError)),
      )
      .handle("createHost", (ctx) =>
        withControlPlaneAuthorization(
          ControlPlanePermissions.hosts.create,
          (creator) =>
            Effect.gen(function* () {
              const administration = yield* ControlPlaneAdministration;
              return yield* administration.createHost(ctx.payload, creator);
            }),
        ).pipe(Effect.mapError(toControlPlaneHttpError)),
      )
      .handle("listHosts", () =>
        withPrincipalCaller((caller) =>
          Effect.gen(function* () {
            const administration = yield* ControlPlaneAdministration;
            return yield* administration.listHosts(caller);
          }),
        ).pipe(Effect.mapError(toControlPlaneHttpError)),
      )
      .handle("listAllHostTokens", () =>
        withControlPlaneAuthorization(
          ControlPlanePermissions.hosts.administer,
          () =>
            Effect.gen(function* () {
              const tokens = yield* HostTokenService;
              return yield* tokens.listAll(ListAllHostTokensInput.make({}));
            }),
        ).pipe(Effect.mapError(toControlPlaneHttpError)),
      )
      .handle("replaceControlPlaneRoles", (ctx) =>
        withControlPlaneAuthorization(
          ControlPlanePermissions.access.manage,
          (assigner) =>
            Effect.gen(function* () {
              const administration = yield* ControlPlaneAdministration;
              return yield* administration.replaceControlPlaneRoles(
                ReplaceControlPlaneRolesInput.make({
                  principalId: ctx.params.principalId,
                  roleIds: ctx.payload.roleIds,
                }),
                assigner,
              );
            }),
        ).pipe(Effect.mapError(toControlPlaneHttpError)),
      ),
);

export const HostCredentialAdministrationHandlers = HttpApiBuilder.group(
  ControlPlaneHttpApi,
  "host.credentials",
  (handlers) =>
    handlers
      .handle("issueHostToken", (ctx) =>
        withPrincipalHostAuthorization(
          {
            hostId: ctx.params.hostId,
            // Build a request-specific policy: the issuer must be allowed to
            // manage tokens and must personally hold every grant they are
            // attempting to place in the new token.
            policy: HostTokenPolicies.issue(ctx.payload.grantedPermissions),
          },
          (issuer) =>
            Effect.gen(function* () {
              const tokens = yield* HostTokenService;
              return yield* tokens.issue(
                IssueHostTokenInput.make({
                  hostId: ctx.params.hostId,
                  name: ctx.payload.name,
                  grantedPermissions: ctx.payload.grantedPermissions,
                  expiresAtEpochMs: ctx.payload.expiresAtEpochMs,
                }),
                issuer,
              );
            }),
        ).pipe(Effect.mapError(toControlPlaneHttpError)),
      )
      .handle("listHostTokens", (ctx) =>
        withPrincipalHostAuthorization(
          { hostId: ctx.params.hostId, policy: HostPolicies.manageTokens },
          () =>
            Effect.gen(function* () {
              const tokens = yield* HostTokenService;
              return yield* tokens.listByHost(
                ListHostTokensInput.make({ hostId: ctx.params.hostId }),
              );
            }),
        ).pipe(Effect.mapError(toControlPlaneHttpError)),
      )
      .handle("revokeHostToken", (ctx) =>
        withPrincipalHostAuthorization(
          { hostId: ctx.params.hostId, policy: HostTokenPolicies.revoke },
          (revoker) =>
            Effect.gen(function* () {
              const tokens = yield* HostTokenService;
              return yield* tokens.revoke(
                RevokeHostTokenInput.make({
                  hostId: ctx.params.hostId,
                  tokenId: ctx.params.credentialId,
                }),
                revoker,
              );
            }),
        ).pipe(Effect.mapError(toControlPlaneHttpError)),
      ),
);

/**
 * Projects domain failures to stable public status classes without serializing
 * storage, crypto, or invariant details. Platform logs may retain typed causes
 * inside their trusted boundary.
 */
const toControlPlaneHttpError = (error: { readonly _tag?: string }) => {
  switch (error._tag) {
    case "ControlPlaneClaimRejected":
    case "ControlPlaneAuthorizationDenied":
    case "PrincipalCallerRequired":
    case "HostAuthorizationDenied":
      return new HostHttpForbidden({ message: "operation was not permitted" });
    case "LastControlPlaneAdministrator":
    case "RegisteredHostAlreadyExists":
      return new HostHttpConflict({
        message: "requested mutation conflicts with current state",
      });
    case "HostTokenNotFound":
      return new HostHttpNotFound({ message: "Host credential was not found" });
    default:
      return new HostHttpInternalError({
        message: "Control Plane operation failed",
      });
  }
};
