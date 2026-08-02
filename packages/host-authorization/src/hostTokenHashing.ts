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
 * Produces the persistence lookup key for an already validated V1 credential.
 * Hashing includes `ptools_host_v1_`, which binds the digest to the credential
 * family/version rather than hashing only the random suffix. The supplied
 * platform `Crypto.Crypto` performs SHA-256; this helper canonicalizes the
 * digest as unpadded base64url and never logs or persists the plaintext itself.
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
