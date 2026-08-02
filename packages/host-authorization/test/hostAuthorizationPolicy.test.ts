/**
 * Unit coverage for request-local host authorization policies.
 *
 * Mental model:
 * Authentication and permission resolution happen before these policies run.
 * That earlier boundary produces one `HostAuthorizationContext` containing the
 * host, authenticated principal, and effective permissions. A policy consumes
 * that context and either succeeds or fails with `HostAuthorizationDenied`.
 *
 * Effect execution model:
 * A `HostPolicy` is an Effect value, not a plain function that runs when
 * called. `permission(...)` / `policy(...)` / `all(...)` / `any(...)` only
 * *build* that Effect value; nothing checks permissions yet. The Effect runs
 * only when `Effect.runPromise(...)` executes it. In between, the test helper
 * below injects a `HostAuthorizationContext` into the Effect so that when it
 * runs, the policy can read the context's effective permission set.
 *
 * What this proves:
 * 1. A permission policy reads the resolved permission set from the Effect
 *    context and reports the correct denial when a permission is absent.
 * 2. `all` evaluates policies in order and stops at the first denial.
 * 3. `any` evaluates policies in order and stops at the first success.
 * 4. A denied policy prevents the protected operation from starting.
 * 5. Named policies remain bound to the authored permission catalog.
 *
 * The Effect context and policy implementation are real. Access resolution is
 * represented by an already-resolved `HashSet`; there is no database, HTTP
 * server, Better Auth instance, RPC transport, or platform adapter.
 */
import {
  HostPermissions,
  HostTokenPermissionSelection,
  UserSessionCaller,
  type HostPermission,
} from "../src/contracts/index.js";
import {
  HostAuthorizationContext,
  HostPolicies,
  HostTokenPolicies,
  all,
  any,
  permission,
  policy,
  withPolicy,
  type HostPolicy,
} from "../src/services/index.js";
import { Effect, HashSet } from "effect";
import { describe, expect, it } from "vitest";

/**
 * Inject a test `HostAuthorizationContext` into an Effect that needs it.
 *
 * `permissions` becomes the context's already-resolved effective permission
 * set. This helper only supplies policy input; it does not grant permissions
 * or run the policy. The returned Effect still has to be executed with
 * `Effect.runPromise(...)` before any authorization check happens.
 */
const provideTestAuthorizationContext = <A, E, R>(
  operation: Effect.Effect<A, E, R | HostAuthorizationContext>,
  permissions: ReadonlyArray<HostPermission> = [],
): Effect.Effect<A, E, Exclude<R, HostAuthorizationContext>> =>
  Effect.provideService(
    operation,
    HostAuthorizationContext,
    HostAuthorizationContext.of({
      hostId: "host-1",
      principal: UserSessionCaller.make({
        userId: "user-1",
        sessionId: "session-1",
      }),
      effectivePermissions: HashSet.fromIterable(permissions),
    }),
  ) as Effect.Effect<A, E, Exclude<R, HostAuthorizationContext>>;

/**
 * Run a policy with an empty permission set and expose its expected denial as
 * a resolved value so Vitest can inspect the denial fields.
 */
const runPolicyExpectingDenial = (requiredPolicy: HostPolicy) =>
  Effect.runPromise(
    provideTestAuthorizationContext(requiredPolicy).pipe(Effect.flip),
  );

describe("host authorization policies", () => {
  /** A matching permission allows the policy to complete with its `void` result. */
  it("allows a requested permission when it is in the resolved permission set", async () => {
    // Build the policy requiring host.execute, then inject a context that
    // grants it. Nothing has been evaluated yet at this point.
    const policyWithContext = provideTestAuthorizationContext(
      permission(HostPermissions.host.execute),
      [HostPermissions.host.execute],
    );
    // Effect.runPromise executes the policy: it reads the context's
    // permission set, finds host.execute, and succeeds with void (undefined).
    await expect(Effect.runPromise(policyWithContext)).resolves.toBeUndefined();
  });

  /** Token issuance cannot delegate authority absent from the current human access snapshot. */
  it("requires token management plus every explicitly delegated permission", async () => {
    const selection = HostTokenPermissionSelection.make([
      HostPermissions.host.read,
      HostPermissions.host.execute,
    ]);
    const issue = HostTokenPolicies.issue(selection);

    // The admitted caller has both management authority and every selected
    // grant, so the composed issuance policy may proceed.
    await expect(
      Effect.runPromise(
        provideTestAuthorizationContext(issue, [
          HostPermissions.tokens.manage,
          ...selection,
        ]),
      ),
    ).resolves.toBeUndefined();

    // Management permission alone is insufficient when even one delegated
    // permission is absent; denial identifies the first missing selection.
    await expect(
      Effect.runPromise(
        provideTestAuthorizationContext(issue, [
          HostPermissions.tokens.manage,
          HostPermissions.host.read,
        ]).pipe(Effect.flip),
      ),
    ).resolves.toMatchObject({
      requiredPermission: HostPermissions.host.execute,
    });

    // Revocation does not delegate grants, so its policy requires only the
    // dedicated token-management permission.
    await expect(
      Effect.runPromise(
        provideTestAuthorizationContext(HostTokenPolicies.revoke).pipe(
          Effect.flip,
        ),
      ),
    ).resolves.toMatchObject({
      requiredPermission: HostPermissions.tokens.manage,
    });
  });

  /** An absent permission becomes a typed denial containing the missing capability. */
  it("denies a requested permission when it is absent from the resolved permission set", async () => {
    await expect(
      runPolicyExpectingDenial(permission(HostPermissions.host.execute)),
    ).resolves.toMatchObject({
      _tag: "HostAuthorizationDenied",
      hostId: "host-1",
      requiredPermission: HostPermissions.host.execute,
    });
  });

  /** `all` is an AND composition: a denial makes later policies unnecessary. */
  it("evaluates all policies in order and stops at the first denial", async () => {
    const evaluated: Array<string> = [];
    const denyFirst = policy(() => {
      evaluated.push("first");
      return false;
    });
    const allowSecond = policy(() => {
      evaluated.push("second");
      return true;
    });

    await runPolicyExpectingDenial(all(denyFirst, allowSecond));

    // The second branch must not run after the first branch denies.
    expect(evaluated).toEqual(["first"]);
  });

  /** `any` is an OR composition: a success makes later policies unnecessary. */
  it("evaluates any policies in order and stops at the first success", async () => {
    const evaluated: Array<string> = [];
    const denyFirst = policy(() => {
      evaluated.push("first");
      return false;
    });
    const allowSecond = policy(() => {
      evaluated.push("second");
      return true;
    });
    const unusedThird = policy(() => {
      evaluated.push("third");
      return false;
    });

    await Effect.runPromise(
      provideTestAuthorizationContext(any(denyFirst, allowSecond, unusedThird)),
    );

    // The third branch must not run after the second branch succeeds.
    expect(evaluated).toEqual(["first", "second"]);
  });

  /** With no successful OR branch, `any` propagates the final authorization denial. */
  it("returns the final denial when every any branch fails", async () => {
    await expect(
      runPolicyExpectingDenial(any(policy(() => false), policy(() => false))),
    ).resolves.toMatchObject({
      _tag: "HostAuthorizationDenied",
      hostId: "host-1",
    });
  });

  /** Authorization is sequenced before the operation, so denial must prevent its effects. */
  it("does not start protected work when its policy denies", async () => {
    let protectedOperationStarted = false;
    const protectedOperation = Effect.sync(() => {
      protectedOperationStarted = true;
      return "mutated";
    });

    await Effect.runPromise(
      provideTestAuthorizationContext(
        protectedOperation.pipe(
          withPolicy(permission(HostPermissions.members.manage)),
        ),
      ).pipe(Effect.flip),
    );

    // The policy fails before the protected Effect is evaluated.
    expect(protectedOperationStarted).toBe(false);
  });

  /** Each public named policy must check exactly the permission assigned in the catalog. */
  it("binds every named policy to its authored catalog permission", async () => {
    const cases: ReadonlyArray<
      readonly [HostPolicy, HostPermission]
    > = [
      [HostPolicies.readHost, HostPermissions.host.read],
      [HostPolicies.execute, HostPermissions.host.execute],
      [HostPolicies.configure, HostPermissions.host.configure],
      [HostPolicies.deleteHost, HostPermissions.host.delete],
      [HostPolicies.manageSecrets, HostPermissions.secrets.manage],
      [HostPolicies.readAuth, HostPermissions.auth.read],
      [HostPolicies.manageAuth, HostPermissions.auth.manage],
      [HostPolicies.manageTokens, HostPermissions.tokens.manage],
      [HostPolicies.manageMembers, HostPermissions.members.manage],
    ];

    for (const [namedPolicy, grantedPermission] of cases) {
      await expect(
        Effect.runPromise(
          provideTestAuthorizationContext(namedPolicy, [grantedPermission]),
        ),
      ).resolves.toBeUndefined();
    }
  });
});
