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

/**
 * The V1 credential grammar is the sole spelling that may reach hashing:
 * canonical unpadded base64url over exactly 256 secret bits. Padding,
 * alternate alphabets, non-canonical tail bits, wrong lengths, unsupported
 * versions, and suffixes must all fail closed before authentication.
 */
describe("V1 host token credential", () => {
  /**
   * Proves 32 secret bytes produce exactly one canonical wire spelling and
   * that parsing accepts only that spelling — formatter and verifier agree
   * on the sole V1 form.
   */
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

  /**
   * Proves every non-canonical spelling — wrong length, padding, alternate
   * alphabet, non-canonical tail bits, unsupported or missing version,
   * suffixes — is rejected before hashing, so it can never reach
   * authentication or persistence.
   */
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

  /**
   * Proves the issuer-side invariant: a broken random source cannot silently
   * produce a lower-entropy credential that still passes syntax checks.
   */
  it("refuses to format any secret length other than 32 bytes", () => {
    // This is an issuer-side invariant check: a broken random source must not
    // silently produce a lower-entropy credential with otherwise valid syntax.
    expect(Option.isNone(makeV1HostTokenCredential(new Uint8Array(31)))).toBe(true);
    expect(Option.isNone(makeV1HostTokenCredential(new Uint8Array(33)))).toBe(true);
  });
});
