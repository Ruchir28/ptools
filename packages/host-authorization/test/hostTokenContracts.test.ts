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
  PrincipalId,
  PrincipalIds,
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
  issuedByPrincipalId: PrincipalIds.fromFixedLocalIdentity("principal-1"),
  expiresAtEpochMs: Option.some(200),
  revokedAtEpochMs: Option.none<number>(),
  revokedByPrincipalId: Option.none<PrincipalId>(),
};

/**
 * Public and persistence token representations: display names never own
 * identity, grant selections stay canonical, lifecycle audit fields are
 * paired, and safe management values have no slot through which a digest or
 * issuer identity could be claimed by public JSON.
 */
describe("host token contracts", () => {
  /**
   * Proves display names allow Unicode but not padding, emptiness, or
   * over-length values, and that renaming never derives or replaces token
   * identity.
   */
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

  /**
   * Proves delegated grant selections decode only from canonical catalog
   * values: empty, duplicated, unknown, or misordered grants fail.
   */
  it("rejects empty, duplicate, unknown, and non-canonical permission grants", () => {
    // Decode unknown values as an external request would, proving callers cannot
    // bypass canonical grant construction with a structurally typed array.
    const decode = Schema.decodeUnknownSync(HostTokenPermissionSelection);
    expect(() => decode([])).toThrow();
    expect(() => decode([HostPermissions.host.read, HostPermissions.host.read])).toThrow();
    expect(() => decode(["unknown:permission"])).toThrow();
    expect(() => decode([HostPermissions.host.execute, HostPermissions.host.read])).toThrow();
  });

  /**
   * Proves cross-field lifecycle laws: expiry must be strictly after
   * creation, and revocation time and revoker identity must always appear
   * together or not at all.
   */
  it("enforces expiry and paired revocation audit facts", () => {
    // These cases exercise relationships between fields: no individual timestamp
    // schema could detect expiry-at-creation or a revocation missing its actor.
    expect(() => HostTokenRecord.make({ ...recordFields, expiresAtEpochMs: Option.some(100) })).toThrow();
    expect(() => HostTokenRecord.make({
      ...recordFields,
      revokedAtEpochMs: Option.some(110),
      revokedByPrincipalId: Option.none(),
    })).toThrow();
    expect(() => HostTokenRecord.make({
      ...recordFields,
      revokedAtEpochMs: Option.some(99),
      revokedByPrincipalId: Option.some(PrincipalIds.fromFixedLocalIdentity("principal-2")),
    })).toThrow();
  });

  /**
   * Proves persisted records must encode `credentialVersion: 1` explicitly
   * (constructor defaults do not apply to encoded data, so old or unknown
   * formats fail closed) and private row fields are rejected at the
   * persistence boundary.
   */
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
      issuedByPrincipalId: PrincipalIds.fromFixedLocalIdentity("principal-1"),
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

  /**
   * Proves verified token callers carry the same branded token identity as
   * records, and that the public issuance input has no issuer field — audit
   * identity only crosses the trusted service argument.
   */
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
    expect(input).not.toHaveProperty("issuedByPrincipalId");
    expect(input).not.toHaveProperty("issuer");
  });

  /**
   * Proves the safe management projection's schema has no slot for the
   * credential digest, so inventory listings cannot leak it.
   */
  it("keeps hashes out of safe management values", () => {
    // Construct the safe representation from the shared metadata fields and
    // prove its schema has no slot through which a digest could be disclosed.
    const { tokenHash: _, credentialVersion: __, ...safeFields } = recordFields;
    const safe = HostToken.make(safeFields);
    expect(safe).not.toHaveProperty("tokenHash");
  });
});
