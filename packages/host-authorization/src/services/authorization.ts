import { Context, Effect, HashSet, Layer } from "effect";
import {
  ControlPlanePermissions,
  HostPermission,
  type ControlPlanePermission,
  type HostPermission as HostPermissionValue,
  type Principal,
  ResolvePrincipalControlPlaneAccessInput,
  ResolvePrincipalHostAccessInput,
} from "../contracts/index.js";
import type {
  ResolvePrincipalControlPlaneAccessError,
} from "../contracts/controlPlaneAccessOperations/index.js";
import type { ResolvePrincipalHostAccessError } from "../contracts/hostAccessOperations/index.js";
import { ControlPlaneAccessStore } from "./controlPlaneAccessStore.js";
import { HostAccessStore } from "./hostAccessStore.js";

export type ResolveHostPermissionsError =
  | ResolvePrincipalControlPlaneAccessError
  | ResolvePrincipalHostAccessError;

/**
 * Resolves current role-derived authority for durable Principals only.
 * Verified Host tokens bypass this service and contribute their frozen grants
 * directly at request admission.
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
