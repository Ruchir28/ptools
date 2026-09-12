import { Context, Effect, HashSet, Layer } from "effect";
import {
  ControlPlanePermissions,
  GetRegisteredHostInput,
  HostPermission,
  type ControlPlanePermission,
  type HostPermission as HostPermissionValue,
  type Principal,
  ResolvePrincipalControlPlaneAccessInput,
  ResolvePrincipalHostAccessInput,
} from "../contracts/index.js";
import type { ResolvePrincipalControlPlaneAccessError } from "../contracts/controlPlaneAccessOperations/index.js";
import type { ResolvePrincipalHostAccessError } from "../contracts/hostAccessOperations/index.js";
import { ControlPlaneAccessStore } from "./controlPlaneAccessStore.js";
import { HostAccessStore } from "./hostAccessStore.js";

export type ResolveHostPermissionsError =
  | ResolvePrincipalControlPlaneAccessError
  | ResolvePrincipalHostAccessError;

/**
 * Resolves current role-derived authority for durable Principals only.
 *
 * Host permission resolution also proves that the requested Host is registered.
 * Ordinary Principals receive that proof from membership resolution itself;
 * global Administrators require an explicit registration lookup before the
 * all-permissions shortcut. This branch-specific placement performs one
 * existence read rather than adding a redundant common read, while ensuring
 * Administrator authority applies to every registered Host—not to arbitrary
 * runtime namespace strings.
 *
 * Verified Host tokens bypass this service and contribute their frozen grants
 * directly at request admission, where their separate registration proof lives.
 */
export class Authorization extends Context.Service<Authorization>()(
  "@ptools/host-authorization/Authorization",
  {
    make: Effect.gen(function* () {
      const controlPlane = yield* ControlPlaneAccessStore;
      const hosts = yield* HostAccessStore;

      const resolveControlPlanePermissions = (
        principal: Principal,
      ): Effect.Effect<
        HashSet.HashSet<ControlPlanePermission>,
        ResolvePrincipalControlPlaneAccessError
      > =>
        controlPlane
          .resolvePermissions(
            ResolvePrincipalControlPlaneAccessInput.make({
              principalId: principal.principalId,
            }),
          )
          .pipe(
            Effect.map((access) =>
              HashSet.fromIterable(access.effectivePermissions),
            ),
          );

      const resolveHostPermissions = (
        principal: Principal,
        hostId: string,
      ): Effect.Effect<
        HashSet.HashSet<HostPermissionValue>,
        ResolveHostPermissionsError
      > =>
        Effect.gen(function* () {
          const global = yield* resolveControlPlanePermissions(principal);
          if (HashSet.has(global, ControlPlanePermissions.hosts.administer)) {
            yield* hosts.getRegisteredHost(
              GetRegisteredHostInput.make({ hostId }),
            );
            return HashSet.fromIterable(HostPermission.literals);
          }

          const access = yield* hosts.resolvePrincipalHostAccess(
            ResolvePrincipalHostAccessInput.make({
              principalId: principal.principalId,
              hostId,
            }),
          );
          return HashSet.fromIterable(access.effectivePermissions);
        });

      return {
        resolveControlPlanePermissions,
        resolveHostPermissions,
      } as const;
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make);
}
