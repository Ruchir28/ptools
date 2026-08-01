import {
  HostPermission,
  HostPermissions,
  type HostPermission as HostPermissionValue,
} from "../contracts/index.js";
import { Effect, HashSet, Schema } from "effect";
import { HostAuthorizationContext } from "./hostAuthorizationContext.js";

/** Expected denial produced when a code-owned host policy does not pass. */
export class HostAuthorizationDenied extends Schema.TaggedErrorClass<HostAuthorizationDenied>()(
  "HostAuthorizationDenied",
  {
    hostId: Schema.NonEmptyString,
    requiredPermission: Schema.optional(HostPermission),
  },
) {}

/** Storage-free authorization check evaluated against the current request. */
export type HostPolicy = Effect.Effect<
  void,
  HostAuthorizationDenied,
  HostAuthorizationContext
>;

type HostAuthorizationPredicate = (
  context: HostAuthorizationContext["Service"],
) => boolean;

const makePolicy = (
  predicate: HostAuthorizationPredicate,
  requiredPermission?: HostPermissionValue,
): HostPolicy =>
  Effect.gen(function* () {
    const context = yield* HostAuthorizationContext;
    if (!predicate(context)) {
      return yield* new HostAuthorizationDenied({
        hostId: context.hostId,
        ...(requiredPermission === undefined ? {} : { requiredPermission }),
      });
    }
  });

/** Creates an in-memory policy from a predicate over resolved host authority. */
export const policy = (predicate: HostAuthorizationPredicate): HostPolicy =>
  makePolicy(predicate);

/** Requires one permission from the current request's effective permission set. */
export const permission = (required: HostPermissionValue): HostPolicy =>
  makePolicy(
    (context) => HashSet.has(context.effectivePermissions, required),
    required,
  );

type NonEmptyPolicies = readonly [HostPolicy, ...ReadonlyArray<HostPolicy>];

/** Requires every policy, evaluating sequentially and stopping on first denial. */
export const all = (...policies: NonEmptyPolicies): HostPolicy =>
  Effect.all(policies, { concurrency: 1, discard: true });

/**
 * Requires at least one policy, evaluating sequentially and stopping on first
 * success. This is safe because this policy kernel has only one denial error.
 */
export const any = (...policies: NonEmptyPolicies): HostPolicy =>
  Effect.firstSuccessOf(policies);

/** Runs a policy before starting the protected Effect. */
export const withPolicy =
  (requiredPolicy: HostPolicy) =>
  <A, E, R>(operation: Effect.Effect<A, E, R>) =>
    Effect.andThen(requiredPolicy, operation);

/** Named host policies assembled only from the authored permission catalog. */
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
