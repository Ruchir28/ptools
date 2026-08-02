import { Encoding, Option, Schema } from "effect";
import {
  HostTokenPlaintext,
  type HostTokenPlaintext as HostTokenPlaintextValue,
} from "./contracts/hostToken.js";

/**
 * V1 host bearer-token credential shape.
 *
 * Roles:
 * - secret: 32 CSPRNG bytes (entropy only). Never shown to the user, never stored.
 * - prefix: self-describing type + format version on the wire (`ptools_host_v1_`).
 * - plaintext (HostTokenPlaintext): prefix + base64url(secret). The full bearer
 *   string issued once to the user/client. Not a hash. Never persisted.
 * - hash (HostTokenHash, elsewhere): SHA-256 of the plaintext. What persistence
 *   stores and verify looks up. Safe metadata (tokenId, permissions, expiry, …)
 *   lives beside the hash; the plaintext does not.
 *
 * User-held: plaintext only (copy/paste / Authorization).
 * Stored: hash + safe token record fields. Never secret bytes or plaintext.
 */
export const HOST_TOKEN_V1_PREFIX = "ptools_host_v1_";

/** Entropy size for the V1 secret; plaintext encodes exactly this many bytes. */
export const HOST_TOKEN_SECRET_BYTES = 32;

/**
 * Issue path: secret bytes → canonical plaintext credential.
 * Rejects wrong-length secrets (issuer invariant). Does not hash; hashing is a
 * separate step before persistence.
 */
export const makeV1HostTokenCredential = (
  secret: Uint8Array,
): Option.Option<HostTokenPlaintextValue> => {
  if (secret.length !== HOST_TOKEN_SECRET_BYTES) return Option.none();
  return Schema.decodeUnknownOption(HostTokenPlaintext)(
    `${HOST_TOKEN_V1_PREFIX}${Encoding.encodeBase64Url(secret)}`,
  );
};

/**
 * Verify path: untrusted string → branded plaintext if V1 syntax is exact.
 * Same HostTokenPlaintext schema as make (prefix + canonical 32-byte base64url).
 * On success, caller hashes and looks up the stored digest; does not recover secret bytes.
 */
export const parseV1HostTokenCredential = (
  plaintext: string,
): Option.Option<HostTokenPlaintextValue> =>
  Schema.decodeUnknownOption(HostTokenPlaintext)(plaintext);
