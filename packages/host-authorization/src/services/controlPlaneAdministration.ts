import { Context, Effect, Layer } from "effect";
import {
  ControlPlanePermissions,
  CreateOwnedHostInput,
  ListPrincipalHostsInput,
  ListRegisteredHostsInput,
  ReplacePrincipalControlPlaneRolesInput,
  ResolvePrincipalControlPlaneAccessInput,
  type CreateOwnedHostError,
  type CreatedOwnedHost,
  type CreateRegisteredHostInput,
  type ListHostsInput,
  type ListPrincipalHostsError,
  type ListRegisteredHostsError,
  type PrincipalControlPlaneAccess,
  type PrincipalCaller,
  type ResolvePrincipalControlPlaneAccessError,
  type ReplaceControlPlaneRolesInput,
  type ReplacePrincipalControlPlaneRolesError,
} from "../contracts/index.js";
import type { RegisteredHostPagination } from "../contracts/registeredHostPagination.js";
import { ControlPlaneAccessStore } from "./controlPlaneAccessStore.js";
import { HostAccessStore } from "./hostAccessStore.js";

/**
 * Shared trusted administration workflows that combine caller-authored input
 * with the exact Principal admitted by the Host API. Public payloads therefore
 * cannot choose creator or assignment-audit identities.
 *
 * Like `ControlPlaneBootstrap`, this service is storage-free orchestration: it
 * resolves permissions, scopes results, and stamps verified identity, then
 * delegates every mutation — including its law — to
 * `ControlPlaneAccessStore` or `HostAccessStore`. Permission *gating* lives
 * upstream in admission (e.g. Host API handlers wrapping these calls with
 * `withControlPlaneAuthorization`); the one exception is `listHosts`, whose
 * result scope is a workflow decision made here on already-resolved facts.
 */
export class ControlPlaneAdministration extends Context.Service<ControlPlaneAdministration>()(
  "@ptools/host-authorization/ControlPlaneAdministration",
  {
    make: Effect.gen(function* () {
      const controlPlane = yield* ControlPlaneAccessStore;
      const hosts = yield* HostAccessStore;

      /**
       * Creates a new Host identity in the central access catalog — the entry
       * (and its ID) must not already exist. "Registering" and "creating" are
       * the same act here: there is no pre-existing Host being attached to.
       * The same atomic transition also creates the creator's membership with
       * the built-in owner role, so the Host is born with its first authority
       * grant, exactly as the initial claim grants Administrator. The owner
       * identity comes from the admission-verified `PrincipalCaller`, never
       * from the payload; callers may only mint hosts they own.
       * `HostAccessStore.createOwnedHost` owns this creation law.
       */
      const createHost = (
        input: CreateRegisteredHostInput,
        creator: PrincipalCaller,
      ): Effect.Effect<CreatedOwnedHost, CreateOwnedHostError> =>
        hosts.createOwnedHost(
          CreateOwnedHostInput.make({
            requestedHostId: input.requestedHostId,
            ownerPrincipalId: creator.principalId,
          }),
        );

      /**
       * Lists Hosts with a caller-dependent scope: Principals holding
       * `ControlPlanePermissions.hosts.list` see every registered Host;
       * everyone else sees only Hosts they own. The scope decision is made
       * here from permissions already resolved by the store — this is a pure
       * branch over stored facts, not a mutation, so unlike the claim it needs
       * no atomicity and stays in shared code. Callers without any Host
       * visibility simply receive an empty list rather than an error, keeping
       * existence of other Principals' hosts undisclosed.
       */
      const listHosts = (
        input: ListHostsInput,
        caller: PrincipalCaller,
      ): Effect.Effect<
        RegisteredHostPagination.Page,
        | ResolvePrincipalControlPlaneAccessError
        | ListRegisteredHostsError
        | ListPrincipalHostsError
      > =>
        controlPlane
          .resolvePermissions(
            ResolvePrincipalControlPlaneAccessInput.make({
              principalId: caller.principalId,
            }),
          )
          .pipe(
            Effect.flatMap((access) =>
              access.effectivePermissions.includes(
                ControlPlanePermissions.hosts.list,
              )
                ? hosts.listRegisteredHosts(
                    ListRegisteredHostsInput.make({
                      limit: input.limit,
                      cursor: input.cursor,
                    }),
                  )
                : hosts.listPrincipalHosts(
                    ListPrincipalHostsInput.make({
                      principalId: caller.principalId,
                      limit: input.limit,
                      cursor: input.cursor,
                    }),
                  ),
            ),
          );

      /**
       * Replaces one Principal's Control Plane role assignments. The audit
       * identity (`assignedByPrincipalId`) comes from the admission-verified
       * assigner, never from the payload. Whether the caller may manage
       * assignments at all was already enforced upstream by admission; the
       * replacement itself — including the last-Administrator safety law — is
       * one atomic transition owned by `ControlPlaneAccessStore.replaceRoles`.
       */
      const replaceControlPlaneRoles = (
        input: ReplaceControlPlaneRolesInput,
        assigner: PrincipalCaller,
      ): Effect.Effect<
        PrincipalControlPlaneAccess,
        ReplacePrincipalControlPlaneRolesError
      > =>
        controlPlane.replaceRoles(
          ReplacePrincipalControlPlaneRolesInput.make({
            principalId: input.principalId,
            roleIds: input.roleIds,
            assignedByPrincipalId: assigner.principalId,
          }),
        );

      return { createHost, listHosts, replaceControlPlaneRoles } as const;
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make);
}
