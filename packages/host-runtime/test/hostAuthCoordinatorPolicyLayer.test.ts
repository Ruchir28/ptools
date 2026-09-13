/*
 * Human-facing auth status URLs are navigation links, not OAuth mutations.
 *
 * What this proves:
 * 1. Every per-server status URL opens the one Auth Center GET page.
 * 2. Provider and intent survive path/query encoding without changing shape.
 * 3. OAuth callbacks keep their separate provider-bound route.
 *
 * The real host-runtime policy Layer is used. Only its stable Host identity and
 * request-bound public origin capabilities are supplied directly.
 */
import { AuthCoordinatorPolicy } from "@ptools/auth";
import { HostIdentityLayer, HostPublicOriginLayer } from "@ptools/host-context";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { HostAuthCoordinatorPolicyLayer } from "../src/layers/hostAuthCoordinatorPolicyLayer.js";

const policyLayer = HostAuthCoordinatorPolicyLayer.pipe(
  Layer.provide(
    Layer.mergeAll(
      HostIdentityLayer("team host/primary"),
      HostPublicOriginLayer("https://ptools.example"),
    ),
  ),
);

const getPolicy = Effect.runPromise(
  AuthCoordinatorPolicy.pipe(Effect.provide(policyLayer)),
);

describe("HostAuthCoordinatorPolicyLayer human navigation URLs", () => {
  it("maps every status intent to the Auth Center GET page", async () => {
    const policy = await getPolicy;

    expect(policy.authUrl).toBe(
      "https://ptools.example/hosts/team%20host%2Fprimary/auth",
    );
    expect(policy.authorizeUrl("github enterprise/?team=one")).toBe(
      "https://ptools.example/hosts/team%20host%2Fprimary/auth?server=github%20enterprise%2F%3Fteam%3Done&intent=authorize",
    );
    expect(policy.reauthorizeUrl("github enterprise/?team=one")).toBe(
      "https://ptools.example/hosts/team%20host%2Fprimary/auth?server=github%20enterprise%2F%3Fteam%3Done&intent=reauthorize",
    );
    expect(policy.setupUrl("github enterprise/?team=one")).toBe(
      "https://ptools.example/hosts/team%20host%2Fprimary/auth?server=github%20enterprise%2F%3Fteam%3Done&intent=setup",
    );
  });

  it("keeps OAuth callback routing provider-bound and separately encoded", async () => {
    const policy = await getPolicy;

    expect(policy.callbackUrl("github enterprise/?team=one")).toBe(
      "https://ptools.example/hosts/team%20host%2Fprimary/oauth/callback/github%20enterprise%2F%3Fteam%3Done",
    );
  });

  it("never emits removed setup, server GET mutation, or force query shapes", async () => {
    const policy = await getPolicy;
    const urls = [
      policy.authorizeUrl("github"),
      policy.reauthorizeUrl("github"),
      policy.setupUrl("github"),
    ];

    for (const url of urls) {
      const parsed = new URL(url);
      expect(parsed.pathname).toBe("/hosts/team%20host%2Fprimary/auth");
      expect(parsed.searchParams.has("server")).toBe(true);
      expect(parsed.searchParams.has("intent")).toBe(true);
      expect(parsed.searchParams.has("force")).toBe(false);
      expect(parsed.pathname.endsWith("/setup")).toBe(false);
    }
  });
});
