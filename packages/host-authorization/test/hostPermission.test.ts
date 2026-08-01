/*
 * Permission and principal contract coverage.
 *
 * What this proves:
 * 1. One authored permission declaration produces both the runtime schema and
 *    the typed catalog consumed by policies.
 * 2. Unknown permission and caller variants fail at the contract boundary.
 * 3. Strict boundary decoding rejects credential fields outside the neutral
 *    principal contract.
 *
 * These tests use real Effect Schema decoding. They use no database, HTTP
 * server, Better Auth instance, RPC transport, or platform adapter.
 */
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  HostCallerPrincipal,
  HostPermission,
  HostPermissions,
} from "../src/contracts/index.js";
import { definePermissions } from "../src/internal/definePermissions.js";

const expectedPermissions = [
  "host:read",
  "host:execute",
  "host:configure",
  "host:delete",
  "secrets:manage",
  "auth:read",
  "auth:manage",
  "tokens:manage",
  "members:manage",
] as const;

describe("host permission contract", () => {
  it("derives one matching value list and nested catalog", () => {
    const definition = definePermissions({
      document: ["read", "manage"],
      member: ["invite"],
    } as const);

    expect(definition.values).toEqual([
      "document:read",
      "document:manage",
      "member:invite",
    ]);
    expect(definition.catalog).toEqual({
      document: {
        read: "document:read",
        manage: "document:manage",
      },
      member: { invite: "member:invite" },
    });
  });

  it("keeps the exported catalog and runtime schema in lockstep", () => {
    const catalogValues = Object.values(HostPermissions).flatMap((domain) =>
      Object.values(domain),
    );

    expect(catalogValues).toEqual(expectedPermissions);
    for (const permission of catalogValues) {
      expect(Schema.decodeUnknownSync(HostPermission)(permission)).toBe(
        permission,
      );
    }
    expect(() =>
      Schema.decodeUnknownSync(HostPermission)("members:delete"),
    ).toThrow();
  });

  it("fails fast for malformed or duplicate authored permission parts", () => {
    expect(() =>
      definePermissions({ invalid: ["read", "read"] } as const),
    ).toThrow(/repeats action/);
    expect(() =>
      definePermissions({ "invalid:domain": ["read"] } as const),
    ).toThrow(/must not contain/);
    expect(() =>
      definePermissions({ valid: ["invalid:action"] } as const),
    ).toThrow(/must not contain/);
  });
});

describe("host caller principal contract", () => {
  const decodeStrict = Schema.decodeUnknownSync(HostCallerPrincipal, {
    onExcessProperty: "error",
  });

  it("accepts only human-session and host-token principals", () => {
    expect(
      decodeStrict({
        _tag: "UserSessionCaller",
        userId: "user-1",
        sessionId: "session-1",
      }),
    ).toEqual({
      _tag: "UserSessionCaller",
      userId: "user-1",
      sessionId: "session-1",
    });

    expect(
      decodeStrict({
        _tag: "HostTokenCaller",
        tokenId: "token-1",
        hostId: "host-1",
      }),
    ).toEqual({
      _tag: "HostTokenCaller",
      tokenId: "token-1",
      hostId: "host-1",
    });

    expect(() => decodeStrict({ _tag: "LegacyDeploymentTokenCaller" })).toThrow();
  });

  it("rejects raw credentials at a strict trusted-wire boundary", () => {
    expect(() =>
      decodeStrict({
        _tag: "UserSessionCaller",
        userId: "user-1",
        sessionId: "session-1",
        rawCookie: "private-cookie",
      }),
    ).toThrow();

    expect(() =>
      decodeStrict({
        _tag: "HostTokenCaller",
        tokenId: "token-1",
        hostId: "host-1",
        rawToken: "private-token",
      }),
    ).toThrow();
  });
});
