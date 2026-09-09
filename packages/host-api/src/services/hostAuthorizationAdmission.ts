import {
  HostAuthorizationContext,
  type HostPolicy,
  Authorization,
  withPolicy,
} from "@ptools/host-authorization/effect";
import {
  Principal,
  type ControlPlanePermission,
  type PrincipalCaller,
  type VerifiedHostToken,
} from "@ptools/host-authorization/contracts";
import { Context, Effect, HashSet, Schema } from "effect";

/**
 * Request-local result of credential verification. Principal callers retain
 * durable identity; Host tokens retain the immutable grants needed by admission.
 */
export type AuthenticatedHostCaller =
  | {
      readonly _tag: "Principal";
      readonly caller: PrincipalCaller;
    }
  | {
      readonly _tag: "HostToken";
      readonly token: VerifiedHostToken;
    };

export class AuthenticatedHostCallerContext extends Context.Service<
  AuthenticatedHostCallerContext,
  AuthenticatedHostCaller
>()("@ptools/host-api/AuthenticatedHostCallerContext") {}

/** A Host-bound credential was presented against a different route Host. */
export class HostTokenRouteMismatch extends Schema.TaggedErrorClass<HostTokenRouteMismatch>()(
  "HostTokenRouteMismatch",
  { message: Schema.NonEmptyString },
) {}

/** An operation requiring a durable Principal caller received a Host token. */
export class PrincipalCallerRequired extends Schema.TaggedErrorClass<PrincipalCallerRequired>()(
  "PrincipalCallerRequired",
  { message: Schema.NonEmptyString },
) {}

/** A Principal lacks the requested global Control Plane permission. */
export class ControlPlaneAuthorizationDenied extends Schema.TaggedErrorClass<ControlPlaneAuthorizationDenied>()(
  "ControlPlaneAuthorizationDenied",
  { requiredPermission: Schema.String, message: Schema.NonEmptyString },
) {}

/**
 * Admits one authenticated caller to Host-scoped work.
 *
 * The caller supplies the route's `hostId`, a lazy `HostPolicy`, and a callback
 * that constructs the protected Effect. For a Principal credential, admission
 * resolves current Host permissions through `Authorization`; for a Host token,
 * it first rejects a token bound to another Host and then uses the token's
 * verified immutable grants. Both paths produce the same request-local
 * `HostAuthorizationContext`.
 *
 * Admission provides that context to `options.policy` and sequences the policy
 * before the Effect returned by `use`. Executing the composed Effect therefore
 * follows `resolve authority -> check policy -> run protected work`; denial
 * prevents the protected Effect's work from running. `use` must remain a lazy
 * Effect constructor and must not perform eager JavaScript side effects.
 */
export const withHostAuthorization = <A, E, R>(
  options: { readonly hostId: string; readonly policy: HostPolicy },
  use: () => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const authenticated = yield* AuthenticatedHostCallerContext;
    const authorization = yield* Authorization;

    const context = yield* authenticated._tag === "Principal"
      ? authorization
          .resolveHostPermissions(
            Principal.make({
              principalId: authenticated.caller.principalId,
            }),
            options.hostId,
          )
          .pipe(
            Effect.map((effectivePermissions) =>
              HostAuthorizationContext.of({
                hostId: options.hostId,
                caller: authenticated.caller,
                effectivePermissions,
              }),
            ),
          )
      : Effect.gen(function* () {
          if (authenticated.token.principal.hostId !== options.hostId) {
            return yield* new HostTokenRouteMismatch({
              message: "Host token is not valid for the requested Host",
            });
          }
          return HostAuthorizationContext.of({
            hostId: options.hostId,
            caller: authenticated.token.principal,
            effectivePermissions: HashSet.fromIterable(
              authenticated.token.effectivePermissions,
            ),
          });
        });

    return yield* withPolicy(options.policy)(use()).pipe(
      Effect.provideService(HostAuthorizationContext, context),
    );
  });

/** Refines authentication without asserting Host or Control Plane authority. */
export const withPrincipalCaller = <A, E, R>(
  use: (caller: PrincipalCaller) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const authenticated = yield* AuthenticatedHostCallerContext;
    if (authenticated._tag !== "Principal") {
      return yield* new PrincipalCallerRequired({
        message: "this operation requires an authenticated Principal caller",
      });
    }
    return yield* use(authenticated.caller);
  });

/** Checks current global authority before starting Control Plane work. */
export const withControlPlaneAuthorization = <A, E, R>(
  requiredPermission: ControlPlanePermission,
  use: (caller: PrincipalCaller) => Effect.Effect<A, E, R>,
) =>
  withPrincipalCaller((caller) =>
    Effect.gen(function* () {
      const authorization = yield* Authorization;
      const permissions = yield* authorization.resolveControlPlanePermissions(
        Principal.make({ principalId: caller.principalId }),
      );
      if (!HashSet.has(permissions, requiredPermission)) {
        return yield* new ControlPlaneAuthorizationDenied({
          requiredPermission,
          message: "Control Plane permission was denied",
        });
      }
      return yield* use(caller);
    }),
  );

/**
 * Admits only a durable Principal to Host-scoped administrative work.
 *
 * This rejects Host-token callers before delegating to
 * `withHostAuthorization`, which resolves the Principal's current Host grants,
 * supplies `HostAuthorizationContext`, and runs `options.policy`. Only after
 * that policy succeeds can the Effect returned by `use` perform work. The
 * admitted `PrincipalCaller` is passed separately for audit fields and trusted
 * service inputs; policies inspect normalized permissions rather than that
 * identity value.
 */
export const withPrincipalHostAuthorization = <A, E, R>(
  options: { readonly hostId: string; readonly policy: HostPolicy },
  use: (caller: PrincipalCaller) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const authenticated = yield* AuthenticatedHostCallerContext;
    if (authenticated._tag !== "Principal") {
      return yield* new PrincipalCallerRequired({
        message: "this operation requires an authenticated Principal caller",
      });
    }
    return yield* withHostAuthorization(options, () =>
      use(authenticated.caller),
    );
  });
