import { Crypto, Effect, Encoding, Schema } from "effect";
import {
  HostTokenHash,
  type HostTokenHash as HostTokenHashValue,
  type HostTokenPlaintext,
} from "./contracts/hostToken.js";
import {
  HostTokenCryptoError,
  HostTokenInvariantViolation,
  type HostTokenOperation,
} from "./contracts/hostTokenErrors.js";

const utf8 = new TextEncoder();

/**
 * Constant-time equality for two canonical `HostTokenHash` digests.
 *
 * Why constant-time: a plain string comparison stops at the first differing
 * byte, which is exploitable only when one operand is a fixed secret and the
 * other is an attacker-varied guess observable across many attempts — the
 * setup at the bearer-token, OAuth-state, and RPC-key comparisons in
 * host-cloudflare, auth, and host-node. `verify` does not have that setup
 * today: the store keys records by the digest itself, so the only comparison
 * a caller can reach is against their own input, and a leaked digest is
 * useless without the plaintext (unkeyed SHA-256 over 32 random bytes — see
 * `hashHostTokenCredential`). This helper keeps that safety property
 * structural instead of reasoning-dependent, so a future refactor — such as
 * looking records up by token ID and then comparing digests — cannot silently
 * turn this seam into a real timing oracle.
 *
 * Both values are schema-validated fixed-length base64url, so byte equality on
 * the strings is exactly digest equality; the XOR-accumulate loop never
 * short-circuits on unequal inputs.
 */
export const timingSafeDigestEquals = (
  left: HostTokenHashValue,
  right: HostTokenHashValue,
): boolean => {
  const leftBytes = utf8.encode(left);
  const rightBytes = utf8.encode(right);
  const maxLength = Math.max(leftBytes.byteLength, rightBytes.byteLength);
  // Length mismatch contributes to the same accumulated difference so the
  // comparison never short-circuits on unequal inputs.
  let difference = leftBytes.byteLength ^ rightBytes.byteLength;
  for (let index = 0; index < maxLength; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
};

/**
 * Produces the persistence lookup key for an already validated V1 credential.
 * Hashing includes `ptools_host_v1_`, which binds the digest to the credential
 * family/version rather than hashing only the random suffix. The supplied
 * platform `Crypto.Crypto` performs SHA-256; this helper canonicalizes the
 * digest as unpadded base64url and never logs or persists the plaintext itself.
 *
 * The SHA-256 here is intentionally unkeyed: no server-held secret enters the
 * digest. The secret is the credential's own random bytes, carried inside the
 * plaintext handed to the host exactly once at issuance, so the server can
 * persist and index only the digest. Possessing a digest therefore reveals
 * nothing usable — forging a credential still requires a SHA-256 preimage over
 * 32 random bytes.
 *
 * Platform crypto failures remain `HostTokenCryptoError`. A digest with an
 * impossible non-SHA-256 length is treated as a shared-contract invariant break.
 */
export const hashHostTokenCredential = (
  crypto: Crypto.Crypto,
  plaintext: HostTokenPlaintext,
  operation: HostTokenOperation,
): Effect.Effect<
  HostTokenHashValue,
  HostTokenInvariantViolation | HostTokenCryptoError
> =>
  Effect.gen(function* () {
    const digest = yield* crypto.digest("SHA-256", utf8.encode(plaintext)).pipe(
      Effect.mapError(
        (error) =>
          new HostTokenCryptoError({ operation, message: error.message }),
      ),
    );
    return yield* Schema.decodeUnknownEffect(HostTokenHash)(
      Encoding.encodeBase64Url(digest),
    ).pipe(
      Effect.mapError(
        () =>
          new HostTokenInvariantViolation({
            operation,
            message: "cryptographic digest violated the SHA-256 contract",
          }),
      ),
    );
  });
