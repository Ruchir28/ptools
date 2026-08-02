/*
 * V1 host-token credential codec coverage.
 *
 * What this proves:
 * 1. Exactly 32 secret bytes become one canonical unpadded base64url form.
 * 2. Padding, alternate alphabets, non-canonical tail bits, wrong lengths,
 *    suffixes, and unsupported versions never enter hashing or persistence.
 *
 * This test uses the real portable codec and no crypto or persistence service.
 */
import { Option } from "effect";
import { describe, expect, it } from "vitest";
import {
  HOST_TOKEN_V1_PREFIX,
  makeV1HostTokenCredential,
  parseV1HostTokenCredential,
} from "../src/hostTokenCredential.js";

describe("V1 host token credential", () => {
  it("formats and parses exactly one canonical 32-byte secret", () => {
    // A deterministic byte sequence gives the test one reviewable wire value;
    // parsing it back proves formatter and verifier agree on the sole V1 spelling.
    const credential = Option.getOrThrow(
      makeV1HostTokenCredential(Uint8Array.from({ length: 32 }, (_, i) => i)),
    );
    expect(credential).toBe(
      "ptools_host_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
    );
    expect(Option.getOrUndefined(parseV1HostTokenCredential(credential))).toBe(
      credential,
    );
  });

  it.each([
    // Wrong encoded lengths would represent fewer/more than 256 secret bits.
    `${HOST_TOKEN_V1_PREFIX}${"A".repeat(42)}`,
    `${HOST_TOKEN_V1_PREFIX}${"A".repeat(44)}`,
    // Padding and the standard Base64 alphabet create alternate wire spellings.
    `${HOST_TOKEN_V1_PREFIX}${"A".repeat(43)}=`,
    `${HOST_TOKEN_V1_PREFIX}${"A".repeat(42)}+`,
    `${HOST_TOKEN_V1_PREFIX}${"A".repeat(42)}/`,
    // `B` has non-zero unused tail bits: it can decode to the same bytes as a
    // canonical ending, so decode-and-re-encode equality must reject it.
    `${HOST_TOKEN_V1_PREFIX}${"A".repeat(42)}B`,
    // Version and suffix cases prove matching the broad host-token family is
    // insufficient; only the complete V1 grammar may proceed to authentication.
    `ptools_host_v2_${"A".repeat(43)}`,
    `ptools_host_${"A".repeat(43)}`,
    `${HOST_TOKEN_V1_PREFIX}${"A".repeat(43)}suffix`,
  ])("rejects malformed or unsupported credential %s", (credential) => {
    expect(Option.isNone(parseV1HostTokenCredential(credential))).toBe(true);
  });

  it("refuses to format any secret length other than 32 bytes", () => {
    // This is an issuer-side invariant check: a broken random source must not
    // silently produce a lower-entropy credential with otherwise valid syntax.
    expect(Option.isNone(makeV1HostTokenCredential(new Uint8Array(31)))).toBe(true);
    expect(Option.isNone(makeV1HostTokenCredential(new Uint8Array(33)))).toBe(true);
  });
});
