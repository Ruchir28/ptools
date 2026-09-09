import { Clock, Context, Crypto, Effect, Layer, Option } from "effect";
import {
  ClaimInitialAdministratorRecordInput,
  InitializeControlPlaneInput,
  type ClaimInitialAdministratorInput,
  type ControlPlaneClaimStatus,
  type ControlPlaneSetupCapability,
} from "../contracts/controlPlaneBootstrap.js";
import {
  ControlPlaneAccessInvariantViolation,
  ControlPlaneAccessStoreError,
  ControlPlaneBootstrapCryptoError,
} from "../contracts/controlPlaneAccessErrors.js";
import type {
  ClaimInitialAdministratorError,
  GetControlPlaneClaimStatusError,
} from "../contracts/controlPlaneAccessOperations/index.js";
import type { PrincipalControlPlaneAccess } from "../contracts/controlPlaneRole.js";
import type { PrincipalCaller } from "../contracts/hostCaller.js";
import {
  CONTROL_PLANE_SETUP_SECRET_BYTES,
  hashControlPlaneSetupCapability,
  makeControlPlaneSetupCapability,
} from "../controlPlaneSetupCapability.js";
import { ControlPlaneAccessStore } from "./controlPlaneAccessStore.js";

/**
 * Shared, storage-free bootstrap workflow for Control Plane setup authority.
 *
 * This service owns only orchestration: generating the one-time setup
 * capability, hashing it, timestamping claims, and delegating every stored-
 * state mutation to `ControlPlaneAccessStore`. It never reads or writes stored
 * state directly; the mutation laws (first valid claim wins, Administrator
 * grant, last-Administrator safety) live on that port, not here.
 *
 * The setup plaintext's lifetime ends at this boundary: `initialize` returns
 * it exactly once to the provisioning path that created the unclaimed state,
 * while persistence receives only its SHA-256 digest. Platform compositions
 * (HTTP handlers, provisioning commands) consume this service and supply
 * their platform's store Layer and `Crypto` implementation.
 */
export class ControlPlaneBootstrap extends Context.Service<ControlPlaneBootstrap>()(
  "@ptools/host-authorization/ControlPlaneBootstrap",
  {
    make: Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const store = yield* ControlPlaneAccessStore;

      /**
       * Creates the Control Plane's unclaimed state and yields the one-time
       * setup capability plaintext. Persistence receives only the digest; the
       * plaintext is returned as `Option.some` solely when this call created
       * the state. A later call gets `Option.none` — initialization is
       * idempotent and can never re-reveal a capability it did not mint.
       * Assigns no roles; the Administrator grant happens only at the initial
       * claim.
       */
      const initialize: Effect.Effect<
        Option.Option<ControlPlaneSetupCapability>,
        | ControlPlaneBootstrapCryptoError
        | ControlPlaneAccessInvariantViolation
        | ControlPlaneAccessStoreError
      > = Effect.gen(function* () {
        const bytes = yield* crypto
          .randomBytes(CONTROL_PLANE_SETUP_SECRET_BYTES)
          .pipe(
            Effect.mapError(
              (error) =>
                new ControlPlaneBootstrapCryptoError({ message: error.message }),
            ),
          );
        const capability = yield* Option.match(
          makeControlPlaneSetupCapability(bytes),
          {
            onNone: () =>
              Effect.fail(
                new ControlPlaneAccessInvariantViolation({
                  operation: "initialize",
                  message: "secure random source returned the wrong byte length",
                }),
              ),
            onSome: Effect.succeed,
          },
        );
        const setupCapabilityHash = yield* hashControlPlaneSetupCapability(
          crypto,
          capability,
          "initialize",
        );
        const created = yield* store.initialize(
          InitializeControlPlaneInput.make({ setupCapabilityHash }),
        );
        return created ? Option.some(capability) : Option.none();
      });

      /**
       * Attempts the initial Administrator claim. Hashes the presented setup
       * capability, stamps the claim time, and delegates the atomic
       * compare/claim/grant transition to `ControlPlaneAccessStore` — whether
       * the claim succeeds and grants Administrator is the store's law,
       * decided indivisibly with the write, not here. The claimant's identity
       * comes from the admission-verified `PrincipalCaller`, never from
       * caller-supplied input. Fails with `ControlPlaneClaimRejected` when the
       * capability does not match the unclaimed digest or the plane is
       * already claimed, without mutating state.
       */
      const claimInitialAdministrator = (
        input: ClaimInitialAdministratorInput,
        caller: PrincipalCaller,
      ): Effect.Effect<
        PrincipalControlPlaneAccess,
        | ClaimInitialAdministratorError
        | ControlPlaneBootstrapCryptoError
      > =>
        Effect.gen(function* () {
          const setupCapabilityHash = yield* hashControlPlaneSetupCapability(
            crypto,
            input.setupCapability,
            "claimInitialAdministrator",
          );
          const claimedAtEpochMs = yield* Clock.currentTimeMillis;
          return yield* store.claimInitialAdministrator(
            ClaimInitialAdministratorRecordInput.make({
              principalId: caller.principalId,
              setupCapabilityHash,
              claimedAtEpochMs,
            }),
          );
        });

      /**
       * Reports whether the Control Plane is unclaimed or claimed, delegating
       * directly to the store. Provisioning surfaces use it to distinguish
       * "setup pending" from "setup complete" without ever touching setup
       * authority.
       */
      const getClaimStatus = (): Effect.Effect<
        ControlPlaneClaimStatus,
        GetControlPlaneClaimStatusError
      > => store.getClaimStatus();

      return { initialize, claimInitialAdministrator, getClaimStatus } as const;
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make);
}
