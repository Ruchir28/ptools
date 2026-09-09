import { Crypto, Effect, Encoding, Option, Schema } from "effect";
import {
  ControlPlaneSetupCapability,
  ControlPlaneSetupCapabilityHash,
  type ControlPlaneSetupCapability as ControlPlaneSetupCapabilityValue,
  type ControlPlaneSetupCapabilityHash as ControlPlaneSetupCapabilityHashValue,
} from "./contracts/controlPlaneBootstrap.js";
import {
  ControlPlaneAccessInvariantViolation,
  ControlPlaneBootstrapCryptoError,
} from "./contracts/controlPlaneAccessErrors.js";

const prefix = "ptools_setup_v1_";
const secretBytes = 32;
const utf8 = new TextEncoder();

/** Creates the one-time plaintext capability from exactly 256 random bits. */
export const makeControlPlaneSetupCapability = (
  bytes: Uint8Array,
): Option.Option<ControlPlaneSetupCapabilityValue> =>
  bytes.length === secretBytes
    ? Schema.decodeUnknownOption(ControlPlaneSetupCapability)(
        `${prefix}${Encoding.encodeBase64Url(bytes)}`,
      )
    : Option.none();

/** Hashes the complete versioned capability before it reaches persistence. */
export const hashControlPlaneSetupCapability = (
  crypto: Crypto.Crypto,
  capability: ControlPlaneSetupCapabilityValue,
  operation: "initialize" | "claimInitialAdministrator",
): Effect.Effect<
  ControlPlaneSetupCapabilityHashValue,
  ControlPlaneBootstrapCryptoError | ControlPlaneAccessInvariantViolation
> =>
  crypto.digest("SHA-256", utf8.encode(capability)).pipe(
    Effect.mapError(
      (error) => new ControlPlaneBootstrapCryptoError({ message: error.message }),
    ),
    Effect.flatMap((digest) =>
      Schema.decodeUnknownEffect(ControlPlaneSetupCapabilityHash)(
        Encoding.encodeBase64Url(digest),
      ).pipe(
        Effect.mapError(
          () =>
            new ControlPlaneAccessInvariantViolation({
              operation,
              message: "cryptographic digest violated the SHA-256 contract",
            }),
        ),
      ),
    ),
  );

export const CONTROL_PLANE_SETUP_SECRET_BYTES = secretBytes;
