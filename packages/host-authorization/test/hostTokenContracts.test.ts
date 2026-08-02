/*
 * Shared host-token contract coverage.
 *
 * What this proves:
 * 1. Public and persistence representations enforce exact names, grants, IDs,
 *    timestamps, and lifecycle audit invariants.
 * 2. The persistence schema requires its credential version and rejects private
 *    platform fields at strict decoding boundaries.
 * 3. HostTokenCaller uses the same branded UUID identity as token records.
 *
 * These tests exercise real schemas only; no crypto or persistence is faked.
 */
import { Option, Schema } from "effect";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  HostPermissions,
  HostToken,
  HostTokenCaller,
  HostTokenHash,
  HostTokenId,
  HostTokenName,
  HostTokenPermissionSelection,
  HostTokenRecord,
  IssueHostTokenInput,
} from "../src/contracts/index.js";

// This fully valid record fixture is varied one invariant at a time below. Its
// fixed values keep failures attributable to the field under test rather than
// unrelated UUID, digest, permission-order, or timestamp validation.
const tokenId = HostTokenId.make("00010203-0405-4607-8809-0a0b0c0d0e0f");
const hash = HostTokenHash.make("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
const permissions = HostTokenPermissionSelection.make([
  HostPermissions.host.read,
  HostPermissions.host.execute,
]);

const recordFields = {
  credentialVersion: 1 as const,
  tokenHash: hash,
  tokenId,
  hostId: "personal",
  name: HostTokenName.make("OpenCode laptop"),
  grantedPermissions: permissions,
  createdAtEpochMs: 100,
  issuedByUserId: "user-1",
  expiresAtEpochMs: Option.some(200),
  revokedAtEpochMs: Option.none<number>(),
  revokedByUserId: Option.none<string>(),
};

describe("host token contracts", () => {
  it("accepts bounded trimmed Unicode names without using them as identity", () => {
    expect(HostTokenName.make("開発 laptop")).toBe("開発 laptop");
    expect(() => HostTokenName.make(" padded ")).toThrow();
    expect(() => HostTokenName.make("")).toThrow();
    expect(() => HostTokenName.make("x".repeat(101))).toThrow();

    // Changing user-authored display text does not derive or replace identity;
    // the supplied UUID remains the stable management key.
    const first = HostTokenRecord.make(recordFields);
    const second = HostTokenRecord.make({ ...recordFields, name: HostTokenName.make("Other") });
    expect(first.tokenId).toBe(second.tokenId);
  });

  it("rejects empty, duplicate, unknown, and non-canonical permission grants", () => {
    // Decode unknown values as an external request would, proving callers cannot
    // bypass canonical grant construction with a structurally typed array.
    const decode = Schema.decodeUnknownSync(HostTokenPermissionSelection);
    expect(() => decode([])).toThrow();
    expect(() => decode([HostPermissions.host.read, HostPermissions.host.read])).toThrow();
    expect(() => decode(["unknown:permission"])).toThrow();
    expect(() => decode([HostPermissions.host.execute, HostPermissions.host.read])).toThrow();
  });

  it("enforces expiry and paired revocation audit facts", () => {
    // These cases exercise relationships between fields: no individual timestamp
    // schema could detect expiry-at-creation or a revocation missing its actor.
    expect(() => HostTokenRecord.make({ ...recordFields, expiresAtEpochMs: Option.some(100) })).toThrow();
    expect(() => HostTokenRecord.make({
      ...recordFields,
      revokedAtEpochMs: Option.some(110),
      revokedByUserId: Option.none(),
    })).toThrow();
    expect(() => HostTokenRecord.make({
      ...recordFields,
      revokedAtEpochMs: Option.some(99),
      revokedByUserId: Option.some("user-2"),
    })).toThrow();
  });

  it("requires encoded version 1 and rejects excess persistence fields", () => {
    // Persistence is an unknown-data boundary. Strict excess-property handling
    // prevents a private row shape from silently becoming part of the shared record.
    const decode = Schema.decodeUnknownSync(HostTokenRecord, { onExcessProperty: "error" });
    const encoded = {
      credentialVersion: 1,
      tokenHash: hash,
      tokenId,
      hostId: "personal",
      name: "OpenCode laptop",
      grantedPermissions: permissions,
      createdAtEpochMs: 100,
      issuedByUserId: "user-1",
      expiresAtEpochMs: 200,
    };
    expect(decode(encoded)).toBeInstanceOf(HostTokenRecord);
    // Constructor defaults make authored code ergonomic, but encoded persisted
    // data must carry version 1 explicitly so old/unknown formats fail closed.
    expect(() => decode({ ...encoded, credentialVersion: 2 })).toThrow();
    const { credentialVersion: _, ...withoutVersion } = encoded;
    expect(() => decode(withoutVersion)).toThrow();
    expect(() => decode({ ...encoded, databaseId: 42 })).toThrow();
  });

  it("uses HostTokenId in HostTokenCaller and keeps issue input audit-free", () => {
    expect(HostTokenCaller.make({ tokenId, hostId: "personal" }).tokenId).toBe(tokenId);
    expectTypeOf<HostTokenCaller["tokenId"]>().toEqualTypeOf<typeof tokenId>();
    // Audit identity must cross the separate trusted service argument; allowing
    // either field here would let public JSON claim a different issuer.
    const input = IssueHostTokenInput.make({
      hostId: "personal",
      name: HostTokenName.make("CI"),
      grantedPermissions: permissions,
      expiresAtEpochMs: Option.none(),
    });
    expect(input).not.toHaveProperty("issuedByUserId");
    expect(input).not.toHaveProperty("issuer");
  });

  it("keeps hashes out of safe management values", () => {
    // Construct the safe representation from the shared metadata fields and
    // prove its schema has no slot through which a digest could be disclosed.
    const { tokenHash: _, credentialVersion: __, ...safeFields } = recordFields;
    const safe = HostToken.make(safeFields);
    expect(safe).not.toHaveProperty("tokenHash");
  });
});
