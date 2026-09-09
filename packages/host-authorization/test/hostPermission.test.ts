/*
 * Permission and principal contract coverage.
 *
 * What this proves:
 * 1. One authored permission declaration produces both the runtime schema and
 *    the typed catalog consumed by policies, with or without a namespace.
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
  ControlPlanePermission,
  ControlPlanePermissions,
  HostCaller,
  HostPermission,
  HostPermissions,
  PrincipalIds,
} from "../src/contracts/index.js";
import { definePermissions } from "../src/internal/definePermissions.js";

/** Authored catalogs pinned as literals so derived values cannot drift silently. */
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

const expectedControlPlanePermissions = [
  "control-plane:hosts:create",
  "control-plane:hosts:list",
  "control-plane:hosts:administer",
  "control-plane:access:manage",
] as const;

/**
 * One authored permission declaration must yield both the runtime schema and
 * the typed catalog; failures cover malformed parts, unknown values, and
 * catalog/schema drift.
 */
describe("host permission contract", () => {
  /**
   * Proves `definePermissions` produces a flat runtime value list and a
   * nested typed catalog from one authored declaration, in declaration
   * order.
   */
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

  /**
   * Proves every `HostPermissions` catalog entry decodes as a
   * `HostPermission` and unknown permission strings fail — the exported
   * catalog and the runtime schema cannot drift apart.
   */
  it("keeps the exported Host catalog and runtime schema in lockstep", () => {
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

  /**
   * Proves the namespaced Control Plane catalog and its schema stay in
   * lockstep and reject unknown or malformed permission strings.
   */
  it("derives the namespaced Control Plane catalog and schema together", () => {
    const catalogValues = Object.values(ControlPlanePermissions).flatMap(
      (domain) => Object.values(domain),
    );

    expect(catalogValues).toEqual(expectedControlPlanePermissions);
    for (const permission of catalogValues) {
      expect(Schema.decodeUnknownSync(ControlPlanePermission)(permission)).toBe(
        permission,
      );
    }
    expect(() =>
      Schema.decodeUnknownSync(ControlPlanePermission)(
        "control-plane:hosts:delete",
      ),
    ).toThrow();
  });

  /**
   * Proves authoring errors — duplicate actions, `:` inside domains, actions,
   * or namespaces — throw at definition time instead of producing ambiguous
   * runtime permission values.
   */
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
    expect(() =>
      definePermissions({ valid: ["read"] } as const, {
        namespace: "invalid:namespace",
      }),
    ).toThrow(/must not contain/);
  });
});

/**
 * `HostCaller` accepts only the two authenticated caller variants and rejects
 * raw credential fields — it is the neutral boundary between authentication
 * adapters and later admission.
 */
describe("host caller principal contract", () => {
  const decodeStrict = Schema.decodeUnknownSync(HostCaller, {
    onExcessProperty: "error",
  });

  /**
   * Proves the authenticated-caller union accepts exactly the two supported
   * variants and rejects unknown tags, keeping admission inputs closed.
   */
  it("accepts only Principal-caller and Host-token callers", () => {
    const principalId = PrincipalIds.fromExternalSubject("issuer", "user-1");
    expect(
      decodeStrict({
        _tag: "PrincipalCaller",
        principalId,
      }),
    ).toEqual({
      _tag: "PrincipalCaller",
      principalId,
    });

    expect(
      decodeStrict({
        _tag: "HostTokenCaller",
        tokenId: "00010203-0405-4607-8809-0a0b0c0d0e0f",
        hostId: "host-1",
      }),
    ).toEqual({
      _tag: "HostTokenCaller",
      tokenId: "00010203-0405-4607-8809-0a0b0c0d0e0f",
      hostId: "host-1",
    });

    expect(() =>
      decodeStrict({ _tag: "LegacyDeploymentTokenCaller" }),
    ).toThrow();
  });

  /**
   * Proves raw cookie/token credential fields cannot ride along into the
   * neutral caller identity at strict trusted-wire decoding boundaries.
   */
  it("rejects raw credentials at a strict trusted-wire boundary", () => {
    expect(() =>
      decodeStrict({
        _tag: "PrincipalCaller",
        principalId: PrincipalIds.fromExternalSubject("issuer", "user-1"),
        rawCookie: "private-cookie",
      }),
    ).toThrow();

    expect(() =>
      decodeStrict({
        _tag: "HostTokenCaller",
        tokenId: "00010203-0405-4607-8809-0a0b0c0d0e0f",
        hostId: "host-1",
        rawToken: "private-token",
      }),
    ).toThrow();
  });
});
