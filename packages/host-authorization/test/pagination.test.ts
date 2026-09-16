/*
 * Shared keyset-pagination contract coverage.
 *
 * Mental model: a cursor is a versioned opaque encoding of the final published
 * domain ordering key. Callers can relay it but cannot substitute a cursor from
 * another collection or request an unbounded page.
 *
 * What this proves:
 * 1. Page sizes are always bounded by the shared contract.
 * 2. Every cursor round-trips the exact ordering keys needed for an index seek.
 * 3. Cursors are operation-specific and malformed values fail decoding.
 * 4. Structurally valid cursors from unsupported protocol versions fail closed.
 *
 * Boundaries: shared schemas and codecs are real; no HTTP or database is used.
 */
import { Encoding, Exit, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  HostRoleId,
  HostRolePagination,
  HostTokenId,
  HostTokenPagination,
  Pagination,
  RegisteredHostPagination,
} from "../src/contracts/index.js";

const roleId = HostRoleId.make("550e8400-e29b-41d4-a716-446655440000");
const tokenId = HostTokenId.make("123e4567-e89b-42d3-a456-426614174000");

/**
 * Encodes deliberately unsupported payloads without using a production cursor
 * constructor, all of which correctly emit only the currently supported
 * version. This keeps the test focused on decoder forward-compatibility.
 */
const encodeRawCursor = (payload: object): string =>
  Encoding.encodeBase64Url(new TextEncoder().encode(JSON.stringify(payload)));

describe("shared keyset pagination", () => {
  it("requires a positive page size no greater than the shared maximum", () => {
    expect(Pagination.PageSize.make(1)).toBe(1);
    expect(Pagination.PageSize.make(100)).toBe(100);
    expect(() => Pagination.PageSize.make(0)).toThrow();
    expect(() => Pagination.PageSize.make(101)).toThrow();
  });

  /**
   * Proves each operation retains exactly its database-neutral seek keys:
   * registered Hosts use only their unique Host ID, roles use their role ID,
   * and tokens retain creation time plus token ID for their own ordering.
   */
  it("round-trips database-neutral ordering keys", () => {
    const host = RegisteredHostPagination.makeCursor("host-1");
    const role = HostRolePagination.makeCursor(roleId);
    const token = HostTokenPagination.makeCursor({
      createdAtEpochMs: 20,
      tokenId,
    });

    expect(RegisteredHostPagination.decodeCursor(host)).toEqual({
      version: 1,
      kind: "registered-host",
      hostId: "host-1",
    });
    expect(HostRolePagination.decodeCursor(role)).toEqual({
      version: 1,
      kind: "host-role",
      roleId,
    });
    expect(HostTokenPagination.decodeCursor(token)).toEqual({
      version: 1,
      kind: "host-token",
      createdAtEpochMs: 20,
      tokenId,
    });
  });

  it("rejects structurally valid cursors from an unsupported version", () => {
    const unsupportedHostCursor = encodeRawCursor({
      version: 2,
      kind: "registered-host",
      hostId: "host-1",
    });
    const unsupportedRoleCursor = encodeRawCursor({
      version: 2,
      kind: "host-role",
      roleId,
    });
    const unsupportedTokenCursor = encodeRawCursor({
      version: 2,
      kind: "host-token",
      createdAtEpochMs: 20,
      tokenId,
    });

    expect(
      Exit.isFailure(
        Schema.decodeUnknownExit(RegisteredHostPagination.Cursor)(
          unsupportedHostCursor,
        ),
      ),
    ).toBe(true);
    expect(
      Exit.isFailure(
        Schema.decodeUnknownExit(HostRolePagination.Cursor)(
          unsupportedRoleCursor,
        ),
      ),
    ).toBe(true);
    expect(
      Exit.isFailure(
        Schema.decodeUnknownExit(HostTokenPagination.Cursor)(
          unsupportedTokenCursor,
        ),
      ),
    ).toBe(true);
  });

  it("rejects malformed and cross-operation cursors", () => {
    const roleCursor = HostRolePagination.makeCursor(roleId);
    expect(
      Exit.isFailure(
        Schema.decodeUnknownExit(RegisteredHostPagination.Cursor)(roleCursor),
      ),
    ).toBe(true);
    expect(
      Exit.isFailure(
        Schema.decodeUnknownExit(HostTokenPagination.Cursor)("bad"),
      ),
    ).toBe(true);
    expect(
      Exit.isSuccess(
        Schema.decodeUnknownExit(HostRolePagination.Cursor)(roleCursor),
      ),
    ).toBe(true);
  });
});
