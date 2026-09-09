import {
  HostPermission,
  HostPermissions,
  type HostPermission as HostPermissionValue,
} from "../contracts/index.js";
import { Effect, HashSet, Schema } from "effect";
import type { HostTokenPermissionSelection } from "../contracts/hostToken.js";
import { HostAuthorizationContext } from "./hostAuthorizationContext.js";

/**
 * Typed failure returned when a Host permission policy rejects a request.
 *
 * Admission and HTTP adapters use this error to distinguish an authenticated
 * caller who lacks authority from authentication, storage, and transport
 * failures. `requiredPermission` is present for catalog-backed permission
 * checks so callers can report exactly which grant was missing.
 */
export class HostAuthorizationDenied extends Schema.TaggedErrorClass<HostAuthorizationDenied>()(
  "HostAuthorizationDenied",
  {
    hostId: Schema.NonEmptyString,
    requiredPermission: Schema.optional(HostPermission),
  },
) {}

/**
 * A lazy, storage-free authorization check for one admitted Host request.
 *
 * This is an Effect value rather than a callback. Constructing or passing a
 * policy does not check anything. When executed, it reads the request-local
 * `HostAuthorizationContext` supplied by the Host API admission layer and
 * either succeeds with `void` or fails with `HostAuthorizationDenied`.
 */
export type HostPolicy = Effect.Effect<
  void,
  HostAuthorizationDenied,
  HostAuthorizationContext
>;

/**
 * Builds a lazy policy requiring one canonical Host permission.
 *
 * The returned Effect does not run here. At admission time it reads the
 * caller's already-resolved effective permissions from
 * `HostAuthorizationContext`. It succeeds when `required` is present and fails
 * with a denial naming that permission otherwise.
 */
export const permission = (required: HostPermissionValue): HostPolicy =>
  Effect.gen(function* () {
    const context = yield* HostAuthorizationContext;
    if (!HashSet.has(context.effectivePermissions, required)) {
      return yield* new HostAuthorizationDenied({
        hostId: context.hostId,
        requiredPermission: required,
      });
    }
  });

type NonEmptyPolicies = readonly [HostPolicy, ...ReadonlyArray<HostPolicy>];

/**
 * Combines policies with AND semantics for compound admission rules.
 *
 * Policies execute in declaration order. Evaluation stops at the first denial,
 * so the returned failure identifies the first unmet requirement. Token
 * issuance uses this to require token-management authority plus every grant
 * requested for the new token.
 */
export const all = (...policies: NonEmptyPolicies): HostPolicy =>
  Effect.all(policies, { concurrency: 1, discard: true });

/**
 * Sequences a policy before a protected Effect.
 *
 * `requiredPolicy` and `operation` are lazy Effect values. When the combined
 * Effect executes, the policy runs first; a denial short-circuits the sequence,
 * while success starts `operation`. The caller must provide the
 * `HostAuthorizationContext` required by the policy to the combined Effect.
 *
 * This is curried for pipeline use:
 * `operation.pipe(withPolicy(HostPolicies.execute))`.
 */
export const withPolicy =
  (requiredPolicy: HostPolicy) =>
  <A, E, R>(operation: Effect.Effect<A, E, R>) =>
    Effect.andThen(requiredPolicy, operation);

/**
 * Canonical named policies consumed by Host API admission.
 *
 * Each entry is a pre-built, still-lazy `HostPolicy` tied to exactly one value
 * from `HostPermissions`; the catalog contains no caller grants or mutable
 * state. Handlers pass an entry to `withHostAuthorization`, which supplies the
 * current request context and executes it before protected work.
 */
export const HostPolicies = {
  readHost: permission(HostPermissions.host.read),
  execute: permission(HostPermissions.host.execute),
  configure: permission(HostPermissions.host.configure),
  deleteHost: permission(HostPermissions.host.delete),
  manageSecrets: permission(HostPermissions.secrets.manage),
  readAuth: permission(HostPermissions.auth.read),
  manageAuth: permission(HostPermissions.auth.manage),
  manageTokens: permission(HostPermissions.tokens.manage),
  manageMembers: permission(HostPermissions.members.manage),
} as const;

/**
 * Policies for the Host API admission layer, not for `HostTokenService` itself.
 * Issuance requires `tokens:manage` plus every permission being delegated, so a
 * user cannot mint authority they do not currently hold. Revocation requires
 * only `tokens:manage`. Admission resolves current Principal access, provides
 * `HostAuthorizationContext`, runs one of these policies, and only then passes
 * the admitted `PrincipalCaller` to the trusted lifecycle method.
 */
export const HostTokenPolicies = {
  /**
   * Builds the policy for one token-issuance request.
   *
   * The issuer must have `tokens:manage` and every permission in `selection`.
   * For example, requesting `[host.read, host.execute]` builds the equivalent
   * of `all(tokens.manage, host.read, host.execute)`. This prevents a Principal
   * from minting a token with authority the Principal does not possess.
   * Building this value does not execute the checks; Host API admission runs
   * the returned Effect against the issuer's resolved Host permissions.
   */
  issue: (selection: HostTokenPermissionSelection): HostPolicy =>
    all(HostPolicies.manageTokens, ...selection.map(permission)),

  /** Requires token-management authority without checking delegated grants. */
  revoke: HostPolicies.manageTokens,
} as const;
