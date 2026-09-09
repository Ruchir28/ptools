/*
 * Role identity and built-in catalog contract coverage.
 *
 * What this proves:
 * 1. Shared role IDs are validated UUID strings with separate domain brands.
 * 2. Built-ins are complete roles with stable, pinned UUIDv5 identities.
 * 3. Canonical UUIDv5 inputs—not renameable display names—own built-in identity.
 * 4. Catalog versions remain separate from UUID identity and storage layout.
 *
 * These tests use real Effect schemas and package catalogs. They do not run a
 * platform database; adapters remain free to store UUIDs as text, native UUIDs,
 * or 16-byte values and to keep private surrogate row keys.
 */
import { Schema } from "effect";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  BuiltInControlPlaneRoleDefinitionVersion,
  BuiltInControlPlaneRoles,
  BuiltInHostRoleDefinitionVersion,
  BuiltInHostRoles,
  ControlPlaneRole,
  HostPermission,
  HostPermissions,
  HostRole,
  HostRoleId,
  HostRoleIdSelection,
} from "../src/contracts/index.js";

/** Pinned UUIDv5 schema used to prove built-in identity derivation inputs. */
const UuidV5 = Schema.String.pipe(Schema.check(Schema.isUUID(5)));

/**
 * Role identity is a validated shared UUID, independent of platform row keys;
 * definitions reject malformed names, empty/unordered permissions, and excess
 * persistence fields.
 */
describe("HostRole", () => {
  /**
   * Proves role identity is a validated shared UUID, that a plain UUID string
   * type is not interchangeable with the branded `HostRoleId`, and that roles
   * are ordinary schema-backed values.
   */
  it("uses a branded UUID string independent of platform row identity", () => {
    const role = HostRole.make({
      roleId: HostRoleId.make("550e8400-e29b-41d4-a716-446655440000"),
      name: "Support",
      permissions: [HostPermissions.host.read],
    });

    expect(role).toBeInstanceOf(HostRole);
    expect(role).toEqual({
      roleId: "550e8400-e29b-41d4-a716-446655440000",
      name: "Support",
      permissions: [HostPermissions.host.read],
    });
    expectTypeOf<string>().not.toMatchTypeOf<
      Schema.Schema.Type<typeof HostRoleId>
    >();
  });

  /**
   * Proves role decoding rejects non-UUID and non-canonical-cased IDs, empty
   * names, empty/out-of-order/unknown permissions, and excess persistence
   * fields such as surrogate row keys.
   */
  it("rejects malformed and non-canonical role definitions", () => {
    const decode = Schema.decodeUnknownSync(HostRole, {
      onExcessProperty: "error",
    });
    const roleId = "550e8400-e29b-41d4-a716-446655440000";

    expect(() =>
      decode({
        roleId: "not-a-uuid",
        name: "Support",
        permissions: ["host:read"],
      }),
    ).toThrow();
    expect(() =>
      decode({
        roleId: "550E8400-E29B-41D4-A716-446655440000",
        name: "Support",
        permissions: ["host:read"],
      }),
    ).toThrow();
    expect(() =>
      decode({ roleId, name: "", permissions: ["host:read"] }),
    ).toThrow();
    expect(() =>
      decode({ roleId, name: "Support", permissions: [] }),
    ).toThrow();
    expect(() =>
      decode({
        roleId,
        name: "Support",
        permissions: ["host:execute", "host:read"],
      }),
    ).toThrow();
    expect(() =>
      decode({
        roleId,
        name: "Support",
        permissions: ["unknown:permission"],
      }),
    ).toThrow();
    expect(() =>
      decode({
        roleId,
        roleKey: "support",
        name: "Support",
        permissions: ["host:read"],
      }),
    ).toThrow();
  });

  /**
   * Proves membership role selections must be non-empty, unique UUIDs —
   * duplicate or malformed selections fail before reaching a store.
   */
  it("accepts unique UUIDs for membership selection", () => {
    const decode = Schema.decodeUnknownSync(HostRoleIdSelection);
    const first = "550e8400-e29b-41d4-a716-446655440000";
    const second = "123e4567-e89b-42d3-a456-426614174000";

    expect(decode([first, second])).toEqual([first, second]);
    expect(() => decode([])).toThrow();
    expect(() => decode([first, first])).toThrow();
    expect(() => decode(["not-a-uuid"])).toThrow();
  });
});

/**
 * Built-in roles carry stable UUIDv5 identities derived from canonical names
 * (not renameable display names) and strict member < admin < owner permission
 * supersets; catalog versions stay separate from UUID identity.
 */
describe("built-in role catalogs", () => {
  /**
   * Proves the built-in Member/Admin/Owner roles exist with pinned UUIDv5
   * IDs (identity survives renames), valid UUIDv5 form, and catalog-only
   * permissions.
   */
  it("publishes complete Host roles with pinned UUIDv5 identities", () => {
    expect(BuiltInHostRoleDefinitionVersion).toBe(1);
    expect(BuiltInHostRoles).toEqual({
      member: expect.objectContaining({
        roleId: "00783f01-f618-5b00-a7d3-7f9d2a152787",
        name: "Member",
      }),
      admin: expect.objectContaining({
        roleId: "1649218d-d254-529d-8e1f-11a6f0ece054",
        name: "Admin",
      }),
      owner: expect.objectContaining({
        roleId: "d56a3190-6708-5e0d-97f9-ff89f6256d5e",
        name: "Owner",
      }),
    });

    for (const role of Object.values(BuiltInHostRoles)) {
      expect(role).toBeInstanceOf(HostRole);
      expect(Schema.decodeUnknownSync(UuidV5)(role.roleId)).toBe(role.roleId);
      expect(
        role.permissions.every((permission) =>
          HostPermission.literals.includes(permission),
        ),
      ).toBe(true);
    }
  });

  /**
   * Proves the built-in Control Plane Administrator role keeps its pinned
   * UUIDv5 identity across definition version 1.
   */
  it("publishes Administrator with its pinned UUIDv5 identity", () => {
    expect(BuiltInControlPlaneRoleDefinitionVersion).toBe(1);
    expect(BuiltInControlPlaneRoles.administrator).toBeInstanceOf(
      ControlPlaneRole,
    );
    expect(BuiltInControlPlaneRoles.administrator).toEqual(
      expect.objectContaining({
        roleId: "407c725c-2426-587a-8752-22dbb2330e43",
        name: "Administrator",
      }),
    );
    expect(
      Schema.decodeUnknownSync(UuidV5)(
        BuiltInControlPlaneRoles.administrator.roleId,
      ),
    ).toBe(BuiltInControlPlaneRoles.administrator.roleId);
  });

  /**
   * Proves the built-in hierarchy is strictly cumulative — every Member
   * permission is in Admin and every Admin permission in Owner, with
   * strictly growing counts — so inheritance reasoning stays sound.
   */
  it("keeps Member, Admin, and Owner as strict permission supersets", () => {
    expect(BuiltInHostRoles.member.permissions).toContain(
      HostPermissions.host.execute,
    );
    for (const permission of BuiltInHostRoles.member.permissions) {
      expect(BuiltInHostRoles.admin.permissions).toContain(permission);
    }
    for (const permission of BuiltInHostRoles.admin.permissions) {
      expect(BuiltInHostRoles.owner.permissions).toContain(permission);
    }
    expect(BuiltInHostRoles.admin.permissions.length).toBeGreaterThan(
      BuiltInHostRoles.member.permissions.length,
    );
    expect(BuiltInHostRoles.owner.permissions.length).toBeGreaterThan(
      BuiltInHostRoles.admin.permissions.length,
    );
  });
});
