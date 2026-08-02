/*
 * Host-role application contract coverage.
 *
 * What this proves:
 * 1. Every role crossing persistence or API boundaries has one shared shape.
 * 2. roleKey is an application identity rather than a database primary key.
 * 3. Member/Admin/Owner are ordinary validated HostRole constants.
 *
 * These tests use real Effect schemas and package constants. They do not run an
 * ORM, migration, database seed, role API, or platform implementation.
 */
import { Schema } from "effect";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  BuiltInHostRoleDefinitionVersion,
  BuiltInHostRoles,
  HostPermission,
  HostPermissions,
  HostRole,
  HostRoleKey,
  HostRoleKeySelection,
} from "../src/contracts/index.js";

describe("HostRole", () => {
  it("defines a branded application role with no database ID", () => {
    const role = HostRole.make({
      roleKey: HostRoleKey.make("support"),
      name: "Support",
      permissions: [HostPermissions.host.read],
    });

    expect(role).toBeInstanceOf(HostRole);
    expect(role).toEqual({
      roleKey: "support",
      name: "Support",
      permissions: [HostPermissions.host.read],
    });
    expect(role).not.toHaveProperty("id");
    expect(role).not.toHaveProperty("roleId");
    expectTypeOf<string>().not.toMatchTypeOf<
      Schema.Schema.Type<typeof HostRoleKey>
    >();
  });

  it("rejects malformed and non-canonical role definitions", () => {
    const decode = Schema.decodeUnknownSync(HostRole, {
      onExcessProperty: "error",
    });

    expect(() =>
      decode({ roleKey: "", name: "Support", permissions: ["host:read"] }),
    ).toThrow();
    expect(() =>
      decode({ roleKey: "support", name: "", permissions: ["host:read"] }),
    ).toThrow();
    expect(() =>
      decode({ roleKey: "support", name: "Support", permissions: [] }),
    ).toThrow();
    expect(() =>
      decode({
        roleKey: "support",
        name: "Support",
        permissions: ["host:execute", "host:read"],
      }),
    ).toThrow();
    expect(() =>
      decode({
        roleKey: "support",
        name: "Support",
        permissions: ["unknown:permission"],
      }),
    ).toThrow();
    expect(() =>
      decode({
        roleKey: "support",
        name: "Support",
        permissions: ["host:read"],
        databaseId: 42,
      }),
    ).toThrow();
  });

  it("accepts arbitrary unique application role keys for membership selection", () => {
    const decode = Schema.decodeUnknownSync(HostRoleKeySelection);

    expect(decode(["member", "support"])).toEqual(["member", "support"]);
    expect(() => decode([])).toThrow();
    expect(() => decode(["member", "member"])).toThrow();
    expect(() => decode([""])).toThrow();
  });
});

describe("built-in HostRole constants", () => {
  it("publishes Member/Admin/Owner as validated roles", () => {
    expect(BuiltInHostRoleDefinitionVersion).toBe(1);
    expect(Object.keys(BuiltInHostRoles)).toEqual(["member", "admin", "owner"]);

    for (const [key, role] of Object.entries(BuiltInHostRoles)) {
      expect(role).toBeInstanceOf(HostRole);
      expect(role.roleKey).toBe(key);
      expect(
        role.permissions.every((permission) =>
          HostPermission.literals.includes(permission),
        ),
      ).toBe(true);
    }
  });

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
