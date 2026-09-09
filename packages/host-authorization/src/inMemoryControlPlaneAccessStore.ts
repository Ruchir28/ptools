import { Effect, Layer, Option, SynchronizedRef } from "effect";
import {
  BuiltInControlPlaneRoles,
  ClaimInitialAdministratorRecordInput,
  ControlPlaneAccessInvariantViolation,
  ControlPlaneClaimRejected,
  ControlPlaneClaimStatus,
  ControlPlaneRolesNotFound,
  InitializeControlPlaneInput,
  LastControlPlaneAdministrator,
  Principal,
  PrincipalControlPlaneAccess,
  type ControlPlaneRole,
  type ControlPlaneRoleId as ControlPlaneRoleIdType,
  type ClaimInitialAdministratorError,
  type PrincipalId,
  type ReplacePrincipalControlPlaneRolesError,
  type ReplacePrincipalControlPlaneRolesInput,
} from "./contracts/index.js";
import { ControlPlaneAccessStore } from "./services/controlPlaneAccessStore.js";

interface UnclaimedState {
  readonly _tag: "Unclaimed";
  readonly setupCapabilityHash: InitializeControlPlaneInput["setupCapabilityHash"];
  readonly principals: ReadonlySet<PrincipalId>;
  readonly assignments: ReadonlyMap<
    PrincipalId,
    ReadonlySet<ControlPlaneRoleIdType>
  >;
}

interface ClaimedState {
  readonly _tag: "Claimed";
  readonly initialAdministratorId: PrincipalId;
  readonly claimedAtEpochMs: number;
  readonly principals: ReadonlySet<PrincipalId>;
  readonly assignments: ReadonlyMap<
    PrincipalId,
    ReadonlySet<ControlPlaneRoleIdType>
  >;
  readonly roles: ReadonlyMap<ControlPlaneRoleIdType, ControlPlaneRole>;
}

type State = Option.Option<UnclaimedState | ClaimedState>;

const projectAccess = (
  state: UnclaimedState | ClaimedState,
  principalId: PrincipalId,
): PrincipalControlPlaneAccess => {
  const assignments = state.assignments.get(principalId) ?? new Set();
  return PrincipalControlPlaneAccess.make({
    principalId,
    effectivePermissions:
      state._tag === "Claimed" &&
      assignments.has(BuiltInControlPlaneRoles.administrator.roleId)
        ? [...BuiltInControlPlaneRoles.administrator.permissions]
        : [],
  });
};

/**
 * Test/reference implementation of `ControlPlaneAccessStore` backed only by
 * process-local memory.
 *
 * Shared contract tests and consumers testing Effect composition create this
 * Layer when they need the real Control Plane mutation laws without installing
 * a platform database. Each Layer construction owns a fresh state reference;
 * all data disappears with that Effect runtime or process and cannot be shared
 * across processes, Workers, or Durable Object instances.
 *
 * This Layer is deliberately not a production persistence adapter. Node and
 * Cloudflare compositions must provide their platform-owned SQLite and D1
 * Layers instead. Within its limited lifetime, every multi-step mutation uses
 * one `SynchronizedRef` transition to model the atomic behavior those durable
 * adapters are required to preserve.
 */
export const InMemoryControlPlaneAccessStoreLayer: Layer.Layer<ControlPlaneAccessStore> =
  Layer.effect(
    ControlPlaneAccessStore,
    Effect.gen(function* () {
      const state = yield* SynchronizedRef.make<State>(Option.none());

      return ControlPlaneAccessStore.of({
        initialize: (input) =>
          SynchronizedRef.modify(state, (current) =>
            Option.match(current, {
              onNone: () =>
                [
                  true,
                  Option.some<UnclaimedState | ClaimedState>({
                    _tag: "Unclaimed",
                    setupCapabilityHash: input.setupCapabilityHash,
                    principals: new Set(),
                    assignments: new Map(),
                  }),
                ] as const,
              onSome: () => [false, current] as const,
            }),
          ),

        ensurePrincipal: (principal) =>
          SynchronizedRef.modifyEffect(state, (current) => {
            if (Option.isNone(current)) {
              return Effect.fail(
                new ControlPlaneAccessInvariantViolation({
                  operation: "ensurePrincipal",
                  message: "Control Plane has not been initialized",
                }),
              );
            }
            const next = {
              ...current.value,
              principals: new Set(current.value.principals).add(
                principal.principalId,
              ),
            };
            return Effect.succeed([
              Principal.make({ principalId: principal.principalId }),
              Option.some<UnclaimedState | ClaimedState>(next),
            ] as const);
          }),

        getClaimStatus: () =>
          SynchronizedRef.get(state).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.fail(
                    new ControlPlaneAccessInvariantViolation({
                      operation: "getClaimStatus",
                      message: "Control Plane has not been initialized",
                    }),
                  ),
                onSome: (current) =>
                  Effect.succeed(
                    current._tag === "Unclaimed"
                      ? ControlPlaneClaimStatus.make({ _tag: "Unclaimed" })
                      : ControlPlaneClaimStatus.make({
                          _tag: "Claimed",
                          initialAdministratorId:
                            current.initialAdministratorId,
                          claimedAtEpochMs: current.claimedAtEpochMs,
                        }),
                  ),
              }),
            ),
          ),

        claimInitialAdministrator: (input) =>
          SynchronizedRef.modifyEffect<
            State,
            PrincipalControlPlaneAccess,
            ClaimInitialAdministratorError,
            never
          >(state, (current) => {
            if (Option.isNone(current)) {
              return Effect.fail(
                new ControlPlaneAccessInvariantViolation({
                  operation: "claimInitialAdministrator",
                  message: "Control Plane has not been initialized",
                }),
              );
            }

            const existing = current.value;
            if (
              existing._tag === "Claimed" ||
              existing.setupCapabilityHash !== input.setupCapabilityHash
            ) {
              return Effect.fail(
                new ControlPlaneClaimRejected({
                  message: "Control Plane setup capability was rejected",
                }),
              );
            }

            // The shared catalog owns the Administrator's UUIDv5 identity.
            // A durable adapter inserts this exact logical ID while remaining
            // free to allocate and use a separate physical row key privately.
            const administratorRole = BuiltInControlPlaneRoles.administrator;
            const administratorRoleId = administratorRole.roleId;
            const principals = new Set(existing.principals).add(
              input.principalId,
            );
            const assignments = new Map(existing.assignments).set(
              input.principalId,
              new Set([administratorRoleId]),
            );
            const next: ClaimedState = {
              _tag: "Claimed",
              initialAdministratorId: input.principalId,
              claimedAtEpochMs: input.claimedAtEpochMs,
              principals,
              assignments,
              roles: new Map([[administratorRoleId, administratorRole]]),
            };
            return Effect.succeed([
              projectAccess(next, input.principalId),
              Option.some<UnclaimedState | ClaimedState>(next),
            ] as const);
          }),

        resolvePermissions: (input) =>
          SynchronizedRef.get(state).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.fail(
                    new ControlPlaneAccessInvariantViolation({
                      operation: "resolvePermissions",
                      message: "Control Plane has not been initialized",
                    }),
                  ),
                onSome: (current) =>
                  Effect.succeed(projectAccess(current, input.principalId)),
              }),
            ),
          ),

        replaceRoles: (input) => replaceRoles(state, input),
      });
    }),
  );

const replaceRoles = (
  state: SynchronizedRef.SynchronizedRef<State>,
  input: ReplacePrincipalControlPlaneRolesInput,
): Effect.Effect<
  PrincipalControlPlaneAccess,
  ReplacePrincipalControlPlaneRolesError
> =>
  SynchronizedRef.modifyEffect<
    State,
    PrincipalControlPlaneAccess,
    ReplacePrincipalControlPlaneRolesError,
    never
  >(state, (current) => {
    if (Option.isNone(current)) {
      return Effect.fail(
        new ControlPlaneAccessInvariantViolation({
          operation: "replaceRoles",
          message: "Control Plane has not been initialized",
        }),
      );
    }

    const existing = current.value;
    if (existing._tag !== "Claimed") {
      return Effect.fail(
        new ControlPlaneAccessInvariantViolation({
          operation: "replaceRoles",
          message: "Control Plane has not been claimed",
        }),
      );
    }

    const unknown = input.roleIds.filter(
      (roleId) => !existing.roles.has(roleId),
    );
    if (unknown.length > 0) {
      return Effect.fail(
        new ControlPlaneRolesNotFound({
          roleIds: unknown,
          message: "one or more Control Plane roles do not exist",
        }),
      );
    }

    const replacement = new Set(input.roleIds);
    const assignments = new Map(existing.assignments).set(
      input.principalId,
      replacement,
    );
    const administrators = [...assignments.values()].filter((roles) =>
      roles.has(BuiltInControlPlaneRoles.administrator.roleId),
    ).length;
    if (administrators === 0) {
      return Effect.fail(
        new LastControlPlaneAdministrator({
          message: "at least one Control Plane Administrator must remain",
        }),
      );
    }

    const next = {
      ...existing,
      principals: new Set(existing.principals).add(input.principalId),
      assignments,
    };
    return Effect.succeed([
      projectAccess(next, input.principalId),
      Option.some<UnclaimedState | ClaimedState>(next),
    ] as const);
  });
