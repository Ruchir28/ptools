/*
 * Shared decoded Host-admission coverage.
 *
 * What this proves:
 * 1. Principal callers resolve current authority before policy evaluation.
 * 2. Verified Host tokens use frozen grants only for their exact route Host.
 * 3. Equal grants produce equal policy decisions for both caller kinds.
 * 4. Principal-caller-only work rejects tokens before its callback starts.
 *
 * The real admission combinators, request context, and policies are used. Only
 * Principal role resolution is faked; no HTTP server, database, token plaintext,
 * Node process, or Cloudflare Worker participates.
 */
import {
  ControlPlanePermissions,
  HostPermissions,
  HostTokenCaller,
  HostTokenId,
  HostTokenPermissionSelection,
  Principal,
  PrincipalId,
  PrincipalIds,
  PrincipalCaller,
  VerifiedHostToken,
} from "@ptools/host-authorization/contracts";
import {
  Authorization,
  HostPolicies,
} from "@ptools/host-authorization/effect";
import { Effect, HashSet } from "effect";
import { describe, expect, it } from "vitest";
import {
  AuthenticatedHostCallerContext,
  HostTokenRouteMismatch,
  PrincipalCallerRequired,
  withControlPlaneAuthorization,
  withHostAuthorization,
  withPrincipalHostAuthorization,
} from "../src/services/hostAuthorizationAdmission.js";

const principalId = PrincipalIds.fromFixedLocalIdentity("principal-1");
const principalCaller = PrincipalCaller.make({ principalId });
const tokenId = HostTokenId.make("00010203-0405-4607-8809-0a0b0c0d0e0f");
const verifiedToken = VerifiedHostToken.make({
  principal: HostTokenCaller.make({ tokenId, hostId: "host-1" }),
  effectivePermissions: HostTokenPermissionSelection.make([
    HostPermissions.host.execute,
  ]),
});

const authorization = Authorization.of({
  resolveControlPlanePermissions: () =>
    Effect.succeed(HashSet.make(ControlPlanePermissions.hosts.create)),
  resolveHostPermissions: (principal: Principal, hostId: string) => {
    expect(principal.principalId).toBe(principalId);
    expect(hostId).toBe("host-1");
    return Effect.succeed(HashSet.make(HostPermissions.host.execute));
  },
});

const run = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    Authorization | AuthenticatedHostCallerContext
  >,
  caller: AuthenticatedHostCallerContext["Service"],
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provideService(Authorization, authorization),
      Effect.provideService(AuthenticatedHostCallerContext, caller),
    ),
  );

describe("Host authorization admission", () => {
  it("normalizes Principal and token authority into the same policy result", async () => {
    const operation = () =>
      withHostAuthorization(
        { hostId: "host-1", policy: HostPolicies.execute },
        () => Effect.succeed("started"),
      );

    await expect(
      run(operation(), { _tag: "Principal", caller: principalCaller }),
    ).resolves.toBe("started");
    await expect(
      run(operation(), { _tag: "HostToken", token: verifiedToken }),
    ).resolves.toBe("started");
  });

  it("rejects cross-Host token use before the callback starts", async () => {
    let started = false;
    const failure = await run(
      withHostAuthorization(
        { hostId: "other-host", policy: HostPolicies.execute },
        () => Effect.sync(() => (started = true)),
      ).pipe(Effect.flip),
      { _tag: "HostToken", token: verifiedToken },
    );

    expect(failure).toBeInstanceOf(HostTokenRouteMismatch);
    expect(started).toBe(false);
  });

  it("admits current Principal Control Plane authority and rejects tokens", async () => {
    await expect(
      run(
        withControlPlaneAuthorization(
          ControlPlanePermissions.hosts.create,
          () => Effect.succeed("created"),
        ),
        { _tag: "Principal", caller: principalCaller },
      ),
    ).resolves.toBe("created");

    await expect(
      run(
        withControlPlaneAuthorization(
          ControlPlanePermissions.hosts.create,
          () => Effect.succeed("must-not-run"),
        ).pipe(Effect.flip),
        { _tag: "HostToken", token: verifiedToken },
      ),
    ).resolves.toBeInstanceOf(PrincipalCallerRequired);
  });

  it("rejects a Host token at a Principal-caller-only lifecycle seam", async () => {
    let started = false;
    const failure = await run(
      withPrincipalHostAuthorization(
        { hostId: "host-1", policy: HostPolicies.manageTokens },
        () => Effect.sync(() => (started = true)),
      ).pipe(Effect.flip),
      { _tag: "HostToken", token: verifiedToken },
    );

    expect(failure).toBeInstanceOf(PrincipalCallerRequired);
    expect(started).toBe(false);
  });
});
