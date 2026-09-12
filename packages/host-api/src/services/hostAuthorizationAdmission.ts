import {
  HostAuthorizationContext,
  type HostPolicy,
  Authorization,
  HostAccessStore,
  withPolicy,
} from "@ptools/host-authorization/effect";
import {
  GetRegisteredHostInput,
  Principal,
  type ControlPlanePermission,
  type PrincipalCaller,
  type VerifiedHostToken,
} from "@ptools/host-authorization/contracts";
import { Context, Effect, HashSet, Schema } from "effect";

/**
 * The two credential kinds that can reach Host API admission, tagged so
 * admission can branch on them without re-inspecting the credential.
 *
 * The branches differ in authority lifecycle, which is the whole reason they
 * are a union rather than one shape:
 *
 * - `Principal` carries durable identity only. Its authority is resolved
 *   fresh on every request by `Authorization.resolveHostPermissions`, so role
 *   changes take effect immediately, and a global Control Plane Administrator
 *   is honored here.
 * - `HostToken` carries the effective permission set frozen at mint time for
 *   exactly one Host. No store lookup can change it, the token has no Control
 *   Plane identity, so global Administrator authority never applies to it.
 *
 * Created by platform adapters after credential proof; consumed by admission
 * helpers in this file. Never forwarded across the dispatch boundary.
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

/**
 * Request-scoped, verified caller consumed by shared authorization admission.
 *
 * This is the seam between authentication and admission: platform adapters
 * prove the HTTP/stdio/RPC credential and store the result here; admission
 * helpers in this file read it to resolve authority. It holds *who* was
 * verified, not *what they may do* — that is `HostAuthorizationContext`, built
 * later by `withHostAuthorization` and consumed by policies. Conflating the
 * two would let handlers trust un-resolved grants.
 */
export class AuthenticatedHostCallerContext extends Context.Service<
  AuthenticatedHostCallerContext,
  AuthenticatedHostCaller
>()("@ptools/host-api/AuthenticatedHostCallerContext") {}

/**
 * A verified Host token was presented on a route for a different Host.
 *
 * A Host token is minted for exactly one `hostId`; presenting it elsewhere is
 * an agreement failure between the verified credential and the route, kept
 * distinct from authorization denial (`HostAuthorizationDenied`) so callers
 * and audits can tell "wrong door" from "not allowed here". Admission fails
 * fast before any registration or store read.
 */
export class HostTokenRouteMismatch extends Schema.TaggedErrorClass<HostTokenRouteMismatch>()(
  "HostTokenRouteMismatch",
  { message: Schema.NonEmptyString },
) {}

/**
 * An operation requiring a durable Principal caller received a Host token.
 *
 * Host tokens carry frozen, host-scoped grants and no Control Plane identity,
 * so they cannot stand in for a Principal on routes that need durable
 * identity (`withPrincipalCaller`, `withControlPlaneAuthorization`) or on
 * administrative Host work (`withPrincipalHostAuthorization`). This is a
 * credential-kind mismatch, not an authorization denial.
 */
export class PrincipalCallerRequired extends Schema.TaggedErrorClass<PrincipalCallerRequired>()(
  "PrincipalCallerRequired",
  { message: Schema.NonEmptyString },
) {}

/**
 * An authenticated Principal lacks the requested global Control Plane
 * permission.
 *
 * Reported by `withControlPlaneAuthorization` only, after the Principal's
 * current Control Plane permissions were resolved. `requiredPermission` names
 * the missing grant so the caller can report exactly what was denied. This is
 * about global authority; Host-scoped denial is `HostAuthorizationDenied`.
 */
export class ControlPlaneAuthorizationDenied extends Schema.TaggedErrorClass<ControlPlaneAuthorizationDenied>()(
  "ControlPlaneAuthorizationDenied",
  { requiredPermission: Schema.String, message: Schema.NonEmptyString },
) {}

/**
 * Admits one authenticated caller to registered Host-scoped work.
 *
 * Runtime flow of the composed Effect, in order:
 *
 * 1. read the verified caller from `AuthenticatedHostCallerContext`;
 * 2. resolve authority for the route's `hostId`, branching on credential kind:
 *    - `Principal`: `Authorization.resolveHostPermissions` resolves fresh
 *      permissions and already proves registration (including for global
 *      Control Plane Administrators, whom it grants every Host permission on
 *      registered Hosts). No second registration read is performed here.
 *    - `HostToken`: reject a token-to-route `hostId` mismatch
 *      (`HostTokenRouteMismatch`), then read `HostAccessStore` to prove the
 *      Host is still registered — token grants are frozen, so agreement alone
 *      does not rule out a deregistered Host. Grants come from the token,
 *      never from a store lookup.
 * 3. build the request-local `HostAuthorizationContext`;
 * 4. run `options.policy` against that context;
 * 5. only on policy success, run the Effect returned by `use`.
 *
 * Step 2 precedes policy and protected work in every branch so that neither
 * global Administrator authority nor a stale matching token can activate an
 * unregistered Host namespace. A policy denial short-circuits before `use`
 * starts, so protected work never observes a partially admitted request.
 *
 * `policy` and `use` are lazy Effect values: nothing here executes until the
 * composed Effect runs, and `use` must remain a lazy constructor with no eager
 * JavaScript side effects.
 *
 * Consumed directly by Host API handlers, and via
 * `withPrincipalHostAuthorization` when a durable Principal is required.
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

          const hosts = yield* HostAccessStore;
          yield* hosts.getRegisteredHost(
            GetRegisteredHostInput.make({ hostId: options.hostId }),
          );

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

/**
 * Refines the verified caller to a durable Principal without asserting any
 * authority.
 *
 * Deliberately narrower than the `withHostAuthorization` family: it checks the
 * credential *kind* only — no Host registration, no permission resolution, no
 * policy — so it suits routes like "list my own resources" where any
 * authenticated Principal may proceed. A Host token fails with
 * `PrincipalCallerRequired` because tokens have no durable identity, not
 * because their grants are insufficient.
 */
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

/**
 * Checks current global Control Plane authority before protected work runs.
 *
 * This is the admission helper that *demands* a global permission such as
 * `hosts.administer`. It requires a durable Principal, resolves the caller's
 * current Control Plane permissions, and fails with
 * `ControlPlaneAuthorizationDenied` when the required permission is absent.
 *
 * Distinct from `Authorization.resolveHostPermissions`, which *consumes* the
 * Administrator grant to widen Host-scoped permissions: here holding the
 * permission is the entry condition for the route itself. Host tokens are
 * rejected up front — they have no Control Plane identity.
 */
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
 * `withHostAuthorization`, which resolves the Principal's current Host grants
 * (including global Administrator escalation), supplies
 * `HostAuthorizationContext`, and runs `options.policy`. Only after that
 * policy succeeds can the Effect returned by `use` perform work. The admitted
 * `PrincipalCaller` is passed separately for audit fields and trusted service
 * inputs; policies inspect normalized permissions rather than that identity
 * value. Use this instead of `withHostAuthorization` for Host-scoped work that
 * must never run under a machine token, such as member or lifecycle changes.
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
