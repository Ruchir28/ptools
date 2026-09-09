import { Brand, Schema } from "effect";
import { EpochMillis } from "./hostToken.js";
import { PrincipalId } from "./principal.js";

/** One-time setup secret delivered only through trusted provisioning output. */
export const ControlPlaneSetupCapability = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^ptools_setup_v1_[A-Za-z0-9_-]{43}$/)),
  Schema.brand("@ptools/ControlPlaneSetupCapability"),
);
export type ControlPlaneSetupCapability = Schema.Schema.Type<
  typeof ControlPlaneSetupCapability
>;

/** SHA-256 lookup/verification digest; plaintext never enters persistence. */
export const ControlPlaneSetupCapabilityHash = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/)),
  Schema.brand("@ptools/ControlPlaneSetupCapabilityHash"),
);
export type ControlPlaneSetupCapabilityHash = Schema.Schema.Type<
  typeof ControlPlaneSetupCapabilityHash
>;

export const ControlPlaneClaimStatus = Schema.Union([
  Schema.TaggedStruct("Unclaimed", {}),
  Schema.TaggedStruct("Claimed", {
    initialAdministratorId: PrincipalId,
    claimedAtEpochMs: EpochMillis,
  }),
]);
export type ControlPlaneClaimStatus = Schema.Schema.Type<
  typeof ControlPlaneClaimStatus
>;

/** Trusted initialization command carrying only the setup secret's digest. */
export class InitializeControlPlaneInput extends Schema.Class<
  InitializeControlPlaneInput,
  Brand.Brand<"InitializeControlPlaneInput">
>("InitializeControlPlaneInput")({
  setupCapabilityHash: ControlPlaneSetupCapabilityHash,
}) {}

/**
 * Store command used after shared code verifies and hashes a presented setup
 * capability. The store atomically compares the digest, creates the Principal,
 * grants Administrator, consumes setup authority, and marks the claim complete.
 */
export class ClaimInitialAdministratorRecordInput extends Schema.Class<
  ClaimInitialAdministratorRecordInput,
  Brand.Brand<"ClaimInitialAdministratorRecordInput">
>("ClaimInitialAdministratorRecordInput")({
  principalId: PrincipalId,
  setupCapabilityHash: ControlPlaneSetupCapabilityHash,
  claimedAtEpochMs: EpochMillis,
}) {}

/** Public application command; caller identity is supplied by admission. */
export class ClaimInitialAdministratorInput extends Schema.Class<
  ClaimInitialAdministratorInput,
  Brand.Brand<"ClaimInitialAdministratorInput">
>("ClaimInitialAdministratorInput")({
  setupCapability: ControlPlaneSetupCapability,
}) {}
